import os
import re
from contextlib import asynccontextmanager
from urllib.parse import quote

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from fastapi import FastAPI, Query, UploadFile, File
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from .ai_service import process_chat, process_chat_stream
from .credentials import (
    CredentialStore,
    CredentialStoreError,
    InvalidProfileId,
    open_credential_store,
)
from .export_service import export_docx, export_docx_to_bytes
from .import_service import import_docx
from .legacy_config import default_config_path, migrate_legacy_config
from .provider_runtime import (
    InvalidBaseUrl,
    ResolvedProvider,
    concrete_base_url,
    concrete_model,
    redact,
)

# Vite devUrl is http://localhost:5173. Tauri 2.11 production webview origins,
# from the current custom-protocol docs: macOS and Linux use tauri://localhost;
# Windows uses http://tauri.localhost when useHttpsScheme is unset.
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "tauri://localhost",
    "http://tauri.localhost",
]

SECRET_FIELD_NAMES = {"api_key", "apikey", "apiKey", "authorization", "bearer"}


class HistoryTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str
    document: str = ""
    selection: str = ""
    history: list[HistoryTurn] = []
    profile_id: str
    provider: Literal["openai", "anthropic"]
    model: str = ""
    base_url: str = ""


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    html_content: str
    filename: str = "document.docx"
    page_settings: dict | None = None


class PutCredentialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    api_key: str = Field(min_length=1, max_length=4096)
    provider: Literal["openai", "anthropic"]


class RebindCredentialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Literal["openai", "anthropic"]


class TestCredentialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Literal["openai", "anthropic"]
    model: str = ""
    base_url: str = ""


def _store() -> CredentialStore:
    return app.state.credentials


def _env_get(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    text = value.strip()
    return text or None


def _resolve_provider(profile_id: str, provider: str, model: str, base_url: str) -> ResolvedProvider | None:
    resolved = _store().resolve(profile_id, provider)
    if resolved is None or not resolved.secret:
        return None
    return ResolvedProvider(
        provider=provider,
        api_key=resolved.secret,
        model=concrete_model(provider, model, _env_get),
        base_url=concrete_base_url(provider, base_url, _env_get),
        source=resolved.source,
    )


def _rejected_base_url() -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "invalid_base_url",
                "message": "Base URL was rejected. Use https, or http only for localhost.",
            }
        },
    )


def _missing_credential(profile_id: str, provider: str) -> JSONResponse:
    env_name = "OPENAI_API_KEY" if provider == "openai" else "ANTHROPIC_API_KEY"
    return JSONResponse(
        status_code=401,
        content={
            "error": {
                "code": "credential_missing",
                "provider": provider,
                "profile_id": profile_id,
                "message": (
                    f"No {provider} API key is available for this profile. "
                    f"Save a key for this profile, or set {env_name} on the backend process."
                ),
            }
        },
    )


def _validation_mentions_secret(exc: RequestValidationError) -> bool:
    for err in exc.errors():
        loc = err.get("loc") or ()
        for part in loc:
            if str(part) in SECRET_FIELD_NAMES or str(part).lower() in {"api_key", "apikey"}:
                return True
    return False


@asynccontextmanager
async def _lifespan(app: FastAPI):
    store = open_credential_store()
    app.state.credentials = store
    app.state.client_factory = None
    app.state.credential_tester = None
    app.state.legacy_migration = migrate_legacy_config(default_config_path(), store)
    yield


app = FastAPI(title="AI Document IDE Backend", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(RequestValidationError)
async def reject_invalid_request(_request, exc: RequestValidationError):
    if _validation_mentions_secret(exc):
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "secret_field_rejected",
                    "message": "api_key is not accepted on this route. Credentials are resolved on the server.",
                }
            },
        )
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "invalid_request", "message": "Request was rejected."}},
    )


