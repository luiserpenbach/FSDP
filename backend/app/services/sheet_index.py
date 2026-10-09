"""Sheet index: normalized item and line rows derived from a sheet document.

The engine computes the rows in the browser at save time (it owns the symbol
library and the geometry-based connectivity); this module stores them and
serves the joined rows that lists, BoM roll-ups, and where-used read.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select, update
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


def document_needs_index(document: dict | None) -> bool:
    """Whether a document has content the engine must index (an empty sheet has none)."""
    return bool((document or {}).get("items"))


def _unreleased_drawing_ids():
    # Released drawings are frozen baselines: their sheets cannot be re-indexed until a
    # new revision is started, and revise_drawing flags every sheet stale at that point.
    return select(Drawing.id).where(Drawing.status != "released")


def mark_sheets_stale_for_part(db: Session, part_id: str) -> None:
    """Flag every unreleased sheet whose index assigns the part: its DRC used the old part data."""
    sheet_ids = select(SheetItem.sheet_id).where(SheetItem.part_id == part_id)
    db.execute(
        update(DrawingSheet)
        .where(
            DrawingSheet.id.in_(sheet_ids),
            DrawingSheet.drawing_id.in_(_unreleased_drawing_ids()),
        )
        .values(index_stale=True)
        .execution_options(synchronize_session=False)
    )


def mark_project_sheets_stale(db: Session, project_id: str) -> None:
    """Flag every unreleased sheet of a project, e.g. after a requirement constraint changed."""
    drawing_ids = _unreleased_drawing_ids().where(Drawing.project_id == project_id)
    db.execute(
        update(DrawingSheet)
        .where(DrawingSheet.drawing_id.in_(drawing_ids))
        .values(index_stale=True)
        .execution_options(synchronize_session=False)
    )


def mark_drawing_sheets_stale(db: Session, drawing_id: str) -> None:
    """Flag every sheet of a drawing: a new revision re-checks current parts and requirements."""
    db.execute(
        update(DrawingSheet)
        .where(DrawingSheet.drawing_id == drawing_id)
        .values(index_stale=True)
        .execution_options(synchronize_session=False)
    )


def stale_sheets(db: Session, drawing_ids: Iterable[str]) -> list[dict]:
    """Sheets of the given drawings whose stored index/DRC is out of date."""
    ids = list(drawing_ids)
    if not ids:
        return []
    rows = db.execute(
        select(DrawingSheet.id, DrawingSheet.sheet_no, Drawing.id, Drawing.number)
        .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
        .where(Drawing.id.in_(ids), DrawingSheet.index_stale.is_(True))
        .order_by(Drawing.number, DrawingSheet.sheet_no)
    ).all()
    return [
        {
            "sheet_id": sheet_id,
            "sheet_no": sheet_no,
            "drawing_id": drawing_id,
            "drawing_number": number,
        }
        for sheet_id, sheet_no, drawing_id, number in rows
    ]


def stale_sheets_note(stale: list[dict]) -> str:
    """One-line warning for list/BoM export headers naming the stale sheets."""
    names = ", ".join(f"{entry['drawing_number']} sheet {entry['sheet_no']}" for entry in stale)
    return f"Index out of date for {names}; open and save these sheets to refresh."
