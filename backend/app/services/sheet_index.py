"""Sheet index: normalized item and line rows derived from a sheet document.

The engine computes the rows in the browser at save time (it owns the symbol
library and the geometry-based connectivity); this module stores them and
serves the joined rows that lists, BoM roll-ups, and where-used read.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Drawing, DrawingSheet, Part, SheetItem, SheetLine, SheetVolume
from app.schemas import SheetIndexIn

ItemRow = tuple[SheetItem, DrawingSheet, Drawing]
LineRow = tuple[SheetLine, DrawingSheet, Drawing]


def replace_sheet_index(db: Session, sheet: DrawingSheet, index: SheetIndexIn) -> None:
    """Replace the stored index rows of a sheet with the given ones.

    Rows are upserted by ``(sheet, item_id)`` / ``(sheet, line_id)`` so their
    primary keys survive a save: trace links, hazard controls, and FMEA rows
    reference them and must not dangle after every edit.
    """
    existing_items = {
        row.item_id: row
        for row in db.scalars(select(SheetItem).where(SheetItem.sheet_id == sheet.id))
    }
    existing_lines = {
        row.line_id: row
        for row in db.scalars(select(SheetLine).where(SheetLine.sheet_id == sheet.id))
    }
    known_parts = {
        part_id
        for (part_id,) in db.execute(
            select(Part.id).where(
                Part.id.in_({item.part_id for item in index.items if item.part_id})
            )
        )
    }
    seen_items: set[str] = set()
    for item in index.items:
        if item.item_id in seen_items:
            continue
        seen_items.add(item.item_id)
        data = item.model_dump()
        if data["part_id"] not in known_parts:
            data["part_id"] = None
        row = existing_items.pop(item.item_id, None)
        if row is None:
            db.add(SheetItem(sheet_id=sheet.id, **data))
        else:
            for field, value in data.items():
                setattr(row, field, value)
    for row in existing_items.values():
        db.delete(row)
    seen_lines: set[str] = set()
    for line in index.lines:
        if line.line_id in seen_lines:
            continue
        seen_lines.add(line.line_id)
        data = line.model_dump()
        row = existing_lines.pop(line.line_id, None)
        if row is None:
            db.add(SheetLine(sheet_id=sheet.id, **data))
        else:
            for field, value in data.items():
                setattr(row, field, value)
    for row in existing_lines.values():
        db.delete(row)
    if index.volumes is not None:
        existing_volumes = {
            row.key: row
            for row in db.scalars(select(SheetVolume).where(SheetVolume.sheet_id == sheet.id))
        }
        for volume in index.volumes:
            data = volume.model_dump()
            columns = {
                "isolable": data["isolable"],
                "relieved": data["relieved"],
                "service": data["service"],
                "design_pressure": data["design_pressure"],
                "design_temperature": data["design_temperature"],
                "length_m": data["length_m"],
                "payload": {
                    key: data[key]
                    for key in (
                        "line_ids",
                        "item_ids",
                        "relief_item_ids",
                        "isolating_item_ids",
                        "line_numbers",
                    )
                },
            }
            row = existing_volumes.pop(volume.key, None)
            if row is None:
                db.add(SheetVolume(sheet_id=sheet.id, key=volume.key, **columns))
            else:
                for field, value in columns.items():
                    setattr(row, field, value)
        for row in existing_volumes.values():
            db.delete(row)
    db.flush()


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
