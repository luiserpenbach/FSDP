"""Global search across projects: tags, lines, drawings, parts, requirements, systems."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.core.access import hidden_project_ids
from app.core.security import get_current_user
from app.db import get_db
from app.models import (
    Drawing,
    DrawingSheet,
    FluidSystem,
    Part,
    Project,
    Requirement,
    SheetItem,
    SheetLine,
    User,
)
from app.schemas import SearchRead

search_router = APIRouter()

# Result order between kinds when two hits match equally well.
KIND_ORDER = ["tag", "line", "drawing", "part", "requirement", "system", "project"]


def _like(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _matches(column, term: str):
    return func.lower(column).like(_like(term), escape="\\")


def _rank(column, term: str):
    """0 exact, 1 prefix, 2 anywhere in the primary column, 3 only in a secondary one."""
    lowered = func.lower(column)
    return case(
        (lowered == term, 0),
        (lowered.like(_like(term)[1:], escape="\\"), 1),
        (lowered.like(_like(term), escape="\\"), 2),
        else_=3,
    )


def _first_line(text: str | None) -> str:
    return (text or "").split("\n", 1)[0].strip()


def _join(*parts: str | None) -> str:
    return " · ".join(part for part in parts if part)


@search_router.get("/search", response_model=SearchRead)
def search(
    q: str = Query(default="", max_length=120),
    project_id: str | None = None,
    limit: int = Query(default=8, ge=1, le=50),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Find anything by tag, number, or name, in the projects the user may see.

    `limit` caps the hits per kind. `project_id` only affects ordering: hits in
    that project come first, so the palette favours the project being worked on.
    """
    term = q.strip().lower()
    if len(term) < 2:
        return {"query": q.strip(), "hits": []}

    scored: list[tuple[int, dict]] = []
    # Restricted projects the user is not a member of stay out of every query.
    hidden = hidden_project_ids(db, user)

    def collect(rows, build) -> None:
        for row in rows:
            scored.append((row[-1], build(*row[:-1])))

    rank = _rank(SheetItem.tag, term)
    collect(
        db.execute(
            select(SheetItem, DrawingSheet, Drawing, Project.name, rank)
            .join(DrawingSheet, SheetItem.sheet_id == DrawingSheet.id)
            .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
            .join(Project, Drawing.project_id == Project.id)
            .where(
                or_(_matches(SheetItem.tag, term), _matches(SheetItem.label, term)),
                Project.id.notin_(hidden),
            )
            .order_by(rank, SheetItem.tag)
            .limit(limit)
        ).all(),
        lambda item, sheet, drawing, project_name: {
            "kind": "tag",
            "id": item.id,
            "title": item.tag or item.label or item.symbol_name or "Untagged item",
            "subtitle": _join(
                item.symbol_name or item.category,
                item.label if item.tag else None,
                f"{drawing.number} sheet {sheet.sheet_no}",
                f"zone {item.zone}" if item.zone else None,
            ),
            "status": drawing.status,
            "project_id": drawing.project_id,
            "project_name": project_name,
            "system_id": drawing.system_id,
            "drawing_id": drawing.id,
            "sheet_id": sheet.id,
            "item_id": item.item_id,
        },
    )

    rank = _rank(SheetLine.line_number, term)
    collect(
        db.execute(
            select(SheetLine, DrawingSheet, Drawing, Project.name, rank)
            .join(DrawingSheet, SheetLine.sheet_id == DrawingSheet.id)
            .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
            .join(Project, Drawing.project_id == Project.id)
            .where(_matches(SheetLine.line_number, term), Project.id.notin_(hidden))
            .order_by(rank, SheetLine.line_number)
            .limit(limit)
        ).all(),
        lambda line, sheet, drawing, project_name: {
            "kind": "line",
            "id": line.id,
            "title": line.line_number,
            "subtitle": _join(
                line.service,
                line.size,
                line.line_class,
                f"{drawing.number} sheet {sheet.sheet_no}",
            ),
            "status": drawing.status,
            "project_id": drawing.project_id,
            "project_name": project_name,
            "system_id": drawing.system_id,
            "drawing_id": drawing.id,
            "sheet_id": sheet.id,
            "item_id": line.line_id,
        },
    )

    rank = _rank(Drawing.number, term)
    collect(
        db.execute(
            select(Drawing, Project.name, rank)
            .join(Project, Drawing.project_id == Project.id)
            .where(
                or_(_matches(Drawing.number, term), _matches(Drawing.title, term)),
                Project.id.notin_(hidden),
            )
            .order_by(rank, Drawing.number)
            .limit(limit)
        ).all(),
        lambda drawing, project_name: {
            "kind": "drawing",
            "id": drawing.id,
            "title": drawing.number,
            "subtitle": _first_line(drawing.title),
            "status": drawing.status,
            "project_id": drawing.project_id,
            "project_name": project_name,
            "system_id": drawing.system_id,
            "drawing_id": drawing.id,
        },
    )

    rank = _rank(Part.part_number, term)
    collect(
        db.execute(
            select(Part, rank)
            .where(
                or_(
                    _matches(Part.part_number, term),
                    _matches(Part.description, term),
                    _matches(Part.manufacturer, term),
                )
            )
            .order_by(rank, Part.part_number)
            .limit(limit)
        ).all(),
        lambda part: {
            "kind": "part",
            "id": part.id,
            "title": part.part_number,
            "subtitle": _join(_first_line(part.description), part.manufacturer),
            "status": part.lifecycle_status,
        },
    )

    rank = _rank(Requirement.key, term)
    collect(
        db.execute(
            select(Requirement, Project.name, rank)
            .join(Project, Requirement.project_id == Project.id)
            .where(
                or_(_matches(Requirement.key, term), _matches(Requirement.title, term)),
                Project.id.notin_(hidden),
            )
            .order_by(rank, Requirement.key)
            .limit(limit)
        ).all(),
        lambda requirement, project_name: {
            "kind": "requirement",
            "id": requirement.id,
            "title": requirement.key,
            "subtitle": requirement.title,
            "status": requirement.status,
            "project_id": requirement.project_id,
            "project_name": project_name,
        },
    )

    rank = _rank(FluidSystem.name, term)
    collect(
        db.execute(
            select(FluidSystem, Project.name, rank)
            .join(Project, FluidSystem.project_id == Project.id)
            .where(_matches(FluidSystem.name, term), Project.id.notin_(hidden))
            .order_by(rank, FluidSystem.name)
            .limit(limit)
        ).all(),
        lambda system, project_name: {
            "kind": "system",
            "id": system.id,
            "title": system.name,
            "subtitle": system.fluid or "",
            "project_id": system.project_id,
            "project_name": project_name,
            "system_id": system.id,
        },
    )

    rank = _rank(Project.name, term)
    collect(
        db.execute(
            select(Project, rank)
            .where(_matches(Project.name, term), Project.id.notin_(hidden))
            .order_by(rank, Project.name)
            .limit(limit)
        ).all(),
        lambda project: {
            "kind": "project",
            "id": project.id,
            "title": project.name,
            "subtitle": _first_line(project.description),
            "project_id": project.id,
            "project_name": project.name,
        },
    )

    def sort_key(entry: tuple[int, dict]) -> tuple[int, int, int]:
        score, hit = entry
        elsewhere = int(bool(project_id) and hit.get("project_id") not in (None, project_id))
        return (score, elsewhere, KIND_ORDER.index(hit["kind"]))

    scored.sort(key=sort_key)
    return {"query": q.strip(), "hits": [hit for _, hit in scored]}
