import os
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from .ai_service import process_chat, process_chat_stream
from .export_service import export_docx
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


class ConfigRequest(BaseModel):
    provider: str = "openai"
    api_key: str = ""


# In-memory config store (overrides .env values when set)
_runtime_config: dict = {}


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


@app.post("/api/export/download")
async def export_download(req: ExportRequest):
    filepath = export_docx(req.html_content, req.filename)
    return FileResponse(filepath, filename=req.filename, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")


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

    return {"provider": provider, "has_key": has_key, "key_hint": key_hint}


@app.post("/api/config")
async def set_config(req: ConfigRequest):
    _runtime_config["provider"] = req.provider
    _runtime_config["api_key"] = req.api_key
    # Also set as env var so ai_service picks it up
    if req.provider == "openai":
        os.environ["OPENAI_API_KEY"] = req.api_key
    elif req.provider == "anthropic":
        os.environ["ANTHROPIC_API_KEY"] = req.api_key
    return {"status": "ok"}


@app.get("/api/health")
async def health():
    return {"status": "ok"}
