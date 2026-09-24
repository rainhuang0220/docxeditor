"""Per-launch session authentication for the desktop backend.

The token lives only in this process. Packaged builds always require it.
Source checkouts accept requests without a token only when the process
environment asked for insecure local development before dotenv ran.
"""

from __future__ import annotations

import hashlib
import hmac
import sys

_TOKEN: bytes | None = None
_DEV_INSECURE = False

_UNAUTHORIZED = b'{"error":{"code":"unauthorized","message":"Not authenticated."}}'


def configure(*, token: bytes | None, dev_insecure: bool) -> None:
    """Install the session. A frozen build cannot opt out."""
    global _TOKEN, _DEV_INSECURE
    frozen = bool(getattr(sys, "frozen", False))
    _DEV_INSECURE = bool(dev_insecure) and not frozen and token is None
    _TOKEN = None if _DEV_INSECURE else token


def dev_insecure() -> bool:
    return _DEV_INSECURE


def token_configured() -> bool:
    return _TOKEN is not None


def auth_enforced() -> bool:
    if getattr(sys, "frozen", False):
        return True
    if _DEV_INSECURE:
        return False
    return True


def tokens_match(provided: str, expected: bytes) -> bool:
    """Compare without leaking the token through an early length return."""
    try:
        raw = bytes.fromhex(provided)
    except ValueError:
        raw = b""
    return hmac.compare_digest(hashlib.sha256(raw).digest(), hashlib.sha256(expected).digest())


def _header_token(scope: dict) -> str:
    for name, value in scope.get("headers") or ():
        if name == b"authorization":
            text = value.decode("latin-1", errors="ignore")
            prefix = "Bearer "
            if text.startswith(prefix):
                return text[len(prefix):].strip()
            return ""
    return ""


def authorized(scope: dict) -> bool:
    expected = _TOKEN
    if expected is None:
        return False
    provided = _header_token(scope)
    if len(provided) != 64:
        tokens_match("", expected)
        return False
    return tokens_match(provided, expected)


class SessionAuth:
    """Reject unauthorized HTTP before the route runs. OPTIONS stays with CORS."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") == "OPTIONS" or not auth_enforced():
            await self.app(scope, receive, send)
            return
        if authorized(scope):
            await self.app(scope, receive, send)
            return
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(_UNAUTHORIZED)).encode("ascii")),
                (b"cache-control", b"no-store"),
            ],
        })
        await send({"type": "http.response.body", "body": _UNAUTHORIZED})
