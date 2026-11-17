from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.access_routes import access_router
from app.api.auth_routes import auth_router
from app.api.bulk_routes import bulk_router
from app.api.drawing_routes import drawing_router
from app.api.export_routes import export_router
from app.api.lineage_routes import lineage_router
from app.api.routes import router
from app.api.search_routes import search_router
from app.core.access import enforce_project_access
from app.core.bootstrap import check_secret_key, ensure_bootstrap_admin
from app.core.config import settings
from app.core.security import get_current_user
from app.db import get_db


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    check_secret_key()
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
    # Paged lists report their size here; cross-origin frontends must be allowed to read it.
    expose_headers=["X-Total-Count"],
)

app.include_router(auth_router)
# Every data route is signed-in only and checked against the project it touches.
GUARDS = [Depends(get_current_user), Depends(enforce_project_access)]
# Before `router`: /parts/import-template must win over /parts/{part_id}.
app.include_router(bulk_router, dependencies=GUARDS)
app.include_router(access_router, dependencies=GUARDS)
app.include_router(router, dependencies=GUARDS)
app.include_router(drawing_router, dependencies=GUARDS)
app.include_router(export_router, dependencies=GUARDS)
app.include_router(search_router, dependencies=GUARDS)
app.include_router(lineage_router, dependencies=GUARDS)


@app.get("/health")
def health(db: Session = Depends(get_db)) -> JSONResponse:
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse(
            status_code=503, content={"status": "degraded", "database": "unreachable"}
        )
    return JSONResponse(content={"status": "ok", "database": "ok"})
