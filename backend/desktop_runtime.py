"""Owned desktop backend process.

The parent writes one stdin line, `v1 <64 hex chars>`. This process binds
127.0.0.1 on a socket it keeps, then prints a readiness line that proves it
knows the token. It does not print the token. Closing stdin, or the parent
pid changing, stops the process.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import sys
import threading
import time

import uvicorn

from .session_auth import configure


def ready_mac(token: bytes, port: int) -> str:
    message = f"ready-v1\n{port}".encode("ascii")
    digest = hmac.new(token, message, hashlib.sha256).hexdigest()
    return digest


def format_ready(token: bytes, port: int) -> str:
    return f"READY v1 {port} {ready_mac(token, port)}\n"


def accept_ready(line: str, token: bytes) -> int | None:
    """Return the port only when this line was produced by a holder of the token.

    A healthy HTTP response is not enough. The line has to come from the child
    pipe and match the MAC.
    """
    parts = line.strip().split(" ")
    if len(parts) != 4 or parts[0] != "READY" or parts[1] != "v1":
        return None
    try:
        port = int(parts[2])
    except ValueError:
        return None
    if not 1 <= port <= 65535 or parts[2] != str(port):
        return None
    if not hmac.compare_digest(parts[3], ready_mac(token, port)):
        return None
    return port


def parse_bootstrap(line: bytes) -> bytes | None:
    text = line.decode("ascii", errors="ignore").strip()
    parts = text.split(" ")
    if len(parts) != 2 or parts[0] != "v1" or len(parts[1]) != 64:
        return None
    try:
        token = bytes.fromhex(parts[1])
    except ValueError:
        return None
    if len(token) != 32:
        return None
    return token


def _watch_parent(parent_pid: int, stdin) -> None:
    def _stdin() -> None:
        try:
            while stdin.read(1):
                pass
        finally:
            os._exit(0)

    def _ppid() -> None:
        while True:
            time.sleep(0.4)
            if os.getppid() != parent_pid:
                os._exit(0)

    threading.Thread(target=_stdin, name="stdin-lifeline", daemon=True).start()
    threading.Thread(target=_ppid, name="ppid-lifeline", daemon=True).start()


def _load_app():
    from .main import app, install_test_hooks

    install_test_hooks()
    return app


def _serve(port: int, token: bytes | None) -> None:
    import socket

    app = _load_app()
    configure(token=token, dev_insecure=token is None)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        sys.stderr.write("The development backend could not bind 127.0.0.1:8000.\n")
        raise SystemExit(2) from None
    sock.listen(128)
    chosen = sock.getsockname()[1]
    os.environ.pop("WEB_CONCURRENCY", None)
    config = uvicorn.Config(
        app,
        fd=sock.fileno(),
        workers=1,
        access_log=False,
        log_level="warning",
        lifespan="on",
    )
    class ReadyServer(uvicorn.Server):
        async def startup(self, sockets=None):  # type: ignore[override]
            await super().startup(sockets)
            if self.started and token is not None:
                sys.stdout.write(format_ready(token, chosen))
                sys.stdout.flush()

    server = ReadyServer(config)
    server.run()
    if not server.started:
        sys.stderr.write("The backend did not finish starting.\n")
        raise SystemExit(1)


def serve_secure(token: bytes) -> None:
    os.environ.pop("DOCXEDITOR_DEV_INSECURE", None)
    parent = os.getppid()
    _watch_parent(parent, sys.stdin.buffer)
    _serve(0, token)


def serve_dev_insecure() -> None:
    if getattr(sys, "frozen", False):
        sys.stderr.write("Insecure development mode is not available in the packaged app.\n")
        raise SystemExit(2)
    os.environ["DOCXEDITOR_DEV_INSECURE"] = "1"
    _serve(8000, None)


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--dev-insecure" in args:
        serve_dev_insecure()
        return
    if sys.stdin.isatty():
        sys.stderr.write("The backend starts only from the DocxEditor app.\n")
        raise SystemExit(2)
    line = sys.stdin.buffer.readline(128)
    token = parse_bootstrap(line)
    if token is None:
        raise SystemExit(2)
    serve_secure(token)


if __name__ == "__main__":
    main()
