import os
import re
import json
from urllib.parse import quote
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, Response
from pydantic import BaseModel
from .ai_service import process_chat, process_chat_stream
from .export_service import export_docx, export_docx_to_bytes
from .import_service import import_docx

app = FastAPI(title="AI Document IDE Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    document: str = ""
    selection: str = ""
    history: list = []


class ExportRequest(BaseModel):
    html_content: str
    filename: str = "document.docx"
    page_settings: dict | None = None


class ConfigRequest(BaseModel):
    provider: str = "openai"
    api_key: str = ""
    model: str = ""
    base_url: str = ""


# Config store (overrides .env values when set). Persisted to disk so the
# API key survives backend restarts / app relaunches.
_CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".docxeditor", "config.json")
_runtime_config: dict = {}


def _set_env(name: str, value: str):
    """Set an env var, or remove it so code falls back to defaults."""
    if value:
        os.environ[name] = value
    else:
        os.environ.pop(name, None)


def _apply_config_to_env():
    provider = _runtime_config.get("provider", "openai")
    prefix = "OPENAI" if provider == "openai" else "ANTHROPIC"
    if _runtime_config.get("api_key"):
        os.environ[f"{prefix}_API_KEY"] = _runtime_config["api_key"]
    _set_env(f"{prefix}_MODEL", _runtime_config.get("model", ""))
    _set_env(f"{prefix}_BASE_URL", _runtime_config.get("base_url", ""))


def _save_config_to_disk():
    try:
        os.makedirs(os.path.dirname(_CONFIG_PATH), exist_ok=True)
        with open(_CONFIG_PATH, "w") as f:
            json.dump(_runtime_config, f)
    except OSError:
        pass


def _load_config_from_disk():
    try:
        with open(_CONFIG_PATH) as f:
            saved = json.load(f)
    except (OSError, ValueError):
        return
    if isinstance(saved, dict):
        _runtime_config.update({k: v for k, v in saved.items() if v})
        if _runtime_config.get("api_key"):
            _apply_config_to_env()


_load_config_from_disk()


@app.post("/api/chat")
async def chat(req: ChatRequest):
    provider = _runtime_config.get("provider")
    result = await process_chat(req.message, req.document, req.history, provider=provider, selection=req.selection)
    return result


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    provider = _runtime_config.get("provider")
    return StreamingResponse(
        process_chat_stream(req.message, req.document, req.history, provider=provider, selection=req.selection),
        media_type="text/event-stream",
    )


@app.post("/api/export")
async def export_doc(req: ExportRequest):
    filepath = export_docx(req.html_content, req.filename)
    return {"path": filepath}


def _content_disposition(filename: str) -> str:
    """HTTP headers are latin-1 only, so a Chinese (or any non-ASCII) filename
    must be sent as an RFC 5987 `filename*` parameter with an ASCII fallback,
    otherwise Starlette raises UnicodeEncodeError and the export 500s."""
    ascii_name = re.sub(r"[^\x20-\x7e]", "_", filename).replace('"', "_").strip() or "document.docx"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


@app.post("/api/export/download")
async def export_download(req: ExportRequest):
    data = export_docx_to_bytes(req.html_content, page_settings=req.page_settings)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": _content_disposition(req.filename)},
    )


@app.post("/api/import")
async def import_doc(file: UploadFile = File(...)):
    content = await file.read()
    html = import_docx(content)
    return {"html": html, "filename": file.filename}


@app.get("/api/config")
async def get_config():
    provider = _runtime_config.get("provider", "")
    has_key = bool(_runtime_config.get("api_key") or os.getenv("OPENAI_API_KEY") or os.getenv("ANTHROPIC_API_KEY"))
    # Show a hint of the key (first 7 chars masked) if set
    key_hint = ""
    raw_key = _runtime_config.get("api_key", "")
    if raw_key:
        key_hint = raw_key[:7] + "..." if len(raw_key) > 7 else "***"
    elif not provider or provider == "openai":
        env_key = os.getenv("OPENAI_API_KEY", "")
        if env_key:
            key_hint = env_key[:7] + "..." if len(env_key) > 7 else "***"
            provider = "openai"
    elif provider == "anthropic":
        env_key = os.getenv("ANTHROPIC_API_KEY", "")
        if env_key:
            key_hint = env_key[:7] + "..." if len(env_key) > 7 else "***"

    if not provider:
        if os.getenv("ANTHROPIC_API_KEY"):
            provider = "anthropic"
        else:
            provider = "openai"

    model = _runtime_config.get("model", "")
    base_url = _runtime_config.get("base_url", "")

    return {"provider": provider, "has_key": has_key, "key_hint": key_hint, "model": model, "base_url": base_url}


@app.post("/api/config")
async def set_config(req: ConfigRequest):
    _runtime_config["provider"] = req.provider
    # An empty api_key means "keep the previously saved key" (the UI sends
    # empty when the user didn't type a new key over the masked hint).
    if req.api_key:
        _runtime_config["api_key"] = req.api_key
    _runtime_config["model"] = req.model
    _runtime_config["base_url"] = req.base_url

    _apply_config_to_env()
    _save_config_to_disk()
    return {"status": "ok"}


@app.get("/api/health")
async def health():
    return {"status": "ok"}
