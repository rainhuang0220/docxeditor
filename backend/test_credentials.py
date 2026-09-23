"""Credential store, legacy migration, request scope, CORS, and CSP."""

import asyncio
import json
import os
import stat
import tempfile
import warnings
from pathlib import Path

os.environ["DOCXEDITOR_KEYRING"] = "disabled"
_ISOLATED_HOME = tempfile.mkdtemp(prefix="docxeditor-cred-")
os.environ["DOCXEDITOR_CONFIG_PATH"] = str(Path(_ISOLATED_HOME) / "config.json")

from fastapi.testclient import TestClient
from keyring.errors import KeyringLocked, PasswordDeleteError

from . import ai_service as ai
from .credentials import (
    CredentialStillPresent,
    CredentialStore,
    CredentialStoreError,
    CredentialUnverifiable,
    MappingEnv,
    MemorySecretStore,
    _trusted_keyring_backend,
    detect_keyring,
    mask_secret,
    open_credential_store,
)
from .provider_runtime import InvalidBaseUrl, ResolvedProvider, validate_base_url


def ai_spec(provider: str, api_key: str, model: str, base_url: str) -> ResolvedProvider:
    return ResolvedProvider(provider, api_key, model, base_url, "profile")
from .legacy_config import migrate_legacy_config, restrict_config_permissions
from .main import ALLOWED_ORIGINS, app
from .provider_runtime import ResolvedProvider, redact

SENTINEL = "DOCXEDITOR_SECRET_SENTINEL_9f2c"
ROOT = Path(__file__).resolve().parents[1]


class Boom(Exception):
    pass


def _store(env=None, durable=None, keyring=False):
    return CredentialStore(
        durable,
        MemorySecretStore(),
        MappingEnv(env or {}),
        keyring and durable is not None,
    )


def _use(store: CredentialStore):
    app.state.credentials = store
    app.state.client_factory = None
    app.state.credential_tester = None


def test_mask_and_profile_isolation():
    assert mask_secret(None) == ""
    assert mask_secret("abcd") == "••••"
    assert mask_secret("abc") == "••••"
    assert mask_secret(SENTINEL) == "••••9f2c"
    assert "DOCXEDI" not in mask_secret(SENTINEL)
    durable = MemorySecretStore()
    store = _store(durable=durable, keyring=True)
    status = store.put("profile-a", "openai", SENTINEL)
    assert status.mode == "keyring" and status.persistent is True
    assert status.hint == "••••9f2c"
    assert SENTINEL not in json.dumps(status.public_dict())
    store.put("profile-b", "openai", "other-key-zzzz")
    assert store.resolve("profile-a", "openai").secret == SENTINEL
    assert store.resolve("profile-a", "anthropic") is None
    assert store.resolve("profile-b", "openai").secret == "other-key-zzzz"
    assert store.resolve("profile-a", "openai").secret != store.resolve("profile-b", "openai").secret
    gone = store.delete_profile("profile-a", "openai")
    assert gone.has_key is False
    assert store.resolve("profile-a", "openai") is None
    assert store.resolve("profile-b", "openai").secret == "other-key-zzzz"
    print("PASS: profile store, mask, delete")


def test_memory_fallback_and_precedence():
    env = {"OPENAI_API_KEY": "env-key-openai-zzzz", "ANTHROPIC_API_KEY": "env-key-anthropic-yyyy"}
    memory_only = _store(env=env, keyring=False)
    saved = memory_only.put("profile-a", "openai", SENTINEL)
    assert saved.mode == "memory" and saved.persistent is False
    assert memory_only.status("profile-a", "openai").mode == "memory"
    assert memory_only.resolve("profile-a", "openai").secret == SENTINEL
    assert memory_only.resolve("missing", "openai").secret == "env-key-openai-zzzz"
    assert memory_only.resolve("missing", "openai").mode == "environment"
    assert memory_only.status("missing", "anthropic").mode == "environment"
    assert memory_only.resolve("missing", "anthropic").secret == "env-key-anthropic-yyyy"
    before = dict(env)
    removed = memory_only.delete_profile("profile-a", "openai")
    assert removed.mode == "environment" and removed.source == "environment"
    assert removed.hint == "••••zzzz"
    assert "env-key-openai-zzzz" not in json.dumps(removed.public_dict())
    assert env == before
    assert memory_only.resolve("profile-a", "openai").secret == "env-key-openai-zzzz"

    durable = MemorySecretStore()
    both = _store(env=env, durable=durable, keyring=True)
    both.remember_legacy("openai", "legacy-openai-key-1234")
    assert both.resolve("nobody", "openai").secret == "legacy-openai-key-1234"
    both.put("somebody", "openai", "profile-key-abcd")
    assert both.resolve("somebody", "openai").secret == "profile-key-abcd"
    assert both.resolve("somebody", "openai").source == "profile"
    assert both.resolve("ghost", "nope") is None
    try:
        both.status("ghost", "nope")
        raise AssertionError("invalid provider should fail")
    except Exception as exc:
        assert type(exc).__name__ == "InvalidProfileId"
    print("PASS: memory fallback, env precedence, delete leaves env")


def test_keyring_write_failure_does_not_claim_success():
    class Flaky:
        def __init__(self):
            self.data = {}

        def get(self, account):
            return self.data.get(account)

        def set(self, account, secret):
            raise OSError("keyring down")

        def delete(self, account):
            self.data.pop(account, None)

    store = _store(durable=Flaky(), keyring=True)
    status = store.put("profile-a", "openai", SENTINEL)
    assert status.mode == "memory" and status.persistent is False
    assert "api_key" not in json.dumps(status.public_dict())

    class KeepsOld:
        def __init__(self):
            self.data = {"profile:profile-a:openai": "old-key-value"}

        def get(self, account):
            return self.data.get(account)

        def set(self, account, secret):
            raise OSError("nope")

        def delete(self, account):
            raise OSError("nope")

    stuck = _store(durable=KeepsOld(), keyring=True)
    try:
        stuck.put("profile-a", "openai", SENTINEL)
        raise AssertionError("must not report success over a different durable key")
    except CredentialStoreError:
        pass
    assert stuck.resolve("profile-a", "openai").secret == "old-key-value"
    print("PASS: keyring failure is session-only or rejected")


