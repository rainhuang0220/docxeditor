"""Move a legacy plaintext api_key out of ~/.docxeditor/config.json.

The file is rewritten only after the key is read back from the OS keyring.
If secure storage is unavailable, the file is left intact and the key may be
held in process memory for this session.
"""

from __future__ import annotations

import json
import os
import tempfile
import warnings
from dataclasses import dataclass
from pathlib import Path

from .credentials import CredentialStore


@dataclass(frozen=True)
class LegacyMigration:
    status: str
    warning: str | None
    legacy_id: str | None


def default_config_path() -> Path:
    override = os.environ.get("DOCXEDITOR_CONFIG_PATH")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".docxeditor" / "config.json"


def restrict_config_permissions(path: Path) -> None:
    """Best-effort 0700/0600 while a legacy secret file may still exist."""
    if os.name == "nt":
        return
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    if path.exists():
        os.chmod(path, 0o600)


def _atomic_write(path: Path, payload: dict) -> None:
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    restrict_config_permissions(path)
    fd, tmp_name = tempfile.mkstemp(dir=directory, prefix=".config-", suffix=".tmp")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if os.name != "nt":
            os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, path)
        restrict_config_permissions(path)
    except Exception:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise


def migrate_legacy_config(path: Path, store: CredentialStore) -> LegacyMigration:
    if not path.exists():
        return LegacyMigration("not_needed", None, None)
    restrict_config_permissions(path)
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError):
        warnings.warn("Legacy config could not be read and was left unchanged.", stacklevel=2)
        return LegacyMigration("failed", "Legacy config could not be read. It was left unchanged.", None)
    if not isinstance(data, dict):
        warnings.warn("Legacy config was not an object and was left unchanged.", stacklevel=2)
        return LegacyMigration("failed", "Legacy config was left unchanged.", None)

    api_key = data.get("api_key")
    if not isinstance(api_key, str) or not api_key:
        if "api_key" in data:
            cleaned = {key: value for key, value in data.items() if key != "api_key"}
            try:
                _atomic_write(path, cleaned)
            except OSError:
                return LegacyMigration("failed", "Could not remove an empty api_key field.", None)
        return LegacyMigration("not_needed", None, None)

    provider = data.get("provider")
    if provider not in {"openai", "anthropic"}:
        provider = "openai"
    legacy_id = f"legacy-provider:{provider}"

    if not store.keyring_available:
        store.remember_legacy(provider, api_key)
        message = (
            "Persistent secure storage is unavailable. The API key is loaded for this "
            "session only; the saved copy was kept."
        )
        warnings.warn(message, stacklevel=2)
        return LegacyMigration("retained", message, legacy_id)

    if not store.store_legacy_durable(provider, api_key):
        message = "The API key could not be verified in secure storage. The saved copy was kept."
        warnings.warn(message, stacklevel=2)
        return LegacyMigration("failed", message, legacy_id)

    cleaned = {key: value for key, value in data.items() if key != "api_key"}
    try:
        _atomic_write(path, cleaned)
        written = path.read_text(encoding="utf-8")
    except OSError:
        message = "The API key was stored securely, but the old copy could not be removed."
        warnings.warn(message, stacklevel=2)
        return LegacyMigration("failed", message, legacy_id)
    if api_key in written or "api_key" in json.loads(written):
        message = "The old config still contains a secret."
        warnings.warn(message, stacklevel=2)
        return LegacyMigration("failed", message, legacy_id)
    return LegacyMigration("migrated", None, legacy_id)
