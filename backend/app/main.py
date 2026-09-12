import urllib.error
import urllib.request
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.auth_routes import auth_router
from app.api.drawing_routes import drawing_router
from app.api.routes import router
from app.core.bootstrap import ensure_bootstrap_admin, warn_if_insecure_defaults
from app.core.config import settings
from app.core.security import get_current_user
from app.db import get_db

VITE_ORIGIN = "http://127.0.0.1:5173"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    warn_if_insecure_defaults()
    ensure_bootstrap_admin()
    yield


app = FastAPI(
    title=settings.app_name,
    lifespan=lifespan,
    docs_url="/docs" if settings.expose_docs else None,
    redoc_url="/redoc" if settings.expose_docs else None,
    openapi_url="/openapi.json" if settings.expose_docs else None,
)


@app.exception_handler(IntegrityError)
async def handle_integrity_error(request: Request, exc: IntegrityError) -> JSONResponse:
    detail = "Request conflicts with existing data (duplicate or invalid reference)."
    return JSONResponse(status_code=409, content={"detail": detail})


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(router, dependencies=[Depends(get_current_user)])
app.include_router(drawing_router, dependencies=[Depends(get_current_user)])


@app.middleware("http")
async def strip_api_prefix(request: Request, call_next):
    """Accept nginx/Vite-style `/api/...` paths on the backend as well."""
    path = request.scope.get("path", "")
    if path == "/api" or path.startswith("/api/"):
        request.scope["path"] = path[4:] or "/"
        raw = request.scope.get("raw_path")
        if isinstance(raw, bytes) and raw.startswith(b"/api"):
            request.scope["raw_path"] = raw[4:] or b"/"
    return await call_next(request)


def _proxy_vite(request: Request) -> Response | None:
    dest = f"{VITE_ORIGIN}{request.url.path}"
    if request.url.query:
        dest = f"{dest}?{request.url.query}"
    try:
        forwarded = urllib.request.Request(
            dest,
            method="GET",
            headers={"Accept": request.headers.get("accept", "*/*")},
        )
        with urllib.request.urlopen(forwarded, timeout=2) as upstream:
            content_type = upstream.headers.get("Content-Type", "application/octet-stream")
            return Response(
                content=upstream.read(),
                status_code=upstream.status,
                headers={"Content-Type": content_type},
            )
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


@app.get("/", include_in_schema=False)
def root(request: Request) -> Response:
    proxied = _proxy_vite(request)
    if proxied is not None:
        return proxied
    return HTMLResponse(
        """<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>FSDP API</title></head>
  <body style="font-family:sans-serif;max-width:40rem;margin:3rem auto;line-height:1.5">
    <h1>FSDP API</h1>
    <p>The API is running. Open the web app on port <strong>5173</strong>.</p>
    <p><a href="/docs">API docs</a> · <a href="/health">Health</a></p>
  </body>
</html>
"""
    )


@app.get("/src/{_rest:path}", include_in_schema=False)
@app.get("/node_modules/{_rest:path}", include_in_schema=False)
@app.get("/@{_rest:path}", include_in_schema=False)
def vite_asset(_rest: str, request: Request) -> Response:
    proxied = _proxy_vite(request)
    if proxied is not None:
        return proxied
    return HTMLResponse("Vite dev server is not running on port 5173.", status_code=502)


@app.get("/health")
def health(db: Session = Depends(get_db)) -> JSONResponse:
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse(
            status_code=503, content={"status": "degraded", "database": "unreachable"}
        )
    return JSONResponse(content={"status": "ok", "database": "ok"})