def test_detect_keyring_without_writing():
    class Dead:
        priority = 0
        __module__ = "keyring.backends.fail"

    class DeadMod:
        def get_keyring(self):
            return Dead()

        def get_password(self, *_args):
            raise RuntimeError("unavailable")

    assert detect_keyring(DeadMod()) == (False, None)

    class Live:
        priority = 5
        __module__ = "keyring.backends.macOS"

    calls = []

    class LiveMod:
        def get_keyring(self):
            return Live()

        def get_password(self, service, account):
            calls.append(("get", service, account))
            return None

        def set_password(self, *_args):
            raise AssertionError("capability detection must not write")

    available, backend = detect_keyring(LiveMod())
    assert available is True and backend is not None
    assert calls and calls[0][0] == "get"
    print("PASS: keyring capability probe is read-only")


def test_legacy_config_migration(tmp: Path):
    durable = MemorySecretStore()
    store = _store(durable=durable, keyring=True)
    path = tmp / "config.json"
    path.write_text(json.dumps({
        "provider": "openai",
        "api_key": SENTINEL,
        "model": "gpt-4o",
        "base_url": "https://example.invalid/v1",
        "extra": "keep",
    }))
    result = migrate_legacy_config(path, store)
    assert result.status == "migrated", result
    written = json.loads(path.read_text())
    assert "api_key" not in written
    assert SENTINEL not in path.read_text()
    assert written["model"] == "gpt-4o"
    assert written["extra"] == "keep"
    assert store.resolve("any", "openai").secret == SENTINEL
    assert store.resolve("any", "openai").source == "legacy"
    again = migrate_legacy_config(path, store)
    assert again.status == "not_needed"
    assert SENTINEL not in path.read_text()

    missing_provider = tmp / "no-provider.json"
    missing_provider.write_text(json.dumps({"api_key": "legacy-without-provider-key"}))
    other = _store(durable=MemorySecretStore(), keyring=True)
    outcome = migrate_legacy_config(missing_provider, other)
    assert outcome.legacy_id == "legacy-provider:openai"
    assert outcome.status == "migrated"
    assert "provider" not in json.loads(missing_provider.read_text())
    print("PASS: legacy config migrates only after verify")


def test_legacy_migration_preserves_only_copy(tmp: Path):
    class Mismatch:
        def __init__(self):
            self.data = {}

        def get(self, account):
            return None

        def set(self, account, secret):
            self.data[account] = "wrong"

        def delete(self, account):
            self.data.pop(account, None)

    path = tmp / "config.json"
    original = json.dumps({"provider": "anthropic", "api_key": SENTINEL, "model": "claude"})
    path.write_text(original)
    store = _store(durable=Mismatch(), keyring=True)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        result = migrate_legacy_config(path, store)
    assert result.status == "retained"
    assert result.status != "migrated"
    assert path.read_text() == original
    assert "session" in (result.warning or "")
    assert SENTINEL not in " ".join(str(item.message) for item in caught)
    assert store.durable.data == {}
    remembered = store.resolve("any", "anthropic")
    assert remembered is not None
    assert remembered.secret == SENTINEL
    assert remembered.mode == "memory"
    assert remembered.source == "legacy"

    unavailable = _store(keyring=False)
    kept = tmp / "kept.json"
    kept.write_text(original)
    retained = migrate_legacy_config(kept, unavailable)
    assert retained.status == "retained"
    assert SENTINEL in kept.read_text()
    assert unavailable.resolve("none", "anthropic").mode == "memory"
    assert unavailable.resolve("none", "anthropic").secret == SENTINEL

    broken = tmp / "broken.json"
    broken.write_text("{not json")
    before = broken.read_bytes()
    failed = migrate_legacy_config(broken, _store(durable=MemorySecretStore(), keyring=True))
    assert failed.status == "failed"
    assert broken.read_bytes() == before
    print("PASS: failed migration keeps the only copy")


