"""Request-scoped provider configuration. Never reads or writes API key env vars."""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

_BEARER_RE = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{6,}")
_SK_RE = re.compile(r"sk-[A-Za-z0-9_\-]{6,}")

OPENAI_DEFAULT_MODEL = "gpt-4o"
ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-20250514"
OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"


@dataclass(frozen=True)
class ResolvedProvider:
    """Concrete client inputs for one request. `api_key` must not be logged."""

    provider: str
    api_key: str
    model: str
    base_url: str
    source: str


def redact(text: str, secret: str | None = None) -> str:
    """Remove credential material from a provider error. Keep the rest."""
    cleaned = text or ""
    if secret:
        cleaned = cleaned.replace(secret, "••••")
    cleaned = _BEARER_RE.sub(r"\1••••", cleaned)
    cleaned = _SK_RE.sub("••••", cleaned)
    if len(cleaned) > 500:
        cleaned = cleaned[:500]
    return cleaned


def concrete_model(provider: str, requested: str, env_get) -> str:
    explicit = (requested or "").strip()
    if explicit:
        return explicit
    env_name = "OPENAI_MODEL" if provider == "openai" else "ANTHROPIC_MODEL"
    from_env = env_get(env_name)
    if from_env and str(from_env).strip():
        return str(from_env).strip()
    if provider == "anthropic":
        return ANTHROPIC_DEFAULT_MODEL
    return OPENAI_DEFAULT_MODEL


class InvalidBaseUrl(ValueError):
    """The client base URL must not be sent a credential."""


def _loopback_host(hostname: str) -> bool:
    host = hostname.lower().strip("[]")
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return False
    return address.is_loopback


def validate_base_url(url: str) -> str:
    """Allow https hosts and loopback http. Reject userinfo and other schemes.

    Empty means the caller should use the provider default. A non-empty value
    is returned unchanged when it is safe to attach a credential. This does
    not authenticate the local backend process.
    """
    text = (url or "").strip()
    if not text:
        return ""
    parsed = urlsplit(text)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise InvalidBaseUrl("base URL was rejected")
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise InvalidBaseUrl("base URL was rejected")
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise InvalidBaseUrl("base URL was rejected")
    if parsed.scheme == "http" and not _loopback_host(parsed.hostname):
        raise InvalidBaseUrl("base URL was rejected")
    return text


def concrete_base_url(provider: str, requested: str, env_get) -> str:
    explicit = (requested or "").strip()
    if explicit:
        checked = validate_base_url(explicit)
        if not checked:
            raise InvalidBaseUrl("base URL was rejected")
        return checked
    env_name = "OPENAI_BASE_URL" if provider == "openai" else "ANTHROPIC_BASE_URL"
    from_env = env_get(env_name)
    if from_env and str(from_env).strip():
        try:
            return validate_base_url(str(from_env).strip())
        except InvalidBaseUrl:
            pass
    if provider == "anthropic":
        return ANTHROPIC_DEFAULT_BASE_URL
    return OPENAI_DEFAULT_BASE_URL


def test_provider(kind: str) -> ResolvedProvider:
    """Fixed non-env spec so direct continuation tests do not read process secrets."""
    if kind == "anthropic":
        return ResolvedProvider(
            provider="anthropic",
            api_key="test-not-a-real-key",
            model=ANTHROPIC_DEFAULT_MODEL,
            base_url=ANTHROPIC_DEFAULT_BASE_URL,
            source="test",
        )
    return ResolvedProvider(
        provider="openai",
        api_key="test-not-a-real-key",
        model=OPENAI_DEFAULT_MODEL,
        base_url=OPENAI_DEFAULT_BASE_URL,
        source="test",
    )
