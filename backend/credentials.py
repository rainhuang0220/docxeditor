"""Backend-owned provider credentials.

Service: com.docxeditor.app
Account: profile:<profile_id> or legacy-provider:<provider>

The keyring library is imported only by KeyringSecretStore and capability
detection. Callers use CredentialStore.
"""

from __future__ import annotations

import hmac
import os
import re
from dataclasses import dataclass
from typing import Mapping, Protocol

SERVICE_NAME = "com.docxeditor.app"
PROBE_ACCOUNT = "capability-probe"
PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
ENV_BY_PROVIDER = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}


class CredentialStoreError(Exception):
    pass


class InvalidProfileId(CredentialStoreError):
    pass


def mask_secret(secret: str | None) -> str:
    """Display hint. Last four characters only, or bullets when the secret is short."""
    if not secret:
        return ""
    if len(secret) <= 4:
        return "••••"
    return "••••" + secret[-4:]


def check_profile_id(profile_id: str) -> str:
    if not profile_id or not PROFILE_ID_RE.match(profile_id):
        raise InvalidProfileId("invalid profile id")
    return profile_id


def profile_account(profile_id: str) -> str:
    return f"profile:{check_profile_id(profile_id)}"


def legacy_profile_id(provider: str) -> str:
    if provider not in ENV_BY_PROVIDER:
        raise InvalidProfileId("invalid provider")
    return f"legacy-provider:{provider}"


def legacy_account(provider: str) -> str:
    return legacy_profile_id(provider)


def secrets_match(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode(), right.encode())


class SecretStore(Protocol):
    def get(self, account: str) -> str | None: ...
    def set(self, account: str, secret: str) -> None: ...
    def delete(self, account: str) -> None: ...


class EnvSource(Protocol):
    def get(self, name: str) -> str | None: ...


class MemorySecretStore:
    def __init__(self, data: dict[str, str] | None = None):
        self.data: dict[str, str] = dict(data or {})

    def get(self, account: str) -> str | None:
        value = self.data.get(account)
        return value if value else None

    def set(self, account: str, secret: str) -> None:
        self.data[account] = secret

    def delete(self, account: str) -> None:
        self.data.pop(account, None)


class MappingEnv:
    """Read-only view. No setter, so profile changes cannot mutate the environment."""

    def __init__(self, environ: Mapping[str, str]):
        self._environ = environ

    def get(self, name: str) -> str | None:
        value = self._environ.get(name)
        if value is None:
            return None
        text = str(value).strip()
        return text or None


class KeyringSecretStore:
    def __init__(self, keyring_module, service: str = SERVICE_NAME):
        self._keyring = keyring_module
        self._service = service

    def get(self, account: str) -> str | None:
        value = self._keyring.get_password(self._service, account)
        return value if value else None

    def set(self, account: str, secret: str) -> None:
        self._keyring.set_password(self._service, account, secret)

    def delete(self, account: str) -> None:
        try:
            self._keyring.delete_password(self._service, account)
        except Exception as exc:
            name = type(exc).__name__
            if "Delete" in name or "NotFound" in name or "Password" in name:
                return
            raise


@dataclass(frozen=True)
class CredentialStatus:
    has_key: bool
    hint: str
    mode: str
    persistent: bool
    source: str

    def public_dict(self) -> dict:
        return {
            "has_key": self.has_key,
            "hint": self.hint,
            "mode": self.mode,
            "persistent": self.persistent,
            "source": self.source,
        }


@dataclass(frozen=True)
class ResolvedCredential:
    secret: str
    mode: str
    source: str


def _status_for(secret: str | None, mode: str, source: str) -> CredentialStatus:
    if not secret:
        return CredentialStatus(False, "", "unavailable", False, "missing")
    persistent = mode in {"keyring", "environment"}
    return CredentialStatus(True, mask_secret(secret), mode, persistent, source)


