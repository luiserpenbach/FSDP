"""Sheet index: normalized item and line rows derived from a sheet document.

The engine computes the rows in the browser at save time (it owns the symbol
library and the geometry-based connectivity); this module stores them and
serves the joined rows that lists, BoM roll-ups, and where-used read.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Drawing, DrawingSheet, Part, SheetItem, SheetLine
from app.schemas import SheetIndexIn
from app.services.traceability import delete_trace_links_for_many

ItemRow = tuple[SheetItem, DrawingSheet, Drawing]
LineRow = tuple[SheetLine, DrawingSheet, Drawing]


def replace_sheet_index(db: Session, sheet: DrawingSheet, index: SheetIndexIn) -> None:
    """Replace the stored index rows of a sheet with the given ones.

    Rows are matched by item_id / line_id and updated in place so their ids, which
    trace links reference, survive a save. Rows no longer on the sheet are deleted
    together with their trace links.
    """
    known_parts = {
        part_id
        for (part_id,) in db.execute(
            select(Part.id).where(
                Part.id.in_({item.part_id for item in index.items if item.part_id})
            )
        )
    }
    existing_items = {
        row.item_id: row
        for row in db.scalars(select(SheetItem).where(SheetItem.sheet_id == sheet.id))
    }
    existing_lines = {
        row.line_id: row
        for row in db.scalars(select(SheetLine).where(SheetLine.sheet_id == sheet.id))
    }
    seen_items: set[str] = set()
    for item in index.items:
        if item.item_id in seen_items:
            continue
        seen_items.add(item.item_id)
        data = item.model_dump()
        if data["part_id"] not in known_parts:
            data["part_id"] = None
        _upsert(db, existing_items.get(item.item_id), SheetItem, sheet.id, data)
    seen_lines: set[str] = set()
    for line in index.lines:
        if line.line_id in seen_lines:
            continue
        seen_lines.add(line.line_id)
        _upsert(db, existing_lines.get(line.line_id), SheetLine, sheet.id, line.model_dump())

    stale_items = [row for key, row in existing_items.items() if key not in seen_items]
    stale_lines = [row for key, row in existing_lines.items() if key not in seen_lines]
    delete_trace_links_for_many(
        db,
        [("sheet_item", row.id) for row in stale_items]
        + [("sheet_line", row.id) for row in stale_lines],
    )
    for row in [*stale_items, *stale_lines]:
        db.delete(row)
    db.flush()


def _upsert(
    db: Session, row: SheetItem | SheetLine | None, model: type, sheet_id: str, data: dict
) -> None:
    if row is None:
        db.add(model(sheet_id=sheet_id, **data))
        return
    for field, value in data.items():
        setattr(row, field, value)


def drawing_index_rows(db: Session, drawings: list[Drawing]) -> tuple[list[ItemRow], list[LineRow]]:
    """All item and line rows of the given drawings joined with their sheet and drawing."""
    drawing_ids = [drawing.id for drawing in drawings]
    if not drawing_ids:
        return [], []
    items = db.execute(
        select(SheetItem, DrawingSheet, Drawing)
        .join(DrawingSheet, SheetItem.sheet_id == DrawingSheet.id)
        .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
        .where(Drawing.id.in_(drawing_ids))
        .order_by(Drawing.number, DrawingSheet.sheet_no)
    ).all()
    lines = db.execute(
        select(SheetLine, DrawingSheet, Drawing)
        .join(DrawingSheet, SheetLine.sheet_id == DrawingSheet.id)
        .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
        .where(Drawing.id.in_(drawing_ids))
        .order_by(Drawing.number, DrawingSheet.sheet_no)
    ).all()
    return [tuple(row) for row in items], [tuple(row) for row in lines]
