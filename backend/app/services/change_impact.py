"""What a change to a part or requirement touches.

Legacy diagrams report component instances and their BoM snapshots; drawings
report the sheet items (tags) bound to the part, the drawings they sit on, the
drawing BoM snapshots that contain the part, and the requirements traced to
those items or drawings.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    BomSnapshot,
    ComponentInstance,
    Drawing,
    DrawingSheet,
    DrcRequirementCheck,
    Part,
    Requirement,
    SheetItem,
    TraceLink,
)
from app.services.traceability import get_trace_links

ItemRow = tuple[SheetItem, DrawingSheet, Drawing]


def _linked_ids(links: Iterable[TraceLink], object_type: str) -> set[str]:
    """Ids of the `object_type` endpoints of the given links, on either side."""
    ids: set[str] = set()
    for link in links:
        if link.source_type == object_type:
            ids.add(link.source_id)
        if link.target_type == object_type:
            ids.add(link.target_id)
    return ids


def _links_touching(db: Session, endpoints: dict[str, set[str]]) -> list[TraceLink]:
    conditions = [
        condition
        for object_type, ids in endpoints.items()
        if ids
        for condition in (
            and_(TraceLink.source_type == object_type, TraceLink.source_id.in_(ids)),
            and_(TraceLink.target_type == object_type, TraceLink.target_id.in_(ids)),
        )
    ]
    if not conditions:
        return []
    return list(db.scalars(select(TraceLink).where(or_(*conditions))))


def _item_rows(db: Session, *conditions) -> list[ItemRow]:
    return [
        tuple(row)
        for row in db.execute(
            select(SheetItem, DrawingSheet, Drawing)
            .join(DrawingSheet, SheetItem.sheet_id == DrawingSheet.id)
            .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
            .where(*conditions)
            .order_by(Drawing.number, DrawingSheet.sheet_no, SheetItem.tag)
        ).all()
    ]


def _sheet_item_read(item: SheetItem, sheet: DrawingSheet, drawing: Drawing) -> dict:
    return {
        "id": item.id,
        "sheet_id": sheet.id,
        "item_id": item.item_id,
        "tag": item.tag,
        "zone": item.zone,
        "part_id": item.part_id,
        "drawing_id": drawing.id,
        "drawing_number": drawing.number,
        "sheet_no": sheet.sheet_no,
    }


def _drawings_read(db: Session, drawing_ids: set[str], items: list[ItemRow]) -> list[dict]:
    if not drawing_ids:
        return []
    sheets_by_drawing: dict[str, set[int]] = {}
    for _, sheet, drawing in items:
        sheets_by_drawing.setdefault(drawing.id, set()).add(sheet.sheet_no)
    drawings = db.scalars(
        select(Drawing)
        .where(Drawing.id.in_(drawing_ids))
        .options(selectinload(Drawing.revisions))
        .order_by(Drawing.number)
    )
    return [
        {
            "id": drawing.id,
            "project_id": drawing.project_id,
            "number": drawing.number,
            "title": drawing.title.replace("\n", " "),
            "status": drawing.status,
            "revision": drawing.current_revision.label if drawing.current_revision else None,
            "sheets": sorted(sheets_by_drawing.get(drawing.id, set())),
        }
        for drawing in drawings
    ]


def _drawing_snapshots_with_part(db: Session, part_id: str) -> list[BomSnapshot]:
    """Drawing BoM snapshots that have a row for the part (rows are JSON, so filter here)."""
    snapshots = db.scalars(
        select(BomSnapshot)
        .where(BomSnapshot.drawing_id.is_not(None))
        .order_by(BomSnapshot.created_at.desc())
    )
    return [
        snapshot
        for snapshot in snapshots
        if any(row.get("part_id") == part_id for row in snapshot.rows or [])
    ]


def _requirements_read(db: Session, requirement_ids: set[str]) -> list[dict]:
    if not requirement_ids:
        return []
    requirements = db.scalars(
        select(Requirement).where(Requirement.id.in_(requirement_ids)).order_by(Requirement.key)
    )
    return [
        {
            "id": requirement.id,
            "project_id": requirement.project_id,
            "key": requirement.key,
            "title": requirement.title,
            "status": requirement.status,
        }
        for requirement in requirements
    ]


def _parts_read(db: Session, part_ids: set[str]) -> list[dict]:
    if not part_ids:
        return []
    parts = db.scalars(select(Part).where(Part.id.in_(part_ids)).order_by(Part.part_number))
    return [
        {"id": part.id, "part_number": part.part_number, "description": part.description}
        for part in parts
    ]


def _part_drawing_impact(db: Session, part_id: str, direct_links: list[TraceLink]) -> dict:
    items = _item_rows(db, SheetItem.part_id == part_id)
    drawing_ids = {drawing.id for _, _, drawing in items}
    # Requirements traced to the part itself, to its tags, or to their drawings.
    links = _links_touching(
        db,
        {
            "sheet_item": {item.id for item, _, _ in items},
            "drawing": drawing_ids,
        },
    )
    requirement_ids = _linked_ids([*direct_links, *links], "requirement")
    return {
        "affected_drawings": _drawings_read(db, drawing_ids, items),
        "affected_sheet_items": [_sheet_item_read(*row) for row in items],
        "affected_requirements": _requirements_read(db, requirement_ids),
        "drawing_snapshots": _drawing_snapshots_with_part(db, part_id),
    }


def _requirement_impact(db: Session, requirement_id: str, direct_links: list[TraceLink]) -> dict:
    # Tags the requirement is traced to, and tags its constraint was checked on.
    item_ids = _linked_ids(direct_links, "sheet_item")
    checked = db.execute(
        select(DrcRequirementCheck.sheet_id, DrcRequirementCheck.item_id).where(
            DrcRequirementCheck.requirement_id == requirement_id
        )
    ).all()
    checked_pairs = {(sheet_id, item_id) for sheet_id, item_id in checked}
    items = _item_rows(db, SheetItem.id.in_(item_ids)) if item_ids else []
    if checked_pairs:
        seen = {item.id for item, _, _ in items}
        items.extend(
            row
            for row in _item_rows(
                db, SheetItem.sheet_id.in_({sheet_id for sheet_id, _ in checked_pairs})
            )
            if (row[0].sheet_id, row[0].item_id) in checked_pairs and row[0].id not in seen
        )
    drawing_ids = {drawing.id for _, _, drawing in items} | _linked_ids(direct_links, "drawing")
    drawing_ids |= {
        drawing_id
        for (drawing_id,) in db.execute(
            select(DrawingSheet.drawing_id).where(
                DrawingSheet.id.in_({sheet_id for sheet_id, _ in checked_pairs})
            )
        )
    }
    part_ids = {item.part_id for item, _, _ in items if item.part_id}
    part_ids |= _linked_ids(direct_links, "part")
    component_ids = _linked_ids(direct_links, "component")
    snapshots = (
        list(
            db.scalars(
                select(BomSnapshot)
                .where(BomSnapshot.drawing_id.in_(drawing_ids))
                .order_by(BomSnapshot.created_at.desc())
            )
        )
        if drawing_ids
        else []
    )
    return {
        "affected_drawings": _drawings_read(db, drawing_ids, items),
        "affected_sheet_items": [_sheet_item_read(*row) for row in items],
        "affected_parts": _parts_read(db, part_ids),
        "components": list(
            db.scalars(select(ComponentInstance).where(ComponentInstance.id.in_(component_ids)))
        )
        if component_ids
        else [],
        "drawing_snapshots": snapshots,
    }


def get_change_impact(db: Session, object_type: str, object_id: str) -> dict:
    direct_links = get_trace_links(db, object_type, object_id)
    affected_components: list[ComponentInstance] = []
    affected_bom_snapshots: list[BomSnapshot] = []
    drawing_impact: dict = {}

    if object_type == "part":
        affected_components = list(
            db.scalars(select(ComponentInstance).where(ComponentInstance.part_id == object_id))
        )
        diagram_ids = {component.diagram_id for component in affected_components}
        if diagram_ids:
            affected_bom_snapshots = list(
                db.scalars(select(BomSnapshot).where(BomSnapshot.diagram_id.in_(diagram_ids)))
            )
        drawing_impact = _part_drawing_impact(db, object_id, direct_links)

    if object_type == "component":
        component = db.get(ComponentInstance, object_id)
        if component:
            affected_components = [component]
            affected_bom_snapshots = list(
                db.scalars(
                    select(BomSnapshot).where(BomSnapshot.diagram_id == component.diagram_id)
                )
            )

    if object_type == "requirement":
        drawing_impact = _requirement_impact(db, object_id, direct_links)
        affected_components = drawing_impact.pop("components")

    affected_bom_snapshots = [*affected_bom_snapshots, *drawing_impact.pop("drawing_snapshots", [])]
    return {
        "object_type": object_type,
        "object_id": object_id,
        "direct_links": direct_links,
        "affected_bom_snapshots": affected_bom_snapshots,
        "affected_components": affected_components,
        "affected_drawings": drawing_impact.get("affected_drawings", []),
        "affected_sheet_items": drawing_impact.get("affected_sheet_items", []),
        "affected_requirements": drawing_impact.get("affected_requirements", []),
        "affected_parts": drawing_impact.get("affected_parts", []),
    }
