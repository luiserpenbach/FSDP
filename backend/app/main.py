from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from app.api.auth_routes import auth_router
from app.api.routes import router
from app.core.bootstrap import ensure_bootstrap_admin, warn_if_insecure_defaults
from app.core.config import settings
from app.core.security import get_current_user


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    warn_if_insecure_defaults()
    ensure_bootstrap_admin()
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)


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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
