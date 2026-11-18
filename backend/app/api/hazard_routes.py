"""Safety register: hazards of a project, linked to drawing items and requirements.

Links are ordinary trace links with the hazard as source (`source_type="hazard"`),
created through `POST /trace-links`; they are returned with each hazard and
removed when the hazard is deleted.
"""

from __future__ import annotations

import re
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes import record_change, require_model
from app.core.security import require_writer
from app.db import get_db
from app.models import Hazard, Project, TraceLink, User
from app.schemas import HazardCreate, HazardRead, HazardUpdate, TraceLinkRead
from app.services.traceability import delete_trace_links_for

hazard_router = APIRouter()

HAZARD_KEY_PREFIX = "HAZ-"
_AUTO_KEY = re.compile(r"^HAZ-(\d+)$", re.IGNORECASE)


def next_hazard_key(db: Session, project_id: str) -> str:
    """Next free HAZ-nnn of the project: one above the highest number in use."""
    highest = 0
    for key in db.scalars(select(Hazard.key).where(Hazard.project_id == project_id)):
        match = _AUTO_KEY.match(key)
        if match:
            highest = max(highest, int(match.group(1)))
    return f"{HAZARD_KEY_PREFIX}{highest + 1:03d}"


def _key_taken(db: Session, project_id: str, key: str, exclude_id: str | None = None) -> bool:
    query = select(Hazard.id).where(Hazard.project_id == project_id, Hazard.key == key)
    if exclude_id is not None:
        query = query.where(Hazard.id != exclude_id)
    return db.scalar(query) is not None


def _read(hazard: Hazard, links: list[TraceLink]) -> HazardRead:
    read = HazardRead.model_validate(hazard)
    read.links = [TraceLinkRead.model_validate(link) for link in links]
    return read


def _links_by_hazard(db: Session, hazard_ids: list[str]) -> dict[str, list[TraceLink]]:
    grouped: dict[str, list[TraceLink]] = defaultdict(list)
    if not hazard_ids:
        return grouped
    links = db.scalars(
        select(TraceLink)
        .where(TraceLink.source_type == "hazard", TraceLink.source_id.in_(hazard_ids))
        .order_by(TraceLink.created_at, TraceLink.id)
    )
    for link in links:
        grouped[link.source_id].append(link)
    return grouped


@hazard_router.get("/projects/{project_id}/hazards", response_model=list[HazardRead])
def list_hazards(project_id: str, db: Session = Depends(get_db)) -> list[HazardRead]:
    require_model(db, Project, project_id)
    hazards = list(
        db.scalars(select(Hazard).where(Hazard.project_id == project_id).order_by(Hazard.key))
    )
    links = _links_by_hazard(db, [hazard.id for hazard in hazards])
    return [_read(hazard, links.get(hazard.id, [])) for hazard in hazards]


@hazard_router.post(
    "/projects/{project_id}/hazards", response_model=HazardRead, status_code=201
)
def create_hazard(
    project_id: str,
    payload: HazardCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> HazardRead:
    require_model(db, Project, project_id)
    data = payload.model_dump()
    key = data.pop("key") or next_hazard_key(db, project_id)
    if _key_taken(db, project_id, key):
        raise HTTPException(status_code=409, detail="Hazard key already exists in project")
    hazard = Hazard(project_id=project_id, key=key, **data)
    db.add(hazard)
    db.flush()
    record_change(
        db, "hazard", hazard.id, "created", f"Created hazard {hazard.key}", actor=user.email
    )
    db.commit()
    db.refresh(hazard)
    return _read(hazard, [])


@hazard_router.put("/hazards/{hazard_id}", response_model=HazardRead)
def update_hazard(
    hazard_id: str,
    payload: HazardUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> HazardRead:
    hazard = require_model(db, Hazard, hazard_id)
    changes = payload.model_dump(exclude_unset=True)
    # Required columns: an explicit null leaves them as they are.
    for field in ("key", "title", "category", "severity", "likelihood", "status"):
        if field in changes and changes[field] is None:
            del changes[field]
    if "key" in changes and _key_taken(db, hazard.project_id, changes["key"], hazard.id):
        raise HTTPException(status_code=409, detail="Hazard key already exists in project")
    for field, value in changes.items():
        setattr(hazard, field, value)
    record_change(
        db, "hazard", hazard.id, "updated", f"Updated hazard {hazard.key}", actor=user.email
    )
    db.commit()
    db.refresh(hazard)
    return _read(hazard, _links_by_hazard(db, [hazard.id]).get(hazard.id, []))


@hazard_router.delete("/hazards/{hazard_id}", status_code=204)
def delete_hazard(
    hazard_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    hazard = require_model(db, Hazard, hazard_id)
    delete_trace_links_for(db, "hazard", hazard.id)
    record_change(
        db, "hazard", hazard.id, "deleted", f"Deleted hazard {hazard.key}", actor=user.email
    )
    db.delete(hazard)
    db.commit()
    return Response(status_code=204)
