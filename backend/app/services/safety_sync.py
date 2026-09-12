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


def document_hash(document: dict[str, Any] | None) -> str:
    """Stable hash of a sheet document (sorted keys)."""
    import hashlib
    import json

    payload = json.dumps(document or {}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def refresh_document_hash(db: Session, sheet: DrawingSheet) -> bool:
    """Store the document hash; when it changed, mark the sheet's analyses outdated."""
    from app.models import Analysis

    digest = document_hash(sheet.document)
    if sheet.document_hash == digest:
        return False
    sheet.document_hash = digest
    for analysis in db.scalars(select(Analysis).where(Analysis.sheet_id == sheet.id)):
        if analysis.sheet_hash and analysis.sheet_hash != digest:
            analysis.outdated = True
    db.flush()
    return True


def auto_hazards(db: Session, sheet: DrawingSheet, settings: dict[str, Any]) -> int:
    """With ``auto_hazard`` on, every open relief-coverage finding gets a draft
    trapped-fluid hazard scoped to its volume (once per volume). Returns the
    number of hazards created."""
    from app.models import Drawing, DrcResult, Hazard, SheetVolume
    from app.services.hazards import next_hazard_key
    from app.services.safety_settings import fault_tolerance_for

    if not settings.get("auto_hazard"):
        return 0
    drawing = db.get(Drawing, sheet.drawing_id)
    if drawing is None:
        return 0
    findings = list(
        db.scalars(
            select(DrcResult).where(
                DrcResult.sheet_id == sheet.id, DrcResult.rule == "relief_coverage"
            )
        )
    )
    if not findings:
        return 0
    volumes = {
        row.key: row
        for row in db.scalars(select(SheetVolume).where(SheetVolume.sheet_id == sheet.id))
    }
    existing = list(db.scalars(select(Hazard).where(Hazard.project_id == drawing.project_id)))
    by_volume: dict[str, Hazard] = {}
    for hazard in existing:
        for key in hazard.volume_keys or []:
            by_volume.setdefault(key, hazard)
    created = 0
    for finding in findings:
        # The finding's subject is a line id of the volume (engine convention).
        volume = next(
            (
                row
                for row in volumes.values()
                if finding.item_id in (row.payload or {}).get("line_ids", [])
            ),
            None,
        )
        if volume is None or volume.relieved:
            continue
        hazard = by_volume.get(volume.key)
        if hazard is None:
            severity = settings.get("default_hazard_severity") or "I"
            line_numbers = ", ".join((volume.payload or {}).get("line_numbers") or []) or (
                f"{len((volume.payload or {}).get('line_ids', []))} line(s)"
            )
            hazard = Hazard(
                project_id=drawing.project_id,
                system_id=drawing.system_id,
                key=next_hazard_key(db, drawing.project_id),
                title=(
                    f"Overpressure of isolable volume {line_numbers} "
                    f"({volume.service or 'process'})"
                ),
                description=(
                    f"Isolable volume on {drawing.number} sheet {sheet.sheet_no} "
                    f"({line_numbers}) has no relief device. Created from a relief-coverage "
                    "design rule finding."
                ),
                category="trapped_fluid",
                operating_modes=[
                    m for m in settings.get("operating_modes", []) if m in {"hold", "abort_safe"}
                ]
                or None,
                severity_initial=severity,
                likelihood_initial=settings.get("default_hazard_likelihood") or "C",
                fault_tolerance_required=fault_tolerance_for(settings, severity),
                volume_keys=[volume.key],
            )
            db.add(hazard)
            db.flush()
            by_volume[volume.key] = hazard
            created += 1
        finding.hazard_id = hazard.id
    db.flush()
    return created