@app.post("/api/chat")
async def chat(req: ChatRequest):
    try:
        spec = _resolve_provider(req.profile_id, req.provider, req.model, req.base_url)
    except InvalidBaseUrl:
        return _rejected_base_url()
    if spec is None:
        return _missing_credential(req.profile_id, req.provider)
    history = [turn.model_dump() for turn in req.history]
    return await process_chat(
        req.message,
        req.document,
        history,
        spec,
        selection=req.selection,
        client_factory=app.state.client_factory,
    )


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    try:
        spec = _resolve_provider(req.profile_id, req.provider, req.model, req.base_url)
    except InvalidBaseUrl:
        return _rejected_base_url()
    if spec is None:
        return _missing_credential(req.profile_id, req.provider)
    history = [turn.model_dump() for turn in req.history]
    return StreamingResponse(
        process_chat_stream(
            req.message,
            req.document,
            history,
            spec,
            selection=req.selection,
            client_factory=app.state.client_factory,
        ),
        media_type="text/event-stream",
    )


@app.post("/api/export")
async def export_doc(req: ExportRequest):
    filepath = export_docx(req.html_content, req.filename)
    return {"path": filepath}


def _content_disposition(filename: str) -> str:
    """HTTP headers are latin-1 only, so a non-ASCII filename is sent as RFC 5987 filename*."""
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


def _profile_or_400(profile_id: str):
    try:
        from .credentials import check_profile_id
        return check_profile_id(profile_id), None
    except InvalidProfileId:
        return None, JSONResponse(status_code=400, content={"error": {"code": "invalid_profile", "message": "Invalid profile id."}})


@app.put("/api/credentials/{profile_id}")
async def put_credential(profile_id: str, body: PutCredentialRequest):
    checked, error = _profile_or_400(profile_id)
    if error is not None:
        return error
    try:
        status = _store().put(checked, body.provider, body.api_key)
    except CredentialStoreError:
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "code": "credential_store_failed",
                    "message": "The credential could not be stored.",
                }
            },
        )
    return status.public_dict()


@app.get("/api/credentials/{profile_id}")
async def get_credential(profile_id: str, provider: Literal["openai", "anthropic"] = Query(...)):
    checked, error = _profile_or_400(profile_id)
    if error is not None:
        return error
    return _store().status(checked, provider).public_dict()


@app.delete("/api/credentials/{profile_id}")
async def delete_credential(
    profile_id: str,
    provider: Literal["openai", "anthropic"] = Query(...),
):
    checked, error = _profile_or_400(profile_id)
    if error is not None:
        return error
    try:
        status = _store().delete_profile(checked, provider)
    except CredentialStoreError:
        return JSONResponse(
            status_code=503,
            content={"error": {"code": "credential_store_failed", "message": "The credential could not be deleted."}},
        )
    return status.public_dict()


async def _default_tester(spec: ResolvedProvider) -> None:
    if spec.provider == "openai":
        from .ai_service import _default_openai_client
        client = _default_openai_client(spec)
        await client.models.list()
        return
    from .ai_service import _default_anthropic_client
    client = _default_anthropic_client(spec)
    await client.messages.create(
        model=spec.model,
        max_tokens=1,
        messages=[{"role": "user", "content": "OK"}],
    )


@app.post("/api/credentials/{profile_id}/rebind")
async def rebind_credential(profile_id: str, body: RebindCredentialRequest):
    checked, error = _profile_or_400(profile_id)
    if error is not None:
        return error
    try:
        status = _store().rebind_unscoped(checked, body.provider)
    except CredentialStoreError:
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "code": "credential_store_failed",
                    "message": "The existing credential could not be bound to this provider.",
                }
            },
        )
    return status.public_dict()


@app.post("/api/credentials/{profile_id}/test")
async def test_credential(profile_id: str, body: TestCredentialRequest):
    checked, error = _profile_or_400(profile_id)
    if error is not None:
        return error
    try:
        spec = _resolve_provider(checked, body.provider, body.model, body.base_url)
    except InvalidBaseUrl:
        return _rejected_base_url()
    if spec is None:
        return {"ok": False, "error": "No API key is configured for this profile."}
    tester = app.state.credential_tester or _default_tester
    try:
        await tester(spec)
    except Exception as exc:
        return {"ok": False, "error": redact(str(exc), spec.api_key)}
    return {"ok": True}


@app.get("/api/health")
async def health():
    migration = getattr(app.state, "legacy_migration", None)
    return {
        "status": "ok",
        "credential_storage": "keyring" if _store().keyring_available else "memory",
        "legacy_migration": None if migration is None else migration.status,
    }
