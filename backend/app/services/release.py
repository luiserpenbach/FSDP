"""Drawing release workflow: revision lettering, release gate, and release snapshots.

A drawing moves draft -> in_review -> released through explicit actions. Release
is refused while any sheet's index/DRC is stale or a sheet has open (unwaived)
DRC errors, and it stores an immutable copy of every sheet on the revision.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Drawing,
    DrawingRevision,
    DrawingSheet,
    DrcResult,
    DrcWaiver,
    SheetItem,
    SheetLine,
)
from app.schemas import DrcResultRead, SheetItemRead, SheetLineRead


def next_revision_label(current: str | None, sequence: int) -> str:
    """Label of the revision after `current`: - -> A, A -> B, Z -> AA, 3 -> 4.

    Labels that are neither letters nor a number fall back to the next sequence.
    """
    label = (current or "").strip().upper()
    if not label or label == "-":
        return "A"
    if label.isdigit():
        return str(int(label) + 1)
    if label.isascii() and label.isalpha():
        chars = list(label)
        index = len(chars) - 1
        while index >= 0:
            if chars[index] != "Z":
                chars[index] = chr(ord(chars[index]) + 1)
                return "".join(chars)
            chars[index] = "A"
            index -= 1
        return "A" + "".join(chars)
    return str(sequence + 1)


def _open_error_counts(db: Session, sheet_ids: list[str]) -> dict[str, int]:
    """Open (unwaived) error findings per sheet."""
    if not sheet_ids:
        return {}
    waived = {
        (sheet_id, key)
        for sheet_id, key in db.execute(
            select(DrcWaiver.sheet_id, DrcWaiver.key).where(DrcWaiver.sheet_id.in_(sheet_ids))
        )
    }
    counts: dict[str, int] = {}
    for sheet_id, key in db.execute(
        select(DrcResult.sheet_id, DrcResult.key).where(
            DrcResult.sheet_id.in_(sheet_ids), DrcResult.severity == "error"
        )
    ):
        if (sheet_id, key) not in waived:
            counts[sheet_id] = counts.get(sheet_id, 0) + 1
    return counts


def release_blockers(db: Session, drawing: Drawing) -> list[dict]:
    """Reasons the drawing cannot be released yet; empty when it can."""
    reasons: list[dict] = []
    for sheet in drawing.sheets:
        if sheet.index_stale:
            reasons.append(
                {
                    "code": "index_stale",
                    "sheet_id": sheet.id,
                    "sheet_no": sheet.sheet_no,
                    "message": (
                        f"Sheet {sheet.sheet_no}: index and design rule checks are out of date; "
                        "open and save the sheet."
                    ),
                }
            )
    errors = _open_error_counts(db, [sheet.id for sheet in drawing.sheets])
    for sheet in drawing.sheets:
        count = errors.get(sheet.id, 0)
        if count:
            reasons.append(
                {
                    "code": "drc_errors",
                    "sheet_id": sheet.id,
                    "sheet_no": sheet.sheet_no,
                    "count": count,
                    "message": (
                        f"Sheet {sheet.sheet_no}: {count} open design rule error(s); "
                        "fix or waive them."
                    ),
                }
            )
    return reasons


def release_snapshot(
    db: Session, drawing: Drawing, revision: DrawingRevision, released_at: datetime
) -> dict:
    """Immutable copy of the drawing at release: metadata, sheets, index rows, DRC."""
    sheets = list(
        db.scalars(
            select(DrawingSheet)
            .where(DrawingSheet.drawing_id == drawing.id)
            .order_by(DrawingSheet.sheet_no)
        )
    )
    sheet_ids = [sheet.id for sheet in sheets]
    items: dict[str, list[dict]] = {sheet_id: [] for sheet_id in sheet_ids}
    lines: dict[str, list[dict]] = {sheet_id: [] for sheet_id in sheet_ids}
    findings: dict[str, list[dict]] = {sheet_id: [] for sheet_id in sheet_ids}
    waivers: dict[str, list[dict]] = {sheet_id: [] for sheet_id in sheet_ids}
    if sheet_ids:
        for row in db.scalars(select(SheetItem).where(SheetItem.sheet_id.in_(sheet_ids))):
            items[row.sheet_id].append(SheetItemRead.model_validate(row).model_dump(mode="json"))
        for row in db.scalars(select(SheetLine).where(SheetLine.sheet_id.in_(sheet_ids))):
            lines[row.sheet_id].append(SheetLineRead.model_validate(row).model_dump(mode="json"))
        for row in db.scalars(select(DrcResult).where(DrcResult.sheet_id.in_(sheet_ids))):
            findings[row.sheet_id].append(DrcResultRead.model_validate(row).model_dump(mode="json"))
        for row in db.scalars(select(DrcWaiver).where(DrcWaiver.sheet_id.in_(sheet_ids))):
            waivers[row.sheet_id].append(
                {"key": row.key, "reason": row.reason, "waived_by": row.waived_by}
            )
    return {
        "schema_version": 1,
        "released_at": released_at.isoformat(),
        "released_by": revision.approved_by,
        "drawing": {
            "id": drawing.id,
            "project_id": drawing.project_id,
            "system_id": drawing.system_id,
            "number": drawing.number,
            "title": drawing.title,
            "size": drawing.size,
            "units": drawing.units,
            "discipline": drawing.discipline,
            "frame_template": drawing.frame_template,
            "fields": drawing.fields or {},
            "notes": drawing.notes or [],
        },
        "revision": {
            "id": revision.id,
            "sequence": revision.sequence,
            "label": revision.label,
            "description": revision.description,
            "drawn_by": revision.drawn_by,
            "drawn_date": revision.drawn_date,
            "submitted_by": revision.submitted_by,
            "approved_by": revision.approved_by,
            "approved_date": revision.approved_date,
        },
        "sheets": [
            {
                "id": sheet.id,
                "sheet_no": sheet.sheet_no,
                "title": sheet.title,
                "document": sheet.document,
                "items": sorted(items[sheet.id], key=lambda row: row["item_id"]),
                "lines": sorted(lines[sheet.id], key=lambda row: row["line_id"]),
                "drc": {
                    "findings": sorted(findings[sheet.id], key=lambda row: row["key"]),
                    "waivers": sorted(waivers[sheet.id], key=lambda row: row["key"]),
                },
            }
            for sheet in sheets
        ],
    }