def test_posix_permissions(tmp: Path):
    if os.name == "nt":
        print("PASS: posix permissions skipped")
        return
    directory = tmp / "secure"
    directory.mkdir()
    path = directory / "config.json"
    path.write_text(json.dumps({"api_key": SENTINEL, "provider": "openai"}))
    os.chmod(directory, 0o755)
    os.chmod(path, 0o644)
    probe = directory / "probe"
    probe.write_text("x")
    os.chmod(probe, 0o600)
    if stat.S_IMODE(probe.stat().st_mode) != 0o600:
        print("PASS: posix permissions not enforceable")
        return
    store = _store(keyring=False)
    result = migrate_legacy_config(path, store)
    assert result.status == "retained"
    assert SENTINEL in path.read_text()
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    restrict_config_permissions(path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    print("PASS: legacy config permissions are restrictive")


def _openai_factory(log):
    class _Msg:
        content = "ok"
        tool_calls = None

    class _Choice:
        finish_reason = "stop"
        message = _Msg()

    class _Resp:
        choices = [_Choice()]

    class _Completions:
        async def create(self, **kwargs):
            log.append({"create_model": kwargs.get("model")})
            return _Resp()

    def factory(spec: ResolvedProvider):
        log.append({
            "api_key": spec.api_key,
            "model": spec.model,
            "base_url": spec.base_url,
            "provider": spec.provider,
        })
        return type("Client", (), {"chat": type("Chat", (), {"completions": _Completions()})()})()

    return factory


def _anthropic_factory(log):
    class _Block:
        type = "text"
        text = "ok"

    class _Resp:
        stop_reason = "end_turn"
        content = [_Block()]

    class _Messages:
        async def create(self, **kwargs):
            log.append({"create_model": kwargs.get("model")})
            return _Resp()

    def factory(spec: ResolvedProvider):
        log.append({
            "api_key": spec.api_key,
            "model": spec.model,
            "base_url": spec.base_url,
            "provider": spec.provider,
        })
        return type("Client", (), {"messages": _Messages()})()

    return factory


async def test_explicit_clients_and_concurrency():
    env_before = dict(os.environ)
    openai_log = []
    spec = ResolvedProvider("openai", SENTINEL, "model-explicit", "https://openai.example/v1", "profile")
    result = await ai._openai_chat("hello", "<p>x</p>", [], provider=spec, client_factory=_openai_factory(openai_log))
    assert result["reply"]
    assert openai_log[0]["api_key"] == SENTINEL
    assert openai_log[0]["base_url"] == "https://openai.example/v1"
    assert openai_log[0]["model"] == "model-explicit"
    assert openai_log[1]["create_model"] == "model-explicit"
    assert SENTINEL not in result["reply"]

    anthropic_log = []
    spec_b = ResolvedProvider("anthropic", "anthropic-key-zzzz", "model-b", "https://anthropic.example", "profile")
    result_b = await ai._anthropic_chat("hello", "<p>x</p>", [], provider=spec_b, client_factory=_anthropic_factory(anthropic_log))
    assert anthropic_log[0]["api_key"] == "anthropic-key-zzzz"
    assert anthropic_log[0]["model"] == "model-b"
    assert anthropic_log[1]["create_model"] == "model-b"
    assert "anthropic-key-zzzz" not in result_b["reply"]

    crossed = []

    async def go(spec_one):
        await ai.process_chat("hello", "<p>x</p>", [], spec_one, client_factory=_openai_factory(crossed))

    await asyncio.gather(
        go(ResolvedProvider("openai", "key-A", "model-A", "https://a.example/v1", "profile")),
        go(ResolvedProvider("openai", "key-B", "model-B", "https://b.example/v1", "profile")),
    )
    by_key = {row["api_key"]: row for row in crossed if "api_key" in row}
    assert by_key["key-A"]["model"] == "model-A"
    assert by_key["key-A"]["base_url"] == "https://a.example/v1"
    assert by_key["key-B"]["model"] == "model-B"
    assert by_key["key-B"]["base_url"] == "https://b.example/v1"
    assert os.environ == env_before

    class Raising:
        def __init__(self, spec):
            self.chat = type("Chat", (), {"completions": self})()

        async def create(self, **_kwargs):
            raise RuntimeError(f"provider rejected {SENTINEL}")

    def raising_factory(spec):
        return Raising(spec)

    failed = await ai.process_chat(
        "hello",
        "<p>x</p>",
        [],
        ResolvedProvider("openai", SENTINEL, "gpt-4o", "https://api.openai.com/v1", "profile"),
        client_factory=raising_factory,
    )
    assert SENTINEL not in failed["reply"]
    assert "DOCXEDI" not in failed["reply"]
    assert redact(f"see {SENTINEL}", SENTINEL) == "see ••••"
    print("PASS: explicit clients, concurrency, redaction")


def test_http_credentials_and_cors():
    env_before = dict(os.environ)
    store = _store(env={"OPENAI_API_KEY": "env-only-key-zzzz"}, durable=MemorySecretStore(), keyring=True)
    recorded = []
    tested = []

    def factory(spec: ResolvedProvider):
        recorded.append(spec)
        return _openai_factory([])(spec)

    async def ok_tester(spec: ResolvedProvider):
        tested.append((spec.api_key, spec.model, spec.base_url))

    with TestClient(app) as client:
        _use(store)
        app.state.client_factory = factory
        app.state.credential_tester = ok_tester
        rejected = client.post("/api/config", json={"api_key": SENTINEL})
        assert rejected.status_code == 404
        assert SENTINEL not in rejected.text
        chat_rejected = client.post("/api/chat", json={
            "message": "hi",
            "profile_id": "profile-a",
            "provider": "openai",
            "api_key": SENTINEL,
        })
        assert chat_rejected.status_code == 422
        assert SENTINEL not in chat_rejected.text
        assert "DOCXEDI" not in chat_rejected.text
        assert chat_rejected.json()["error"]["code"] == "secret_field_rejected"

        created = client.put("/api/credentials/profile-a", json={"api_key": SENTINEL, "provider": "openai"})
        assert created.status_code == 200
        body = created.json()
        assert body["has_key"] is True and body["mode"] == "keyring" and body["hint"] == "••••9f2c"
        assert SENTINEL not in created.text and "DOCXEDI" not in created.text

        status = client.get("/api/credentials/profile-a", params={"provider": "openai"})
        assert status.status_code == 200
        assert status.json()["hint"] == "••••9f2c"
        assert SENTINEL not in status.text

        other = client.get("/api/credentials/profile-b", params={"provider": "openai"})
        assert other.json()["mode"] == "environment"
        assert "env-only-key-zzzz" not in other.text
        other_provider = client.get("/api/credentials/profile-a", params={"provider": "anthropic"})
        assert other_provider.json()["has_key"] is False
        assert SENTINEL not in other_provider.text

        tested_res = client.post("/api/credentials/profile-a/test", json={
            "provider": "openai",
            "model": "model-A",
            "base_url": "https://a.example/v1",
        })
        assert tested_res.status_code == 200 and tested_res.json()["ok"] is True
        assert SENTINEL not in tested_res.text
        assert tested == [(SENTINEL, "model-A", "https://a.example/v1")]

        chat = client.post("/api/chat", json={
            "message": "hello",
            "document": "<p>x</p>",
            "profile_id": "profile-a",
            "provider": "openai",
            "model": "model-A",
            "base_url": "https://a.example/v1",
        })
        assert chat.status_code == 200
        assert SENTINEL not in chat.text
        assert recorded[-1].api_key == SENTINEL
        assert recorded[-1].model == "model-A"

        missing = client.post("/api/chat", json={
            "message": "hello",
            "profile_id": "nobody",
            "provider": "anthropic",
        })
        assert missing.status_code == 401
        assert "ANTHROPIC_API_KEY" in missing.text
        assert "api_key" not in missing.text

        removed = client.delete("/api/credentials/profile-a", params={"provider": "openai"})
        assert removed.status_code == 200
        assert removed.json()["mode"] == "environment"
        assert removed.json()["source"] == "environment"
        assert removed.json()["has_key"] is True
        assert "env-only-key-zzzz" not in removed.text
        assert SENTINEL not in removed.text
        assert os.environ.get("OPENAI_API_KEY") == env_before.get("OPENAI_API_KEY")

        short = client.put("/api/credentials/profile-short", json={"api_key": "abcd", "provider": "openai"})
        assert short.json()["hint"] == "••••"
        assert "abcd" not in short.text

        for origin in ALLOWED_ORIGINS:
            preflight = client.options(
                "/api/credentials/profile-a",
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "PUT",
                    "Access-Control-Request-Headers": "content-type",
                },
            )
            assert preflight.status_code == 200, (origin, preflight.status_code, preflight.text)
            assert preflight.headers["access-control-allow-origin"] == origin
            assert preflight.headers.get("access-control-allow-credentials") != "true"
            allow_methods = preflight.headers["access-control-allow-methods"]
            assert "PUT" in allow_methods and "GET" in allow_methods and "DELETE" in allow_methods

        hostile = client.options(
            "/api/credentials/profile-a",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert hostile.status_code == 400
        assert hostile.headers.get("access-control-allow-origin") not in {"https://evil.example", "*"}
        cross = client.get("/api/credentials/profile-short", params={"provider": "openai"}, headers={"Origin": "https://evil.example"})
        assert cross.headers.get("access-control-allow-origin") not in {"https://evil.example", "*"}
        assert "*" not in ALLOWED_ORIGINS

        paths = {getattr(route, "path", "") for route in app.routes}
        assert "/api/config" not in paths
        api_paths = {path for path in paths if path.startswith("/api/")}
        assert not any("auth" in path or "pair" in path or "stronghold" in path for path in api_paths)

    assert os.environ == env_before
    config_path = Path(os.environ["DOCXEDITOR_CONFIG_PATH"])
    if config_path.exists():
        assert SENTINEL not in config_path.read_text()
        assert "api_key" not in config_path.read_text()
    print("PASS: credential HTTP, rejection, CORS")


def test_csp_and_fonts():
    conf = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text())
    security = conf["app"]["security"]
    assert security.get("dangerousDisableAssetCspModification") in (None, False, [])
    csp = security["csp"]
    dev = security["devCsp"]
    assert csp and dev
    assert csp != dev

    def flat(policy):
        parts = []
        for key, value in policy.items():
            if isinstance(value, list):
                parts.extend(value)
            else:
                parts.append(str(value))
        return " ".join(parts)

    prod_text = flat(csp)
    dev_text = flat(dev)
    assert "*" not in prod_text and "*" not in dev_text
    for banned in ("api.openai.com", "api.anthropic.com", "fonts.googleapis.com", "fonts.gstatic.com"):
        assert banned not in prod_text
        assert banned not in dev_text
    assert "http://127.0.0.1:8000" in csp["connect-src"]
    assert "ipc:" in csp["connect-src"]
    assert "http://ipc.localhost" in csp["connect-src"]
    assert "5173" not in prod_text and "ws://" not in prod_text
    assert "ws://localhost:5173" in dev["connect-src"]
    assert csp["object-src"] == ["'none'"]
    assert csp["base-uri"] == ["'none'"]
    assert csp["frame-ancestors"] == ["'none'"]
    assert "data:" in csp["img-src"]
    assert "blob:" in csp["img-src"]
    index = (ROOT / "frontend" / "index.html").read_text()
    assert "fonts.googleapis.com" not in index
    assert "fonts.gstatic.com" not in index
    print("PASS: CSP and remote fonts")


