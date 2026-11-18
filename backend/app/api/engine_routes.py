"""Server-side re-index: refresh stale sheet indexes and DRC with the engine CLI."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.routes import require_model
from app.core.security import require_writer
from app.db import get_db
from app.models import Drawing, Project, User
from app.schemas import EngineStatusRead, ReindexRead
from app.services.server_index import (
    EngineNotConfigured,
    engine_status,
    reindex_drawings,
    reindex_project,
    stale_drawing_ids,
)
from app.services.sheet_index import stale_sheets

engine_router = APIRouter()

ENGINE_OFF = (
    "Server-side re-indexing is not configured on this server (FSDP_ENGINE_CLI); "
    "open the drawing in Drafting to re-index its sheets."
)


@engine_router.get("/engine/status", response_model=EngineStatusRead)
def get_engine_status() -> dict:
    """Whether this server can index and check sheets itself."""
    return engine_status()


def _require_engine() -> None:
    if not engine_status()["enabled"]:
        raise HTTPException(status_code=503, detail=ENGINE_OFF)


def _response(db: Session, report, drawing_ids: list[str]) -> dict:
    return {**report.as_dict(), "stale_sheets": stale_sheets(db, drawing_ids)}


@engine_router.post("/projects/{project_id}/reindex", response_model=ReindexRead)
def reindex_project_sheets(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    """Re-index every stale sheet of the project's unreleased drawings."""
    require_model(db, Project, project_id)
    _require_engine()
    drawing_ids = stale_drawing_ids(db, project_id=project_id)
    try:
        report = reindex_project(db, project_id, actor=user.email)
    except EngineNotConfigured as exc:
        raise HTTPException(status_code=503, detail=ENGINE_OFF) from exc
    return _response(db, report, drawing_ids)


@engine_router.post("/drawings/{drawing_id}/reindex", response_model=ReindexRead)
def reindex_drawing_sheets(
    drawing_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    """Re-index the stale sheets of one drawing (409 for a released drawing)."""
    drawing = require_model(db, Drawing, drawing_id)
    _require_engine()
    if drawing.status == "released":
        raise HTTPException(
            status_code=409,
            detail=f"Drawing {drawing.number} is released; its index is a frozen baseline.",
        )
    try:
        report = reindex_drawings(db, [drawing_id], actor=user.email)
    except EngineNotConfigured as exc:
        raise HTTPException(status_code=503, detail=ENGINE_OFF) from exc
    return _response(db, report, [drawing_id])
