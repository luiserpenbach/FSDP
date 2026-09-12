"""Keeps safety objects honest when a sheet is saved: FMEA rows go stale when
the item they reference was retagged, re-parted, moved to another volume,
or deleted; analyses on the sheet are marked outdated when its document
changes."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DrawingSheet, FmeaRow, Part, SheetItem

ItemSnapshot = dict[str, dict[str, Any]]


def snapshot_items(db: Session, sheet: DrawingSheet) -> ItemSnapshot:
    """(item_id -> tag, part_id, volume_key) before the index is replaced."""
    return {
        item.item_id: {
            "tag": item.tag,
            "part_id": item.part_id,
            "volume_key": (item.fields or {}).get("volume_key"),
        }
        for item in db.scalars(select(SheetItem).where(SheetItem.sheet_id == sheet.id))
    }


def _part_number(db: Session, part_id: str | None) -> str:
    if not part_id:
        return "none"
    part = db.get(Part, part_id)
    return part.part_number if part else "unknown part"


def sync_fmea_rows(db: Session, sheet: DrawingSheet) -> int:
    """Compare every FMEA row on the sheet with the freshly stored index and set
    ``stale_reason`` where the item changed. Returns the number of rows marked."""
    current = {
        item.item_id: item
        for item in db.scalars(select(SheetItem).where(SheetItem.sheet_id == sheet.id))
    }
    marked = 0
    for row in db.scalars(select(FmeaRow).where(FmeaRow.sheet_id == sheet.id)):
        if not row.item_id:
            continue
        item = current.get(row.item_id)
        reason: str | None = None
        detail: str | None = None
        label = row.item_tag_seen or row.item_id
        if item is None:
            reason, detail = "deleted", f"{label} is no longer on sheet {sheet.sheet_no}"
        elif (item.part_id or None) != (row.part_id_seen or None):
            reason = "part_changed"
            detail = (
                f"{item.tag or label}: part changed "
                f"{_part_number(db, row.part_id_seen)} → {_part_number(db, item.part_id)}"
            )
        elif (item.tag or None) != (row.item_tag_seen or None):
            reason, detail = "retagged", f"{label} was retagged to {item.tag or '(no tag)'}"
        else:
            new_volume = (item.fields or {}).get("volume_key")
            if row.volume_key_seen and new_volume and new_volume != row.volume_key_seen:
                reason = "moved_volume"
                detail = f"{item.tag or label} now sits in a different isolable volume"
        if reason is None:
            continue
        # Keep the first reason unless the new one is more severe (deleted wins).
        order = {"retagged": 1, "moved_volume": 2, "part_changed": 3, "deleted": 4}
        if row.stale_reason and order.get(row.stale_reason, 0) >= order.get(reason, 0):
            continue
        row.stale_reason = reason
        row.stale_detail = detail
        marked += 1
    db.flush()
    return marked