def test_no_plaintext_config_after_successful_migration(tmp: Path):
    path = tmp / "config.json"
    path.write_text(json.dumps({"provider": "openai", "api_key": SENTINEL, "model": "gpt-4o"}))
    store = _store(durable=MemorySecretStore(), keyring=True)
    assert migrate_legacy_config(path, store).status == "migrated"
    with TestClient(app) as client:
        _use(store)
        app.state.client_factory = _openai_factory([])
        client.post("/api/chat", json={
            "message": "hello",
            "profile_id": "unrelated",
            "provider": "openai",
            "model": "gpt-4o",
        })
        client.put("/api/credentials/profile-z", json={"api_key": "another-key-zzzz", "provider": "openai"})
    text = path.read_text()
    assert "api_key" not in text
    assert SENTINEL not in text
    assert "another-key-zzzz" not in text
    print("PASS: new requests do not rewrite api_key")


def test_revocation_identity_and_base_url():
    secret = "still-present-key-zzzz"

    class Remains:
        def __init__(self):
            self.data = {"profile:profile-a:openai": secret, "legacy-provider:openai": "legacy-key-zzzz"}
            self.memory_note = None

        def get(self, account):
            return self.data.get(account)

        def set(self, account, value):
            self.data[account] = value

        def delete(self, account):
            raise PasswordDeleteError("Can't delete password in keychain")

    durable = Remains()
    memory = MemorySecretStore({"profile:profile-a:openai": "memory-copy-zzzz"})
    store = CredentialStore(durable, memory, MappingEnv({"OPENAI_API_KEY": "env-key-openai-zzzz"}), True)
    try:
        store.delete_profile("profile-a", "openai")
        raise AssertionError("delete must fail while the key remains")
    except CredentialStillPresent:
        pass
    assert durable.data["profile:profile-a:openai"] == secret
    assert memory.data["profile:profile-a:openai"] == "memory-copy-zzzz"
    assert durable.data["legacy-provider:openai"] == "legacy-key-zzzz"
    assert store.resolve("profile-a", "openai").secret == secret

    class Missing:
        def __init__(self):
            self.data = {}
            self.deletes = 0

        def get(self, account):
            return self.data.get(account)

        def set(self, account, value):
            self.data[account] = value

        def delete(self, account):
            self.deletes += 1
            raise PasswordDeleteError("No such password!")

    missing = CredentialStore(Missing(), MemorySecretStore(), MappingEnv({}), True)
    gone = missing.delete_profile("profile-a", "openai")
    assert gone.has_key is False and gone.source == "missing"
    assert missing.durable.deletes >= 1

    class Lies:
        def __init__(self):
            self.data = {"profile:profile-a:openai": secret}

        def get(self, account):
            return self.data.get(account)

        def set(self, account, value):
            self.data[account] = value

        def delete(self, account):
            return None

    lied = CredentialStore(Lies(), MemorySecretStore({"profile:profile-a:openai": secret}), MappingEnv({}), True)
    try:
        lied.delete_profile("profile-a", "openai")
        raise AssertionError("quiet delete must still be checked")
    except CredentialStillPresent:
        pass
    assert lied.memory.data["profile:profile-a:openai"] == secret

    class LockedAfter:
        def __init__(self):
            self.data = {"profile:profile-a:openai": secret}
            self.deleted = False

        def get(self, account):
            if self.deleted:
                raise KeyringLocked("locked")
            return self.data.get(account)

        def set(self, account, value):
            self.data[account] = value

        def delete(self, account):
            self.deleted = True

    locked = CredentialStore(LockedAfter(), MemorySecretStore({"profile:profile-a:openai": secret}), MappingEnv({}), True)
    try:
        locked.delete_profile("profile-a", "openai")
        raise AssertionError("unreadable keyring must not count as revoked")
    except CredentialUnverifiable:
        pass
    assert locked.memory.data["profile:profile-a:openai"] == secret

    class Honest:
        def __init__(self):
            self.data = {
                "profile:profile-a:openai": secret,
                "profile:profile-a:anthropic": "anth-key-zzzz",
                "legacy-provider:openai": "legacy-key-zzzz",
            }

        def get(self, account):
            return self.data.get(account)

        def set(self, account, value):
            self.data[account] = value

        def delete(self, account):
            self.data.pop(account, None)

    honest_memory = MemorySecretStore()
    honest = CredentialStore(
        Honest(),
        honest_memory,
        MappingEnv({"OPENAI_API_KEY": "env-key-openai-zzzz", "ANTHROPIC_API_KEY": "env-key-anthropic-yyyy"}),
        True,
    )
    status = honest.delete_profile("profile-a", "openai")
    assert "profile:profile-a:openai" not in honest.durable.data
    assert "profile:profile-a:anthropic" not in honest.durable.data
    assert honest.durable.data["legacy-provider:openai"] == "legacy-key-zzzz"
    assert honest.resolve("profile-a", "openai").secret == "legacy-key-zzzz"
    assert honest.resolve("profile-a", "openai").source == "legacy"
    assert status.source == "legacy" and status.persistent is True
    assert honest.resolve("profile-a", "anthropic").secret == "env-key-anthropic-yyyy"
    assert honest.resolve("profile-a", "anthropic").source == "environment"
    env_only = CredentialStore(
        Honest(),
        MemorySecretStore(),
        MappingEnv({"OPENAI_API_KEY": "env-key-openai-zzzz"}),
        True,
    )
    env_only.durable.data.pop("legacy-provider:openai", None)
    env_only.durable.data["profile:profile-b:openai"] = secret
    env_status = env_only.delete_profile("profile-b", "openai")
    assert env_status.source == "environment"
    assert env_status.hint == "••••zzzz"
    assert "env-key-openai-zzzz" not in json.dumps(env_status.public_dict())

    split = _store(durable=MemorySecretStore(), keyring=True)
    split.put("profile-a", "openai", SENTINEL)
    split.put("profile-a", "anthropic", "anth-only-key-zzzz")
    assert split.resolve("profile-a", "openai").secret == SENTINEL
    assert split.resolve("profile-a", "anthropic").secret == "anth-only-key-zzzz"
    assert split.resolve("profile-a", "anthropic").secret != SENTINEL

    planted = _store(durable=MemorySecretStore({"profile:profile-old": SENTINEL}), keyring=True)
    assert planted.resolve("profile-old", "openai") is None
    assert planted.resolve("profile-old", "anthropic") is None
    assert planted.status("profile-old", "openai").unbound_profile_credential is True
    assert "DOCXEDI" not in planted.status("profile-old", "openai").hint
    rebound = planted.rebind_unscoped("profile-old", "openai")
    assert rebound.source == "profile"
    assert planted.resolve("profile-old", "openai").secret == SENTINEL
    assert planted.resolve("profile-old", "anthropic") is None
    assert "profile:profile-old" not in planted.durable.data
    assert planted.durable.data["profile:profile-old:openai"] == SENTINEL
    again = planted.rebind_unscoped("profile-old", "anthropic")
    assert again.source != "profile" or planted.resolve("profile-old", "anthropic") is None
    assert "profile:profile-old:anthropic" not in planted.durable.data

    class NoCopy:
        def __init__(self):
            self.data = {"profile:profile-old": SENTINEL}

        def get(self, account):
            return self.data.get(account)

        def set(self, account, value):
            if account.endswith(":openai"):
                raise OSError("cannot bind")
            self.data[account] = value

        def delete(self, account):
            self.data.pop(account, None)

    stuck = CredentialStore(NoCopy(), MemorySecretStore(), MappingEnv({}), True)
    try:
        stuck.rebind_unscoped("profile-old", "openai")
        raise AssertionError("failed rebind must not look successful")
    except CredentialStoreError:
        pass
    assert stuck.durable.data["profile:profile-old"] == SENTINEL

    class FileBackend:
        priority = 5
        __module__ = "keyring.backends.file"

    class Plaintext:
        priority = 0.5
        __module__ = "keyrings.alt.file"

    class NullBackend:
        priority = 0
        __module__ = "keyring.backends.null"

    class Chainer:
        priority = 10
        __module__ = "keyring.backends.chainer"
        backends = [FileBackend()]

    class Mac:
        priority = 5
        __module__ = "keyring.backends.macOS"

    class MixedChainer:
        priority = 10
        __module__ = "keyring.backends.chainer"
        backends = [Mac(), Plaintext()]

    class OsChainer:
        priority = 10
        __module__ = "keyring.backends.chainer"
        backends = [Mac(), NullBackend()]

    assert _trusted_keyring_backend(FileBackend()) is False
    assert _trusted_keyring_backend(Plaintext()) is False
    assert _trusted_keyring_backend(Chainer()) is False
    assert _trusted_keyring_backend(MixedChainer()) is False
    assert _trusted_keyring_backend(OsChainer()) is True
    assert _trusted_keyring_backend(Mac()) is True
    assert detect_keyring(type("Mod", (), {
        "get_keyring": staticmethod(lambda: FileBackend()),
        "get_password": staticmethod(lambda *_args: None),
    })) == (False, None)

    assert validate_base_url("https://proxy.example/v1") == "https://proxy.example/v1"
    assert validate_base_url("http://127.0.0.2:11434/v1").startswith("http://127.0.0.2")
    assert validate_base_url("http://localhost:11434/v1").startswith("http://localhost")
    assert validate_base_url("") == ""
    for bad in (
        "http://example.com/v1",
        "https://user:pass@proxy.example/v1",
        "file:///tmp/x",
        "javascript:alert(1)",
        "http://169.254.169.254/",
    ):
        try:
            validate_base_url(bad)
            raise AssertionError(bad)
        except InvalidBaseUrl:
            pass

    with TestClient(app) as client:
        _use(_store(durable=MemorySecretStore({"profile:profile-a:openai": SENTINEL}), keyring=True))
        called = []

        async def tester(spec):
            called.append(spec.base_url)

        app.state.credential_tester = tester
        rejected = client.post("/api/credentials/profile-a/test", json={
            "provider": "openai",
            "base_url": "https://user:pass@proxy.example/v1",
        })
        assert rejected.status_code == 422
        assert SENTINEL not in rejected.text
        assert "pass" not in rejected.text
        assert called == []
        isolated = client.post("/api/chat", json={
            "message": "hello",
            "profile_id": "profile-a",
            "provider": "anthropic",
            "model": "claude",
        })
        assert isolated.status_code == 401
        assert SENTINEL not in isolated.text
        put_missing = client.put("/api/credentials/profile-a", json={"api_key": SENTINEL})
        assert put_missing.status_code == 422
        assert SENTINEL not in put_missing.text

    crossed = []

    async def isolated_providers():
        openai_key = split.resolve("profile-a", "openai").secret
        anthropic_key = split.resolve("profile-a", "anthropic").secret
        await asyncio.gather(
            ai.process_chat(
                "hello", "<p>x</p>", [],
                ai_spec("openai", openai_key, "model-o", "https://openai.example/v1"),
                client_factory=_openai_factory(crossed),
            ),
            ai.process_chat(
                "hello", "<p>x</p>", [],
                ai_spec("anthropic", anthropic_key, "model-a", "https://anthropic.example"),
                client_factory=_anthropic_factory(crossed),
            ),
        )

    asyncio.run(isolated_providers())
    by_key = {row["api_key"]: row for row in crossed if "api_key" in row}
    assert by_key[SENTINEL]["provider"] == "openai"
    assert by_key[SENTINEL]["model"] == "model-o"
    assert by_key["anth-only-key-zzzz"]["provider"] == "anthropic"
    assert by_key["anth-only-key-zzzz"]["model"] == "model-a"

    print("PASS: revocation, provider identity, base URL")


