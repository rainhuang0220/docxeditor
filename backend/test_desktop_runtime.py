"""Process-level desktop backend tests. These start the real server, not TestClient."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .desktop_runtime import accept_ready, format_ready, parse_bootstrap

ROOT = Path(__file__).resolve().parents[1]
SENTINEL = "DOCXEDITOR_SECRET_SENTINEL_9f2c"
TOKEN = bytes(range(32))
OTHER = bytes((index + 7) % 256 for index in range(32))


def _readline(stream, seconds: float) -> bytes | None:
    box: dict[str, bytes] = {}

    def read() -> None:
        box["line"] = stream.readline()

    thread = threading.Thread(target=read, daemon=True)
    thread.start()
    thread.join(seconds)
    if thread.is_alive():
        return None
    return box.get("line")


class Backend:
    def __init__(self, proc: subprocess.Popen, port: int, token: bytes, output: str):
        self.proc = proc
        self.port = port
        self.token = token
        self.output = output

    def close(self) -> None:
        if self.proc.stdin:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=3)

    def request(self, method: str, path: str, body: bytes | None = None, token: bytes | None = None, origin: str | None = None, headers: dict | None = None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=body, method=method)
        if token is not None:
            req.add_header("Authorization", f"Bearer {token.hex()}")
        if origin:
            req.add_header("Origin", origin)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=8) as response:
                payload = response.read()
                return response.status, dict(response.headers), payload
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()


def start(tmp: Path, token: bytes = TOKEN, command: list[str] | None = None, extra: dict | None = None) -> Backend:
    tmp.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.pop("DOCXEDITOR_DEV_INSECURE", None)
    for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"):
        env.pop(name, None)
    env["DOCXEDITOR_KEYRING"] = "disabled"
    env["DOCXEDITOR_CONFIG_PATH"] = str(tmp / "config.json")
    env["DOCXEDITOR_TEST_HOOKS"] = "1"
    env["DOCXEDITOR_DRIP_MARKER"] = str(tmp / "drip.txt")
    env.update(extra or {})
    proc = subprocess.Popen(
        command or [sys.executable, "-m", "backend.desktop_runtime"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd=ROOT,
    )
    assert proc.stdin and proc.stdout and proc.stderr
    threading.Thread(target=proc.stderr.read, daemon=True).start()
    proc.stdin.write(f"v1 {token.hex()}\n".encode("ascii"))
    proc.stdin.flush()
    line = _readline(proc.stdout, 20)
    stderr = b""
    if line is None:
        proc.kill()
        stderr = proc.stderr.read()
        raise AssertionError(f"backend did not become ready\n{stderr.decode('utf-8', 'replace')}")
    text = line.decode("ascii", errors="replace")
    port = accept_ready(text, token)
    if port is None:
        proc.kill()
        raise AssertionError(f"handshake rejected: {text!r}")
    return Backend(proc, port, token, text)


def test_handshake_rejects_a_healthy_impostor():
    assert parse_bootstrap(b"v1 " + b"aa" * 32 + b"\n") is not None
    assert parse_bootstrap(b"v1 short\n") is None
    line = format_ready(TOKEN, 4321)
    assert accept_ready(line, TOKEN) == 4321
    assert accept_ready(line, OTHER) is None
    assert accept_ready('HTTP/1.1 200 {"status":"ok"}\n', TOKEN) is None
    forged = f"READY v1 4321 {'ab' * 32}\n"
    assert accept_ready(forged, TOKEN) is None


def test_process_authentication(tmp: Path):
    squatter = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    squatter.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
    occupied = False
    try:
        squatter.bind(("127.0.0.1", 8000))
        squatter.listen(1)
        squatter.settimeout(0.2)
        occupied = True
    except OSError:
        squatter.close()
        squatter = None
    backend = start(tmp)
    try:
        assert backend.port != 8000
        if occupied and squatter is not None:
            try:
                squatter.accept()
                raise AssertionError("the desktop backend connected to the unrelated server")
            except TimeoutError:
                pass
            except socket.timeout:
                pass
        status, _headers, body = backend.request("GET", "/api/health")
        assert status == 401
        assert SENTINEL not in body.decode()
        assert TOKEN.hex() not in body.decode()
        status, _headers, body = backend.request("GET", "/api/health", token=backend.token, origin="tauri://localhost")
        assert status == 200
        assert json.loads(body)["status"] == "ok"
        status, _headers, _body = backend.request("GET", "/api/credentials/profile-a?provider=openai", origin="tauri://localhost")
        assert status == 401
        status, _headers, saved = backend.request(
            "PUT",
            "/api/credentials/profile-a",
            body=json.dumps({"api_key": SENTINEL, "provider": "openai"}).encode(),
            token=backend.token,
            headers={"Content-Type": "application/json"},
        )
        assert status == 200
        assert SENTINEL not in saved.decode()
        status, _headers, denied = backend.request("DELETE", "/api/credentials/profile-a?provider=openai", origin="https://evil.example")
        assert status == 401
        status, _headers, still = backend.request("GET", "/api/credentials/profile-a?provider=openai", token=backend.token)
        assert status == 200
        assert json.loads(still)["has_key"] is True
        assert json.loads(still)["mode"] == "memory"
        assert json.loads(still)["persistent"] is False
        assert SENTINEL not in still.decode()
        status, _headers, tested = backend.request(
            "POST",
            "/api/credentials/missing/test",
            body=b'{"provider":"openai"}',
            token=backend.token,
            headers={"Content-Type": "application/json"},
        )
        assert status == 200
        assert json.loads(tested)["ok"] is False
        status, _headers, _removed = backend.request("DELETE", "/api/credentials/profile-a?provider=openai", token=backend.token)
        assert status == 200
        status, _headers, gone = backend.request("GET", "/api/credentials/profile-a?provider=openai", token=backend.token)
        assert json.loads(gone)["has_key"] is False
        assert not (tmp / "config.json").exists() or SENTINEL not in (tmp / "config.json").read_text()
    finally:
        backend.close()
        if squatter is not None:
            squatter.close()


def test_restart_and_second_instance(tmp: Path):
    first = start(tmp)
    second = start(tmp / "two", OTHER)
    try:
        assert first.port != second.port
        status, _headers, _body = first.request("GET", "/api/health", token=second.token)
        assert status == 401
        status, _headers, _body = second.request("GET", "/api/health", token=first.token)
        assert status == 401
        status, _headers, body = first.request("GET", "/api/health", token=first.token)
        assert status == 200
        assert TOKEN.hex() not in body.decode()
    finally:
        first.close()
        second.close()
    old = first.token
    restarted = start(tmp, OTHER)
    try:
        status, _headers, _body = restarted.request("GET", "/api/health", token=old)
        assert status == 401
        status, _headers, _body = restarted.request("GET", "/api/health", token=OTHER)
        assert status == 200
    finally:
        restarted.close()


def test_stream_and_documents(tmp: Path):
    import httpx
    from docx import Document
    import io

    backend = start(tmp)
    try:
        started = time.monotonic()
        with httpx.stream(
            "GET",
            f"http://127.0.0.1:{backend.port}/api/test/drip",
            headers={"Authorization": f"Bearer {backend.token.hex()}"},
            timeout=10,
        ) as response:
            assert response.status_code == 200
            first = next(response.iter_text())
            assert "data: 0" in first
            assert "data: 5" not in first
            assert time.monotonic() - started < 1
            response.close()
        deadline = time.monotonic() + 3
        marker = tmp / "drip.txt"
        while time.monotonic() < deadline and not marker.exists():
            time.sleep(0.05)
        assert marker.read_text() == "closed"

        document = Document()
        document.add_paragraph("Hello desktop")
        buffer = io.BytesIO()
        document.save(buffer)
        files = {"file": ("note.docx", buffer.getvalue(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}
        imported = httpx.post(
            f"http://127.0.0.1:{backend.port}/api/import",
            files=files,
            headers={"Authorization": f"Bearer {backend.token.hex()}"},
            timeout=10,
        )
        assert imported.status_code == 200
        assert "Hello desktop" in imported.json()["html"]
        denied = httpx.post(f"http://127.0.0.1:{backend.port}/api/import", files=files, timeout=10)
        assert denied.status_code == 401
        exported = httpx.post(
            f"http://127.0.0.1:{backend.port}/api/export/download",
            json={"html_content": "<p>Hello desktop</p>", "filename": "../secret.docx"},
            headers={"Authorization": f"Bearer {backend.token.hex()}"},
            timeout=10,
        )
        assert exported.status_code == 200
        assert exported.content.startswith(b"PK\x03\x04")
        leaked = (tmp / "config.json")
        output = backend.output
        assert backend.token.hex() not in output
        assert SENTINEL not in output
        if leaked.exists():
            assert SENTINEL not in leaked.read_text()
    finally:
        backend.close()


def test_parent_exit_stops_the_child(tmp: Path):
    tmp.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.pop("DOCXEDITOR_DEV_INSECURE", None)
    env["DOCXEDITOR_KEYRING"] = "disabled"
    env["DOCXEDITOR_CONFIG_PATH"] = str(tmp / "config.json")
    wrapper = tmp / "wrapper.py"
    pidfile = tmp / "child.pid"
    token_line = f"v1 {TOKEN.hex()}\n".encode("ascii")
    wrapper.write_text(
        "import os, subprocess, sys\n"
        f"env = {env!r}\n"
        "p = subprocess.Popen([sys.executable, '-m', 'backend.desktop_runtime'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, cwd="
        f"{str(ROOT)!r})\n"
        "assert p.stdin and p.stdout\n"
        f"p.stdin.write({token_line!r})\n"
        "p.stdin.flush()\n"
        "line = p.stdout.readline()\n"
        "if not line:\n"
        "    raise SystemExit('no handshake')\n"
        f"open({str(pidfile)!r}, 'w').write(str(p.pid))\n"
        "os._exit(0)\n",
    )
    subprocess.run([sys.executable, str(wrapper)], cwd=ROOT, check=True, timeout=25)
    pid = int(pidfile.read_text())
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            return
        time.sleep(0.1)
    raise AssertionError(f"child {pid} survived parent exit")


def test_packaged_binary_if_present(tmp: Path):
    binary = os.environ.get("DOCXEDITOR_SIDECAR_BIN")
    if not binary:
        print("SKIP: packaged sidecar binary not built")
        return
    path = Path(binary)
    blob = path.read_bytes()
    assert SENTINEL.encode() not in blob
    refused = subprocess.run(
        [str(path), "--dev-insecure"],
        env={"PATH": "/usr/bin:/bin", "DOCXEDITOR_DEV_INSECURE": "1"},
        capture_output=True,
        timeout=40,
        check=False,
    )
    assert refused.returncode != 0
    env_path = str(ROOT / ".env")
    if Path(env_path).exists():
        secret_lines = [line.split("=", 1)[1].strip() for line in Path(env_path).read_text().splitlines() if line.startswith("OPENAI_API_KEY=") or line.startswith("ANTHROPIC_API_KEY=")]
        for secret in secret_lines:
            if len(secret) > 8:
                assert secret.encode() not in blob
    backend = start(tmp, command=[str(path)], extra={"PATH": "/usr/bin:/bin"})
    try:
        status, _headers, body = backend.request("GET", "/api/health", token=backend.token)
        assert status == 200
        assert TOKEN.hex() not in body.decode()
        status, _headers, _body = backend.request("PUT", "/api/credentials/profile-a", body=b'{"api_key":"x","provider":"openai"}')
        assert status == 401
    finally:
        backend.close()


def test_capabilities_and_csp():
    capabilities = json.loads((ROOT / "src-tauri" / "capabilities" / "default.json").read_text())
    text = json.dumps(capabilities)
    assert "shell:allow-spawn" not in text
    assert "shell:allow-execute" not in text
    csp = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text())["app"]["security"]["csp"]["connect-src"]
    assert "http://127.0.0.1:8000" not in csp


def main():
    test_handshake_rejects_a_healthy_impostor()
    test_capabilities_and_csp()
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        test_process_authentication(root / "a")
        (root / "a").mkdir(exist_ok=True)
        test_restart_and_second_instance(root / "b")
        test_stream_and_documents(root / "c")
        test_parent_exit_stops_the_child(root / "d")
        test_packaged_binary_if_present(root / "e")
    print("PASS: desktop runtime")


if __name__ == "__main__":
    main()
