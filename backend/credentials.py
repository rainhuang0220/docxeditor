"""Backend-owned provider credentials.

Service: com.docxeditor.app
Account: profile:<profile_id>:<provider>
Legacy branch entries: profile:<profile_id> (no provider; not used until rebound)
Legacy config slot: legacy-provider:<provider>

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
PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
PROVIDERS = ("openai", "anthropic")
ENV_BY_PROVIDER = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}
OS_KEYRING_MODULES = {
    "keyring.backends.macOS",
    "keyring.backends.SecretService",
    "keyring.backends.kwallet",
    "keyring.backends.Windows",
    "keyring.backends.libsecret",
}


class CredentialStoreError(Exception):
    pass


class InvalidProfileId(CredentialStoreError):
    pass


class CredentialStillPresent(CredentialStoreError):
    """A read after deletion still returned a secret."""


class CredentialUnverifiable(CredentialStoreError):
    """The store could not be read, so revocation is not proven."""


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


def check_provider(provider: str) -> str:
    if provider not in ENV_BY_PROVIDER:
        raise InvalidProfileId("invalid provider")
    return provider


def profile_account(profile_id: str, provider: str) -> str:
    return f"profile:{check_profile_id(profile_id)}:{check_provider(provider)}"


def unscoped_account(profile_id: str) -> str:
    """Account written by the unmerged I06 branch. Never a new write target."""
    return f"profile:{check_profile_id(profile_id)}"


def consumed_marker_account(profile_id: str) -> str:
    return f"unscoped-consumed:{check_profile_id(profile_id)}"


def profile_owned_accounts(profile_id: str) -> tuple[str, ...]:
    checked = check_profile_id(profile_id)
    return (
        f"profile:{checked}:openai",
        f"profile:{checked}:anthropic",
        f"profile:{checked}",
        f"unscoped-consumed:{checked}",
    )


def legacy_profile_id(provider: str) -> str:
    return f"legacy-provider:{check_provider(provider)}"


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
        # PasswordDeleteError means the backend could not delete. It is also
        # what a missing item raises. Callers must re-read; this method does
        # not treat any exception as absence.
        self._keyring.delete_password(self._service, account)


@dataclass(frozen=True)
class CredentialStatus:
    has_key: bool
    hint: str
    mode: str
    persistent: bool
    source: str
    unbound_profile_credential: bool = False

    def public_dict(self) -> dict:
        return {
            "has_key": self.has_key,
            "hint": self.hint,
            "mode": self.mode,
            "persistent": self.persistent,
            "source": self.source,
            "unbound_profile_credential": self.unbound_profile_credential,
        }


@dataclass(frozen=True)
class ResolvedCredential:
    secret: str
    mode: str
    source: str


def _status_for(secret: str | None, mode: str, source: str) -> CredentialStatus:
    if not secret:
        return CredentialStatus(False, "", "unavailable", False, "missing", False)
    persistent = mode in {"keyring", "environment"}
    return CredentialStatus(True, mask_secret(secret), mode, persistent, source, False)


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

    def _strict_get(self, store: SecretStore, account: str) -> str | None:
        try:
            value = store.get(account)
        except Exception as exc:
            raise CredentialUnverifiable("credential store could not be read") from exc
        return value if value else None

    def _restore(self, store: SecretStore, account: str, previous: str | None) -> None:
        """Restore a slot and prove it. Raises if the read-back does not match."""
        try:
            if previous is None:
                store.delete(account)
            else:
                store.set(account, previous)
            got = self._strict_get(store, account)
        except CredentialUnverifiable:
            raise
        except Exception as exc:
            raise CredentialUnverifiable("rollback could not be verified") from exc
        if previous is None:
            if got:
                raise CredentialStillPresent("rollback left a credential in place")
            return
        if got is None or not secrets_match(got, previous):
            raise CredentialStillPresent("rollback did not restore the previous credential")

    def _revoke_account(self, store: SecretStore, account: str) -> None:
        """Delete one account only after a following read shows it is empty.

        PasswordDeleteError is not absence. A quiet delete is not absence
        either. Memory for this account is not touched here.
        """
        self._strict_get(store, account)
        try:
            store.delete(account)
        except Exception:
            pass
        if self._strict_get(store, account):
            raise CredentialStillPresent("credential still present")

    def put(self, profile_id: str, provider: str, secret: str) -> CredentialStatus:
        if not secret or not str(secret).strip():
            raise CredentialStoreError("empty credential")
        secret = str(secret)
        account = profile_account(profile_id, provider)
        if self.keyring_available and self.durable is not None:
            try:
                previous = self._strict_get(self.durable, account)
            except CredentialUnverifiable:
                raise CredentialStoreError("secure storage could not be read")
            try:
                self.durable.set(account, secret)
                got = self._strict_get(self.durable, account)
                if got is not None and secrets_match(got, secret):
                    self.memory.delete(account)
                    return _status_for(secret, "keyring", "profile")
                self._restore(self.durable, account, previous)
            except (CredentialStillPresent, CredentialUnverifiable):
                raise CredentialStoreError("secure storage did not accept the new credential")
            except Exception:
                try:
                    self._restore(self.durable, account, previous)
                except (CredentialStillPresent, CredentialUnverifiable):
                    raise CredentialStoreError("secure storage did not accept the new credential")
            if previous:
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

    def delete_profile(self, profile_id: str, provider: str) -> CredentialStatus:
        """Remove every profile-owned record, then report this provider's status.

        Does not delete legacy-provider accounts or environment variables.
        Memory copies are removed only after every durable account is verified
        absent. A failure leaves memory in place.
        """
        check_provider(provider)
        accounts = profile_owned_accounts(profile_id)
        if self.durable is not None:
            for account in accounts:
                self._revoke_account(self.durable, account)
        elif self.keyring_available:
            raise CredentialUnverifiable("credential store could not be read")
        for account in accounts:
            self.memory.delete(account)
        return self.status(profile_id, provider)

    def _owned_secret(self, account: str) -> tuple[str | None, SecretStore | None]:
        if self.durable is not None:
            durable_secret = self._strict_get(self.durable, account)
            if durable_secret:
                return durable_secret, self.durable
        memory_secret = self.memory.get(account)
        if memory_secret:
            return memory_secret, self.memory
        return None, None

    def rebind_unscoped(self, profile_id: str, provider: str) -> CredentialStatus:
        """Copy a branch-era profile:<id> secret onto profile:<id>:<provider>.

        The unscoped entry is deleted only after the bound copy and a
        provider marker both read back. Chat resolution never calls this,
        so a request cannot bind the same secret to the other provider.
        """
        provider = check_provider(provider)
        bound = profile_account(profile_id, provider)
        other = profile_account(profile_id, "anthropic" if provider == "openai" else "openai")
        old = unscoped_account(profile_id)
        marker = consumed_marker_account(profile_id)
        bound_secret, _bound_store = self._owned_secret(bound)
        other_secret, _other_store = self._owned_secret(other)
        old_secret, store = self._owned_secret(old)
        marker_value, _marker_store = self._owned_secret(marker)
        if bound_secret or other_secret or (marker_value and marker_value != provider) or not old_secret or store is None:
            return self.status(profile_id, provider)
        try:
            store.set(bound, old_secret)
            got = self._strict_get(store, bound)
            if got is None or not secrets_match(got, old_secret):
                self._restore(store, bound, None)
                raise CredentialStoreError("could not bind the existing credential")
            store.set(marker, provider)
            marked = self._strict_get(store, marker)
            if marked != provider:
                raise CredentialStoreError("could not record which provider owns the existing credential")
            self._revoke_account(store, old)
        except CredentialStoreError:
            raise
        except (CredentialStillPresent, CredentialUnverifiable) as exc:
            raise CredentialStoreError("could not bind the existing credential") from exc
        except Exception as exc:
            raise CredentialStoreError("could not bind the existing credential") from exc
        if store is self.durable:
            self.memory.delete(old)
        return self.status(profile_id, provider)

    def has_unscoped(self, profile_id: str) -> bool:
        try:
            check_profile_id(profile_id)
        except InvalidProfileId:
            return False
        secret, _mode = self._read(unscoped_account(profile_id))
        return bool(secret)

    def resolve(self, profile_id: str, provider: str) -> ResolvedCredential | None:
        if provider not in ENV_BY_PROVIDER:
            return None
        if profile_id and PROFILE_ID_RE.match(profile_id):
            secret, mode = self._read(profile_account(profile_id, provider))
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
        unbound = bool(profile_id) and self.has_unscoped(profile_id) and (
            resolved is None or resolved.source != "profile"
        )
        if resolved is None:
            base = CredentialStatus(False, "", "unavailable", False, "missing")
        else:
            base = _status_for(resolved.secret, resolved.mode, resolved.source)
        return CredentialStatus(
            base.has_key,
            base.hint,
            base.mode,
            base.persistent,
            base.source,
            unbound,
        )


def _is_os_keyring(backend) -> bool:
    module_name = type(backend).__module__
    if module_name.startswith("keyring.backends.macOS"):
        return True
    return module_name in OS_KEYRING_MODULES


def _priority_at_least_one(backend) -> bool:
    try:
        priority = float(backend.priority)
    except Exception:
        return False
    return priority >= 1


def _trusted_keyring_backend(backend) -> bool:
    """Only known OS keyrings count as durable secure storage.

    priority >= 1 is not enough. A chainer is trusted only when every
    positive-priority child is one of those OS backends. Anything else,
    including file, plaintext, memory, and unknown third-party backends,
    is not trusted, so a legacy plaintext copy is not scrubbed.
    """
    module_name = type(backend).__module__
    class_name = type(backend).__name__
    if "chainer" in module_name or class_name == "ChainerBackend":
        children = list(getattr(backend, "backends", []) or [])
        trusted = []
        for child in children:
            try:
                priority = float(child.priority)
            except Exception:
                return False
            # priority > 0 includes common plaintext backends at 0.5.
            # Those must not be ignored just because an OS backend is also present.
            if priority <= 0:
                continue
            if not _is_os_keyring(child):
                return False
            trusted.append(child)
        return bool(trusted)
    if not _is_os_keyring(backend):
        return False
    return _priority_at_least_one(backend)


def _keyring_backend_usable(keyring_module) -> bool:
    try:
        backend = keyring_module.get_keyring()
    except Exception:
        return False
    if not _trusted_keyring_backend(backend):
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