class RecordingStore:
    def __init__(self, data=None):
        self.data = dict(data or {})
        self.events = []

    def get(self, account):
        self.events.append(("get", account))
        return self.data.get(account)

    def set(self, account, secret):
        self.events.append(("set", account))
        self.data[account] = secret

    def delete(self, account):
        self.events.append(("delete", account))
        self.data.pop(account, None)


def test_unscoped_recovery_and_legacy_startup(tmp: Path):
    pid = "profile-anth"
    recorded = RecordingStore({f"profile:{pid}": SENTINEL})
    store = CredentialStore(recorded, MemorySecretStore(), MappingEnv({}), True)
    recorded.events.clear()
    assert store.resolve(pid, "anthropic") is None
    assert store.resolve(pid, "openai") is None
    assert f"profile:{pid}" not in {account for _kind, account in recorded.events}
    assert not any(kind == "set" for kind, _account in recorded.events)
    assert store.status(pid, "anthropic").unbound_profile_credential is True
    assert SENTINEL not in json.dumps(store.status(pid, "anthropic").public_dict())
    provider_calls = []

    def reject_provider(_spec):
        provider_calls.append("called")
        raise AssertionError("chat must not call the provider for an unscoped credential")

    assert validate_base_url("http://[::1]/v1") == "http://[::1]/v1"
    assert validate_base_url("https://proxy.example/v1") == "https://proxy.example/v1"
    for bad in ("http://127.0.0.1:99999/v1", "http://[::1", "http://[gggg::1]/v1", "https://proxy.example:99999/v1"):
        try:
            validate_base_url(bad)
            raise AssertionError(bad)
        except InvalidBaseUrl:
            pass
        except ValueError as exc:
            raise AssertionError(f"unsanitized parser error for {bad}") from exc

    with TestClient(app) as client:
        _use(store)
        app.state.client_factory = reject_provider
        got = client.get(f"/api/credentials/{pid}", params={"provider": "anthropic"})
        recorded.events.clear()
        chat = client.post("/api/chat", json={
            "message": "hi",
            "profile_id": pid,
            "provider": "anthropic",
            "model": "claude",
        })
        chat_events = list(recorded.events)
        bad_port = client.post("/api/chat", json={
            "message": "hi",
            "profile_id": pid,
            "provider": "openai",
            "base_url": "http://127.0.0.1:99999/v1",
        })
        bad_v6 = client.post("/api/chat", json={
            "message": "hi",
            "profile_id": pid,
            "provider": "openai",
            "base_url": "http://[::1",
        })
        bad_v6_host = client.post("/api/chat/stream", json={
            "message": "hi",
            "profile_id": pid,
            "provider": "openai",
            "base_url": "http://[gggg::1]/v1",
        })
        loopback = client.post("/api/chat", json={
            "message": "hi",
            "profile_id": pid,
            "provider": "openai",
            "base_url": "http://[::1]/v1",
        })
    assert got.status_code == 200
    assert got.json()["unbound_profile_credential"] is True
    assert got.json()["has_key"] is False
    assert got.json()["source"] == "missing"
    assert SENTINEL not in got.text
    assert chat.status_code == 401
    assert provider_calls == []
    assert SENTINEL not in chat.text
    assert f"profile:{pid}" not in {account for _kind, account in chat_events}
    assert not any(kind != "get" for kind, _account in chat_events)
    assert f"profile:{pid}:anthropic" not in recorded.data
    assert recorded.data[f"profile:{pid}"] == SENTINEL
    for rejected in (bad_port, bad_v6, bad_v6_host):
        assert rejected.status_code == 422
        assert rejected.json()["error"]["code"] == "invalid_base_url"
        assert SENTINEL not in rejected.text
        assert "99999" not in rejected.text
        assert "[::1" not in rejected.text
        assert "gggg" not in rejected.text
    assert loopback.status_code == 401

    rebound = store.rebind_unscoped(pid, "openai")
    assert rebound.source == "profile"
    assert rebound.unbound_profile_credential is False
    assert store.resolve(pid, "openai").secret == SENTINEL
    assert store.resolve(pid, "anthropic") is None
    assert recorded.data[f"profile:{pid}:openai"] == SENTINEL
    assert f"profile:{pid}:anthropic" not in recorded.data
    assert f"profile:{pid}" not in recorded.data
    set_at = [index for index, event in enumerate(recorded.events) if event == ("set", f"profile:{pid}:openai")]
    delete_at = [index for index, event in enumerate(recorded.events) if event == ("delete", f"profile:{pid}")]
    assert set_at and delete_at and set_at[0] < delete_at[0]
    repeat = store.rebind_unscoped(pid, "openai")
    assert repeat.source == "profile"
    assert recorded.data[f"profile:{pid}:openai"] == SENTINEL
    again = store.rebind_unscoped(pid, "anthropic")
    assert store.resolve(pid, "anthropic") is None
    assert f"profile:{pid}:anthropic" not in recorded.data

    with TestClient(app) as client:
        fresh = CredentialStore(
            MemorySecretStore({f"profile:{pid}": SENTINEL}),
            MemorySecretStore(),
            MappingEnv({}),
            True,
        )
        _use(fresh)
        first = client.post(f"/api/credentials/{pid}/rebind", json={"provider": "openai"})
        second = client.post(f"/api/credentials/{pid}/rebind", json={"provider": "anthropic"})
        third = client.post(f"/api/credentials/{pid}/rebind", json={"provider": "openai"})
    assert first.status_code == 200
    assert first.json()["source"] == "profile"
    assert first.json()["has_key"] is True
    assert first.json()["unbound_profile_credential"] is False
    assert SENTINEL not in first.text
    assert fresh.durable.data[f"profile:{pid}:openai"] == SENTINEL
    assert f"profile:{pid}:anthropic" not in fresh.durable.data
    assert f"profile:{pid}" not in fresh.durable.data
    assert second.status_code == 200
    assert second.json()["source"] != "profile"
    assert SENTINEL not in second.text
    assert third.status_code == 200
    assert fresh.durable.data[f"profile:{pid}:openai"] == SENTINEL
    assert f"profile:{pid}:anthropic" not in fresh.durable.data

    class Frozen:
        def __init__(self):
            self.data = {"profile:pid:openai": "other-key-zzzz", "profile:pid": SENTINEL}

        def get(self, account):
            return self.data.get(account)

        def set(self, account, secret):
            raise AssertionError("must not overwrite")

        def delete(self, account):
            raise AssertionError("must not delete")

    frozen = CredentialStore(Frozen(), MemorySecretStore(), MappingEnv({}), True)
    with TestClient(app) as client:
        _use(frozen)
        refused = client.post("/api/credentials/pid/rebind", json={"provider": "openai"})
        other = client.post("/api/credentials/pid/rebind", json={"provider": "anthropic"})
    assert refused.status_code == 200
    assert refused.json()["source"] == "profile"
    assert refused.json()["unbound_profile_credential"] is True
    assert other.status_code == 200
    assert other.json()["unbound_profile_credential"] is True
    assert "profile:pid:anthropic" not in frozen.durable.data
    assert frozen.durable.data["profile:pid"] == SENTINEL
    assert frozen.durable.data["profile:pid:openai"] == "other-key-zzzz"
    assert SENTINEL not in refused.text and SENTINEL not in other.text
    assert frozen.has_unscoped("pid") is True

    class NoSet:
        def __init__(self):
            self.data = {"profile:pid": SENTINEL}
            self.deletes = []

        def get(self, account):
            return self.data.get(account)

        def set(self, account, secret):
            raise OSError("cannot bind")

        def delete(self, account):
            self.deletes.append(account)

    stuck = CredentialStore(NoSet(), MemorySecretStore(), MappingEnv({}), True)
    with TestClient(app) as client:
        _use(stuck)
        res = client.post("/api/credentials/pid/rebind", json={"provider": "openai"})
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "credential_store_failed"
    assert SENTINEL not in res.text
    assert stuck.durable.data["profile:pid"] == SENTINEL
    assert stuck.durable.deletes == []

    discard_store = RecordingStore({
        "profile:keep:openai": "other-key-zzzz",
        "profile:keep": SENTINEL,
    })
    discardable = CredentialStore(discard_store, MemorySecretStore(), MappingEnv({}), True)
    with TestClient(app) as client:
        _use(discardable)
        discarded = client.post("/api/credentials/keep/discard-unscoped")
    assert discarded.status_code == 200
    assert discarded.json()["discarded"] is True
    assert discarded.json()["unbound_profile_credential"] is False
    assert SENTINEL not in discarded.text
    assert discard_store.data["profile:keep:openai"] == "other-key-zzzz"
    assert "profile:keep" not in discard_store.data

    class Sticky:
        def __init__(self):
            self.data = {"profile:keep": SENTINEL, "profile:keep:openai": "other-key-zzzz"}

        def get(self, account):
            return self.data.get(account)

        def set(self, account, secret):
            raise AssertionError("discard must not write")

        def delete(self, account):
            raise OSError("denied")

    sticky = CredentialStore(Sticky(), MemorySecretStore(), MappingEnv({}), True)
    with TestClient(app) as client:
        _use(sticky)
        denied = client.post("/api/credentials/keep/discard-unscoped")
    assert denied.status_code == 503
    assert SENTINEL not in denied.text
    assert sticky.durable.data["profile:keep"] == SENTINEL
    assert sticky.durable.data["profile:keep:openai"] == "other-key-zzzz"
    assert sticky.has_unscoped("keep") is True

    owned = RecordingStore({
        "profile:gone:openai": "oa-key-zzzz",
        "profile:gone:anthropic": "an-key-zzzz",
        "profile:gone": SENTINEL,
        "unscoped-consumed:gone": "openai",
        "legacy-provider:openai": "legacy-keep-zzzz",
    })
    owned_store = CredentialStore(owned, MemorySecretStore(), MappingEnv({}), True)
    with TestClient(app) as client:
        _use(owned_store)
        removed = client.delete("/api/credentials/gone", params={"provider": "openai"})
    assert removed.status_code == 200
    assert SENTINEL not in removed.text
    for account in ("profile:gone:openai", "profile:gone:anthropic", "profile:gone", "unscoped-consumed:gone"):
        assert account not in owned.data
    assert owned.data["legacy-provider:openai"] == "legacy-keep-zzzz"

    class RollbackFails:
        def __init__(self):
            self.data = {}
            self.phase = "ready"

        def get(self, account):
            if self.phase == "unread":
                raise OSError("unreadable")
            return self.data.get(account)

        def set(self, account, secret):
            self.data[account] = secret
            self.phase = "unread"

        def delete(self, account):
            raise OSError("cannot roll back")

    path = tmp / "config.json"
    path.write_text(json.dumps({"provider": "openai", "api_key": SENTINEL, "model": "gpt-4o"}))
    rollback_store = CredentialStore(RollbackFails(), MemorySecretStore(), MappingEnv({}), True)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        result = migrate_legacy_config(path, rollback_store)
    assert result.status == "failed"
    assert result.status != "migrated"
    assert SENTINEL in path.read_text()
    assert "api_key" in path.read_text()
    joined = " ".join(str(item.message) for item in caught)
    assert SENTINEL not in joined
    assert rollback_store.resolve("any", "openai") is None
    assert rollback_store.memory.data == {}

    class SetFails:
        def __init__(self):
            self.data = {}

        def get(self, account):
            return self.data.get(account)

        def set(self, account, secret):
            raise OSError("refused")

        def delete(self, account):
            self.data.pop(account, None)

    session_path = tmp / "session.json"
    session_path.write_text(json.dumps({"provider": "openai", "api_key": SENTINEL, "model": "gpt-4o"}))
    session_store = CredentialStore(SetFails(), MemorySecretStore(), MappingEnv({}), True)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        retained = migrate_legacy_config(session_path, session_store)
    assert retained.status == "retained"
    assert retained.status != "migrated"
    assert "session" in (retained.warning or "")
    assert SENTINEL not in " ".join(str(item.message) for item in caught)
    assert SENTINEL in session_path.read_text()
    assert session_store.durable.data == {}
    remembered = session_store.resolve("any", "openai")
    assert remembered is not None and remembered.secret == SENTINEL and remembered.mode == "memory"

    ok_path = tmp / "ok.json"
    ok_path.write_text(json.dumps({"provider": "openai", "api_key": SENTINEL, "model": "gpt-4o", "extra": "keep"}))
    ok_store = _store(durable=MemorySecretStore(), keyring=True)
    migrated = migrate_legacy_config(ok_path, ok_store)
    assert migrated.status == "migrated"
    assert migrated.warning is None
    written = json.loads(ok_path.read_text())
    assert "api_key" not in written
    assert SENTINEL not in ok_path.read_text()
    assert written["extra"] == "keep"
    assert ok_store.durable.data["legacy-provider:openai"] == SENTINEL

    from . import main as mainmod
    previous_path = os.environ.get("DOCXEDITOR_CONFIG_PATH")
    previous_open = mainmod.open_credential_store

    def restore_startup():
        mainmod.open_credential_store = previous_open
        if previous_path is None:
            os.environ.pop("DOCXEDITOR_CONFIG_PATH", None)
        else:
            os.environ["DOCXEDITOR_CONFIG_PATH"] = previous_path

    os.environ["DOCXEDITOR_CONFIG_PATH"] = str(path)
    mainmod.open_credential_store = lambda *args, **kwargs: CredentialStore(
        RollbackFails(), MemorySecretStore(), MappingEnv({}), True,
    )
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            with TestClient(app) as client:
                failed_health = client.get("/api/health")
        assert SENTINEL not in " ".join(str(item.message) for item in caught)
    finally:
        restore_startup()
    assert failed_health.status_code == 200
    assert failed_health.json()["status"] == "ok"
    assert failed_health.json()["legacy_migration"] == "failed"
    assert SENTINEL not in failed_health.text
    assert SENTINEL in path.read_text()

    os.environ["DOCXEDITOR_CONFIG_PATH"] = str(session_path)
    started = {}

    def open_session(*_args, **_kwargs):
        started["store"] = CredentialStore(SetFails(), MemorySecretStore(), MappingEnv({}), True)
        return started["store"]

    mainmod.open_credential_store = open_session
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            with TestClient(app) as client:
                health = client.get("/api/health")
        assert SENTINEL not in " ".join(str(item.message) for item in caught)
    finally:
        restore_startup()
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.json()["legacy_migration"] == "retained"
    assert SENTINEL not in health.text
    assert SENTINEL in session_path.read_text()
    started_secret = started["store"].resolve("any", "openai")
    assert started_secret is not None and started_secret.mode == "memory"
    assert started_secret.secret == SENTINEL
    assert started["store"].durable.data == {}
    print("PASS: unscoped recovery and legacy startup")


def main():
    test_mask_and_profile_isolation()
    test_memory_fallback_and_precedence()
    test_keyring_write_failure_does_not_claim_success()
    test_detect_keyring_without_writing()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        test_legacy_config_migration(root)
        test_legacy_migration_preserves_only_copy(root)
        test_posix_permissions(root)
        test_no_plaintext_config_after_successful_migration(root)
    asyncio.run(test_explicit_clients_and_concurrency())
    test_http_credentials_and_cors()
    test_csp_and_fonts()
    test_revocation_identity_and_base_url()
    with tempfile.TemporaryDirectory() as directory:
        test_unscoped_recovery_and_legacy_startup(Path(directory))
    print("ALL CREDENTIAL TESTS PASSED")


if __name__ == "__main__":
    main()
