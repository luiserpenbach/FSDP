"""Template lineage of drawings: source, copies, and the diff against the source."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.routes import require_model
from app.core.access import can_read_project, hidden_project_ids
from app.core.security import get_current_user
from app.db import get_db
from app.models import Drawing, Project, User
from app.schemas import LineageDiffRead, LineageRead
from app.services.lineage import lineage_diff

lineage_router = APIRouter()


def _summary(drawing: Drawing, project_name: str) -> dict:
    revision = drawing.current_revision
    return {
        "id": drawing.id,
        "number": drawing.number,
        "title": drawing.title.split("\n", 1)[0],
        "status": drawing.status,
        "revision": revision.label if revision else None,
        "project_id": drawing.project_id,
        "project_name": project_name,
        "created_at": drawing.created_at,
    }


def _visible_source(db: Session, user: User, drawing: Drawing) -> Drawing | None:
    """The source drawing, if it still exists and the user may see its project."""
    if not drawing.copied_from_id:
        return None
    source = db.scalar(
        select(Drawing)
        .where(Drawing.id == drawing.copied_from_id)
        .options(selectinload(Drawing.revisions))
    )
    if source is None:
        return None
    project = db.get(Project, source.project_id)
    return source if project and can_read_project(db, user, project) else None


@lineage_router.get("/drawings/{drawing_id}/lineage", response_model=LineageRead)
def get_lineage(
    drawing_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    drawing = require_model(db, Drawing, drawing_id)
    names = dict(db.execute(select(Project.id, Project.name)).all())
    source = _visible_source(db, user, drawing)
    hidden = hidden_project_ids(db, user)
    copies = db.scalars(
        select(Drawing)
        .where(Drawing.copied_from_id == drawing.id, Drawing.project_id.notin_(hidden))
        .options(selectinload(Drawing.revisions))
        .order_by(Drawing.created_at)
    )
    source_revision = source.current_revision.label if source and source.current_revision else None
    return {
        "drawing_id": drawing.id,
        "source": _summary(source, names.get(source.project_id, "")) if source else None,
        "copied_from_number": drawing.copied_from_number,
        "copied_from_revision": drawing.copied_from_revision,
        "source_revision_changed": bool(source and source_revision != drawing.copied_from_revision),
        "copies": [_summary(entry, names.get(entry.project_id, "")) for entry in copies],
    }


@lineage_router.get(
    "/drawings/{drawing_id}/lineage/diff",
    response_model=LineageDiffRead,
    response_model_by_alias=True,
)
def get_lineage_diff(
    drawing_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """How this copy differs from its source as both stand now (tags, parts, line data)."""
    drawing = require_model(db, Drawing, drawing_id)
    source = _visible_source(db, user, drawing)
    if source is None:
        raise HTTPException(
            status_code=404, detail="This drawing has no source drawing to compare with."
        )
    return lineage_diff(db, drawing, source)