class CredentialStore:
    def __init__(
        self,
        durable: SecretStore | None,
        memory: MemorySecretStore,
        env: EnvSource,
        keyring_available: bool,
    ):
        self.durable = durable
        self.memory = memory
        self.env = env
        self.keyring_available = bool(keyring_available and durable is not None)

    def _read(self, account: str) -> tuple[str | None, str]:
        if self.durable is not None:
            try:
                stored = self.durable.get(account)
            except Exception:
                stored = None
            if stored:
                return stored, "keyring"
        stored = self.memory.get(account)
        if stored:
            return stored, "memory"
        return None, "unavailable"

    def _restore(self, store: SecretStore, account: str, previous: str | None) -> None:
        try:
            if previous is None:
                store.delete(account)
            else:
                store.set(account, previous)
        except Exception:
            return

    def put(self, profile_id: str, secret: str) -> CredentialStatus:
        if not secret or not str(secret).strip():
            raise CredentialStoreError("empty credential")
        secret = str(secret)
        account = profile_account(profile_id)
        if self.keyring_available and self.durable is not None:
            previous = None
            try:
                previous = self.durable.get(account)
            except Exception:
                previous = None
            try:
                self.durable.set(account, secret)
                got = self.durable.get(account)
                if got is not None and secrets_match(got, secret):
                    self.memory.delete(account)
                    return _status_for(secret, "keyring", "profile")
                self._restore(self.durable, account, previous)
            except Exception:
                self._restore(self.durable, account, previous)
            if previous:
                # A different durable key is still the one resolve() would return.
                raise CredentialStoreError("secure storage did not accept the new credential")
        self.memory.set(account, secret)
        got = self.memory.get(account)
        if got is None or not secrets_match(got, secret):
            raise CredentialStoreError("session store rejected the credential")
        return _status_for(secret, "memory", "profile")

    def remember_legacy(self, provider: str, secret: str) -> None:
        """Session-only copy. Does not claim the key is durable."""
        self.memory.set(legacy_account(provider), secret)

    def store_legacy_durable(self, provider: str, secret: str) -> bool:
        """Write the legacy slot and require a matching read-back. Restore on failure."""
        if not self.keyring_available or self.durable is None:
            return False
        account = legacy_account(provider)
        previous = None
        try:
            previous = self.durable.get(account)
        except Exception:
            previous = None
        try:
            self.durable.set(account, secret)
            got = self.durable.get(account)
            if got is not None and secrets_match(got, secret):
                return True
        except Exception:
            self._restore(self.durable, account, previous)
            return False
        self._restore(self.durable, account, previous)
        return False

    def delete_profile(self, profile_id: str) -> CredentialStatus:
        account = profile_account(profile_id)
        if self.durable is not None:
            try:
                self.durable.delete(account)
            except Exception:
                raise CredentialStoreError("could not delete the stored credential")
        self.memory.delete(account)
        return CredentialStatus(False, "", "unavailable", False, "missing")

    def resolve(self, profile_id: str, provider: str) -> ResolvedCredential | None:
        if provider not in ENV_BY_PROVIDER:
            return None
        if profile_id and PROFILE_ID_RE.match(profile_id):
            secret, mode = self._read(profile_account(profile_id))
            if secret:
                return ResolvedCredential(secret, mode, "profile")
        secret, mode = self._read(legacy_account(provider))
        if secret:
            return ResolvedCredential(secret, mode, "legacy")
        env_name = ENV_BY_PROVIDER[provider]
        env_value = self.env.get(env_name)
        if env_value:
            return ResolvedCredential(env_value, "environment", "environment")
        return None

    def status(self, profile_id: str, provider: str) -> CredentialStatus:
        if provider not in ENV_BY_PROVIDER:
            raise InvalidProfileId("invalid provider")
        if profile_id:
            check_profile_id(profile_id)
        resolved = self.resolve(profile_id, provider)
        if resolved is None:
            return CredentialStatus(False, "", "unavailable", False, "missing")
        return _status_for(resolved.secret, resolved.mode, resolved.source)


def _keyring_backend_usable(keyring_module) -> bool:
    try:
        backend = keyring_module.get_keyring()
    except Exception:
        return False
    module_name = type(backend).__module__
    class_name = type(backend).__name__
    if "fail" in module_name or "null" in module_name:
        return False
    if class_name in {"FailKeyring", "NullKeyring"}:
        return False
    priority = getattr(backend, "priority", 0) or 0
    if priority < 1:
        return False
    try:
        keyring_module.get_password(SERVICE_NAME, PROBE_ACCOUNT)
    except Exception:
        return False
    return True


def detect_keyring(keyring_module=None) -> tuple[bool, SecretStore | None]:
    """Read-only probe. Does not write a user secret or a probe password."""
    if keyring_module is None:
        try:
            import keyring as keyring_module
        except Exception:
            return False, None
    if not _keyring_backend_usable(keyring_module):
        return False, None
    return True, KeyringSecretStore(keyring_module)


def open_credential_store(environ: Mapping[str, str] | None = None, keyring_module=None) -> CredentialStore:
    env = MappingEnv(os.environ if environ is None else environ)
    memory = MemorySecretStore()
    disabled = os.environ.get("DOCXEDITOR_KEYRING", "").strip().lower() in {"0", "false", "disabled", "off"}
    if disabled:
        return CredentialStore(None, memory, env, False)
    available, durable = detect_keyring(keyring_module)
    return CredentialStore(durable, memory, env, available)
