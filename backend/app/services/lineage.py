"""Template lineage: where a drawing was copied from, and how the two differ.

A copy keeps the document ids of its items and lines, so rows are matched by
(sheet number, id) rather than by tag: a renamed tag shows as a change, not as
a removal and an addition.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Drawing, DrawingSheet, Part, SheetItem, SheetLine

ITEM_FIELDS = ("tag", "label", "symbol_name", "part", "dnp", "spare")
LINE_FIELDS = (
    "line_number",
    "service",
    "size",
    "line_class",
    "spec",
    "design_pressure",
    "design_temperature",
)


def _text(value: object) -> str | None:
    if value is None or value == "" or value is False or value == 0:
        return None
    return "yes" if value is True else str(value)


def _rows(db: Session, drawing_id: str) -> tuple[dict, dict, dict[int, bool]]:
    """Index rows of a drawing keyed by (sheet_no, id), and each sheet's stale flag."""
    sheets = {
        sheet_id: (sheet_no, stale)
        for sheet_id, sheet_no, stale in db.execute(
            select(DrawingSheet.id, DrawingSheet.sheet_no, DrawingSheet.index_stale).where(
                DrawingSheet.drawing_id == drawing_id
            )
        )
    }
    part_numbers = dict(
        db.execute(
            select(Part.id, Part.part_number)
            .join(SheetItem, SheetItem.part_id == Part.id)
            .where(SheetItem.sheet_id.in_(sheets))
        ).all()
    )
    items: dict[tuple[int, str], dict] = {}
    for row in db.scalars(select(SheetItem).where(SheetItem.sheet_id.in_(sheets))):
        items[(sheets[row.sheet_id][0], row.item_id)] = {
            "tag": row.tag,
            "label": row.label,
            "symbol_name": row.symbol_name,
            "part": part_numbers.get(row.part_id),
            "dnp": row.dnp,
            "spare": row.spare,
        }
    lines: dict[tuple[int, str], dict] = {}
    for row in db.scalars(select(SheetLine).where(SheetLine.sheet_id.in_(sheets))):
        lines[(sheets[row.sheet_id][0], row.line_id)] = {
            field: getattr(row, field) for field in LINE_FIELDS
        }
    return items, lines, {sheet_no: stale for sheet_no, stale in sheets.values()}


def _item_label(values: dict) -> str:
    return values.get("tag") or values.get("label") or values.get("symbol_name") or "Untagged"


def _line_label(values: dict) -> str:
    return values.get("line_number") or "Unnumbered line"


def _compare(kind: str, fields, label, describe, source: dict, copy: dict) -> list[dict]:
    rows: list[dict] = []
    for key in sorted(source.keys() | copy.keys()):
        sheet_no, item_id = key
        before, after = source.get(key), copy.get(key)
        base = {"kind": kind, "sheet_no": sheet_no, "item_id": item_id}
        if before is None:
            rows.append(
                {**base, "change": "added", "label": label(after), "description": describe(after)}
            )
        elif after is None:
            rows.append(
                {
                    **base,
                    "change": "removed",
                    "label": label(before),
                    "description": describe(before),
                }
            )
        else:
            changes = [
                {"field": field, "source": _text(before[field]), "copy_value": _text(after[field])}
                for field in fields
                if _text(before[field]) != _text(after[field])
            ]
            if changes:
                rows.append(
                    {
                        **base,
                        "change": "changed",
                        "label": label(after),
                        "description": describe(after),
                        "changes": changes,
                    }
                )
    return rows


def lineage_diff(db: Session, drawing: Drawing, source: Drawing) -> dict:
    source_items, source_lines, source_sheets = _rows(db, source.id)
    copy_items, copy_lines, copy_sheets = _rows(db, drawing.id)
    shared = source_sheets.keys() & copy_sheets.keys()

    def on_shared(rows: dict) -> dict:
        return {key: value for key, value in rows.items() if key[0] in shared}

    rows = _compare(
        "item",
        ITEM_FIELDS,
        _item_label,
        lambda values: values.get("symbol_name") or "",
        on_shared(source_items),
        on_shared(copy_items),
    ) + _compare(
        "line",
        LINE_FIELDS,
        _line_label,
        lambda values: " ".join(
            part for part in (values.get("service"), values.get("size")) if part
        ),
        on_shared(source_lines),
        on_shared(copy_lines),
    )
    counts = {"added": 0, "removed": 0, "changed": 0}
    for row in rows:
        counts[row["change"]] += 1
    stale = [
        f"{entry.number} sheet {sheet_no}"
        for entry, sheets in ((source, source_sheets), (drawing, copy_sheets))
        for sheet_no, is_stale in sorted(sheets.items())
        if is_stale
    ]
    return {
        "drawing_id": drawing.id,
        "source_id": source.id,
        "source_number": source.number,
        "counts": counts,
        "rows": rows,
        "sheets_added": sorted(copy_sheets.keys() - source_sheets.keys()),
        "sheets_removed": sorted(source_sheets.keys() - copy_sheets.keys()),
        "stale": stale,
    }
