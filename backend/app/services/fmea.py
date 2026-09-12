"""FMEA worksheets: row generation from the sheet index and the failure-mode
library, live row resolution, ratings, the release gate, releases, diffs,
and export rows."""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    Drawing,
    DrawingSheet,
    FailureMode,
    FmeaRelease,
    FmeaRow,
    FmeaRowComment,
    FmeaWorksheet,
    Hazard,
    Part,
    Requirement,
    SheetItem,
    TraceLink,
)
from app.services.failure_modes import library, modes_for, render_effect

GENERATE_CATEGORIES = ("valve", "regulator", "inline", "instrument", "equipment")
STALE_SEVERITY = {"deleted": 4, "part_changed": 3, "moved_volume": 2, "retagged": 1}

EXPORT_COLUMNS: list[tuple[str, str]] = [
    ("item_tag", "Item"),
    ("part_number", "Part"),
    ("item_zone", "Zone"),
    ("failure_mode_title", "Failure mode"),
    ("operating_modes_text", "Modes"),
    ("cause", "Cause"),
    ("local_effect", "Local effect"),
    ("next_effect", "Next effect"),
    ("end_effect", "End effect"),
    ("detection_text", "Detected by"),
    ("severity", "S"),
    ("occurrence", "O"),
    ("detection", "D"),
    ("rpn", "RPN"),
    ("controls_text", "Controls"),
    ("hazard_key", "Hazard"),
    ("recommended_action", "Action"),
    ("action_owner", "Owner"),
    ("action_status", "Action status"),
    ("severity_residual", "S'"),
    ("occurrence_residual", "O'"),
    ("detection_residual", "D'"),
    ("rpn_residual", "RPN'"),
    ("notes", "Notes"),
    ("stale_reason", "Stale"),
]


def compute_rpn(severity: int | None, occurrence: int | None, detection: int | None) -> int | None:
    if severity is None or occurrence is None or detection is None:
        return None
    return severity * occurrence * detection


def latest_revision_label(drawing: Drawing | None) -> str | None:
    if drawing is None or not drawing.revisions:
        return None
    return max(drawing.revisions, key=lambda rev: rev.sequence).label


def _items_for_drawing(
    db: Session, drawing_id: str, sheet_ids: list[str] | None = None
) -> list[tuple[SheetItem, DrawingSheet]]:
    query = (
        select(SheetItem, DrawingSheet)
        .join(DrawingSheet, SheetItem.sheet_id == DrawingSheet.id)
        .where(DrawingSheet.drawing_id == drawing_id)
        .order_by(DrawingSheet.sheet_no, SheetItem.tag)
    )
    if sheet_ids:
        query = query.where(DrawingSheet.id.in_(sheet_ids))
    return [tuple(row) for row in db.execute(query).all()]


def _instrument_index(items: list[tuple[SheetItem, DrawingSheet]]) -> list[SheetItem]:
    return [item for item, _ in items if item.category == "instrument" and item.tag]


def suggest_detection(
    item: SheetItem, instruments: list[SheetItem], hint: list[str] | None
) -> SheetItem | None:
    """First instrument on the same line number, then the same service, that
    matches the hinted tag letters; then any hinted instrument."""
    letters = [entry.upper() for entry in (hint or [])]
    fields = item.fields or {}
    line_number = fields.get("line_number")
    service = fields.get("service")

    def matches(candidate: SheetItem) -> bool:
        if not letters:
            return True
        tag = (candidate.tag or "").upper()
        prefix = re.match(r"^[A-Z]+", tag)
        return bool(prefix) and prefix.group(0) in letters

    hinted = [candidate for candidate in instruments if matches(candidate)]
    for scope in ("line_number", "service"):
        for candidate in hinted:
            cfields = candidate.fields or {}
            if scope == "line_number" and line_number and cfields.get("line_number") == line_number:
                return candidate
            if scope == "service" and service and cfields.get("service") == service:
                return candidate
    return hinted[0] if hinted else None


def _mode_key(row: FmeaRow) -> str:
    return row.failure_mode_id or f"text:{(row.failure_mode_text or '').strip().lower()}"


def generate_rows(
    db: Session,
    worksheet: FmeaWorksheet,
    drawing: Drawing,
    *,
    sheet_ids: list[str] | None,
    categories: list[str] | None,
    operating_modes: list[str] | None,
) -> dict[str, Any]:
    """One row per (item, applicable failure mode). Existing rows are kept;
    rows for items that vanished are marked stale. Idempotent."""
    entries = library(db)
    wanted = set(categories or GENERATE_CATEGORIES)
    modes = operating_modes if operating_modes is not None else worksheet.operating_modes
    items = _items_for_drawing(db, drawing.id, sheet_ids)
    instruments = _instrument_index(items)
    existing = {
        (row.sheet_id, row.item_id, _mode_key(row)): row for row in worksheet.rows if row.item_id
    }
    position = max((row.position for row in worksheet.rows), default=0)
    added = kept = 0
    without_modes: list[str] = []
    present: set[tuple[str, str]] = set()
    for item, sheet in items:
        present.add((sheet.id, item.item_id))
        if item.dnp or not item.category or item.category not in wanted:
            continue
        applicable = modes_for(entries, item.category, item.symbol_key)
        if not applicable:
            without_modes.append(item.tag or item.item_id)
            continue
        for mode in applicable:
            key = (sheet.id, item.item_id, mode.id)
            if key in existing:
                kept += 1
                continue
            row_modes = (
                [m for m in (modes or []) if m in mode.applicable_modes]
                if mode.applicable_modes and modes
                else (modes or mode.applicable_modes)
            )
            detected = suggest_detection(item, instruments, mode.default_detection_hint)
            position += 1
            row = FmeaRow(
                worksheet_id=worksheet.id,
                sheet_id=sheet.id,
                item_id=item.item_id,
                item_tag_seen=item.tag,
                part_id_seen=item.part_id,
                volume_key_seen=(item.fields or {}).get("volume_key"),
                failure_mode_id=mode.id,
                operating_modes=row_modes,
                local_effect=render_effect(
                    mode.default_local_effect,
                    tag=item.tag,
                    name=item.symbol_name or item.label,
                    service=(item.fields or {}).get("service"),
                ),
                detected_by_item_id=detected.item_id if detected else None,
                detection_kind="instrument" if detected else "none",
                severity=mode.default_severity,
                position=position,
            )
            db.add(row)
            existing[key] = row
            added += 1
    stale = 0
    if sheet_ids is None:
        for row in worksheet.rows:
            if not row.item_id or row.stale_reason == "deleted":
                continue
            if row.sheet_id and (row.sheet_id, row.item_id) not in present:
                sheet_exists = any(sheet.id == row.sheet_id for _, sheet in items) or bool(
                    db.get(DrawingSheet, row.sheet_id)
                )
                if sheet_exists:
                    row.stale_reason = "deleted"
                    row.stale_detail = (
                        f"{row.item_tag_seen or row.item_id} is no longer on the sheet"
                    )
                    stale += 1
    if worksheet.drawing_id == drawing.id and not worksheet.drawing_revision_label:
        worksheet.drawing_revision_label = latest_revision_label(drawing)
    db.flush()
    return {
        "added": added,
        "kept": kept,
        "stale": stale,
        "items_without_modes": sorted(set(without_modes)),
    }


def validate_row(
    db: Session, worksheet: FmeaWorksheet, data: dict[str, Any], scale_max: int
) -> str | None:
    """Return an error message or None."""
    if data.get("item_id") and not data.get("sheet_id"):
        return "sheet_id is required with item_id"
    if data.get("sheet_id") and data.get("item_id"):
        sheet = db.get(DrawingSheet, data["sheet_id"])
        if sheet is None:
            return "sheet not found"
        if worksheet.drawing_id and sheet.drawing_id != worksheet.drawing_id:
            return "item must be on the worksheet's drawing"
        item = db.scalar(
            select(SheetItem).where(
                SheetItem.sheet_id == sheet.id, SheetItem.item_id == data["item_id"]
            )
        )
        if item is None:
            return f"item {data['item_id']} is not on sheet {sheet.sheet_no}; save the sheet first"
    if data.get("detected_by_item_id") and worksheet.drawing_id:
        found = db.scalar(
            select(SheetItem)
            .join(DrawingSheet, SheetItem.sheet_id == DrawingSheet.id)
            .where(
                DrawingSheet.drawing_id == worksheet.drawing_id,
                SheetItem.item_id == data["detected_by_item_id"],
            )
        )
        if found is None:
            return "detected_by_item_id is not on the worksheet's drawing"
    if data.get("hazard_id"):
        hazard = db.get(Hazard, data["hazard_id"])
        if hazard is None or hazard.project_id != worksheet.project_id:
            return "hazard must belong to the same project"
    if data.get("failure_mode_id") and db.get(FailureMode, data["failure_mode_id"]) is None:
        return "failure mode not found"
    for field in (
        "severity",
        "occurrence",
        "detection",
        "severity_residual",
        "occurrence_residual",
        "detection_residual",
    ):
        value = data.get(field)
        if value is not None and not 1 <= int(value) <= scale_max:
            return f"{field} must be between 1 and {scale_max}"
    return None


def apply_row(db: Session, worksheet: FmeaWorksheet, row: FmeaRow, data: dict[str, Any]) -> None:
    for field, value in data.items():
        setattr(row, field, value)
    if "item_id" in data or "sheet_id" in data:
        item = None
        if row.sheet_id and row.item_id:
            item = db.scalar(
                select(SheetItem).where(
                    SheetItem.sheet_id == row.sheet_id, SheetItem.item_id == row.item_id
                )
            )
        row.item_tag_seen = item.tag if item else None
        row.part_id_seen = item.part_id if item else None
        row.volume_key_seen = (item.fields or {}).get("volume_key") if item else None
        row.stale_reason = None
        row.stale_detail = None
    row.rpn = compute_rpn(row.severity, row.occurrence, row.detection)
    if worksheet.status == "released":
        worksheet.status = "draft"


def confirm_row(db: Session, row: FmeaRow) -> None:
    item = None
    if row.sheet_id and row.item_id:
        item = db.scalar(
            select(SheetItem).where(
                SheetItem.sheet_id == row.sheet_id, SheetItem.item_id == row.item_id
            )
        )
    if item is not None:
        row.item_tag_seen = item.tag
        row.part_id_seen = item.part_id
        row.volume_key_seen = (item.fields or {}).get("volume_key")
    row.stale_reason = None
    row.stale_detail = None


def _controls(db: Session, row_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    if not row_ids:
        return result
    links = list(
        db.scalars(
            select(TraceLink).where(
                TraceLink.source_type == "fmea_row",
                TraceLink.source_id.in_(row_ids),
                TraceLink.link_type == "controlled_by",
            )
        )
    )
    requirement_ids = [link.target_id for link in links if link.target_type == "requirement"]
    item_ids = [link.target_id for link in links if link.target_type == "sheet_item"]
    requirements = (
        {
            r.id: r
            for r in db.scalars(select(Requirement).where(Requirement.id.in_(requirement_ids)))
        }
        if requirement_ids
        else {}
    )
    items = (
        {i.id: i for i in db.scalars(select(SheetItem).where(SheetItem.id.in_(item_ids)))}
        if item_ids
        else {}
    )
    for link in links:
        if link.target_type == "requirement":
            target = requirements.get(link.target_id)
            label = target.key if target else "requirement"
        else:
            target = items.get(link.target_id)
            label = (target.tag or target.item_id) if target else "item"
        if target is None:
            continue
        result.setdefault(link.source_id, []).append(
            {"link_id": link.id, "type": link.target_type, "id": link.target_id, "label": label}
        )
    return result


def row_views(db: Session, worksheet: FmeaWorksheet, rows: list[FmeaRow]) -> list[dict[str, Any]]:
    """Rows resolved live against the sheet index, parts, hazards, and comments."""
    sheet_ids = {row.sheet_id for row in rows if row.sheet_id}
    items: dict[tuple[str, str], SheetItem] = {}
    sheets: dict[str, tuple[DrawingSheet, Drawing]] = {}
    if sheet_ids:
        for item in db.scalars(select(SheetItem).where(SheetItem.sheet_id.in_(sheet_ids))):
            items[(item.sheet_id, item.item_id)] = item
        for sheet, drawing in db.execute(
            select(DrawingSheet, Drawing)
            .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
            .where(DrawingSheet.id.in_(sheet_ids))
        ).all():
            sheets[sheet.id] = (sheet, drawing)
    # Detection instruments may sit on another sheet of the same drawing.
    drawing_ids = {drawing.id for _, drawing in sheets.values()}
    detectors: dict[tuple[str, str], str] = {}
    if drawing_ids:
        for item, sheet in db.execute(
            select(SheetItem, DrawingSheet)
            .join(DrawingSheet, SheetItem.sheet_id == DrawingSheet.id)
            .where(DrawingSheet.drawing_id.in_(drawing_ids))
        ).all():
            detectors[(sheet.drawing_id, item.item_id)] = item.tag or item.item_id
    part_ids = {item.part_id for item in items.values() if item.part_id}
    parts = (
        {p.id: p.part_number for p in db.scalars(select(Part).where(Part.id.in_(part_ids)))}
        if part_ids
        else {}
    )
    hazard_ids = {row.hazard_id for row in rows if row.hazard_id}
    hazards = (
        {h.id: h.key for h in db.scalars(select(Hazard).where(Hazard.id.in_(hazard_ids)))}
        if hazard_ids
        else {}
    )
    mode_ids = {row.failure_mode_id for row in rows if row.failure_mode_id}
    modes = (
        {m.id: m for m in db.scalars(select(FailureMode).where(FailureMode.id.in_(mode_ids)))}
        if mode_ids
        else {}
    )
    row_ids = [row.id for row in rows]
    controls = _controls(db, row_ids)
    comment_counts: dict[str, tuple[int, int]] = {}
    if row_ids:
        for row_id, total in db.execute(
            select(FmeaRowComment.row_id, func.count(FmeaRowComment.id))
            .where(FmeaRowComment.row_id.in_(row_ids))
            .group_by(FmeaRowComment.row_id)
        ).all():
            comment_counts[row_id] = (int(total), 0)
        for row_id, open_count in db.execute(
            select(FmeaRowComment.row_id, func.count(FmeaRowComment.id))
            .where(FmeaRowComment.row_id.in_(row_ids), FmeaRowComment.resolved.is_(False))
            .group_by(FmeaRowComment.row_id)
        ).all():
            total = comment_counts.get(row_id, (0, 0))[0]
            comment_counts[row_id] = (total, int(open_count))
    views = []
    for row in rows:
        item = items.get((row.sheet_id or "", row.item_id or ""))
        sheet, drawing = sheets.get(row.sheet_id or "", (None, None))
        mode = modes.get(row.failure_mode_id or "")
        view = {column.name: getattr(row, column.name) for column in FmeaRow.__table__.columns}
        view.update(
            {
                "item_tag": item.tag if item else row.item_tag_seen,
                "item_category": item.category if item else None,
                "item_symbol": item.symbol_name if item else None,
                "item_zone": item.zone if item else None,
                "item_exists": item is not None or not row.item_id,
                "part_id": item.part_id if item else row.part_id_seen,
                "part_number": parts.get(item.part_id) if item and item.part_id else None,
                "sheet_no": sheet.sheet_no if sheet else None,
                "drawing_id": drawing.id if drawing else None,
                "drawing_number": drawing.number if drawing else None,
                "failure_mode_name": mode.name if mode else None,
                "failure_mode_title": mode.title if mode else row.failure_mode_text,
                "detected_by_tag": (
                    detectors.get((drawing.id, row.detected_by_item_id))
                    if drawing and row.detected_by_item_id
                    else None
                ),
                "hazard_key": hazards.get(row.hazard_id) if row.hazard_id else None,
                "rpn_residual": compute_rpn(
                    row.severity_residual, row.occurrence_residual, row.detection_residual
                ),
                "controls": controls.get(row.id, []),
                "comment_count": comment_counts.get(row.id, (0, 0))[0],
                "open_comment_count": comment_counts.get(row.id, (0, 0))[1],
            }
        )
        views.append(view)
    return views


def worksheet_view(db: Session, worksheet: FmeaWorksheet, settings: dict[str, Any]) -> dict:
    drawing = db.get(Drawing, worksheet.drawing_id) if worksheet.drawing_id else None
    current = latest_revision_label(drawing)
    threshold = int(settings.get("rpn_threshold", 100))
    rows = [row for row in worksheet.rows if not row.not_applicable]
    view = {
        column.name: getattr(worksheet, column.name) for column in FmeaWorksheet.__table__.columns
    }
    view.update(
        {
            "drawing_number": drawing.number if drawing else None,
            "drawing_current_revision_label": current,
            "revision_drift": bool(
                worksheet.drawing_revision_label
                and current
                and worksheet.drawing_revision_label != current
            ),
            "row_count": len(worksheet.rows),
            "stale_count": sum(1 for row in worksheet.rows if row.stale_reason),
            "open_actions": sum(1 for row in rows if row.action_status in {"open", "in_progress"}),
            "above_threshold": sum(1 for row in rows if (row.rpn or 0) >= threshold),
        }
    )
    return view


def release_gate(worksheet: FmeaWorksheet, settings: dict[str, Any]) -> list[dict[str, Any]]:
    """Blocking rows, with a reason each. Empty when the worksheet can be released."""
    severity_min = int(settings.get("fmea_hazard_severity_min", 8))
    blockers: list[dict[str, Any]] = []
    for row in worksheet.rows:
        if row.not_applicable:
            continue
        label = row.item_tag_seen or row.subject_text or row.item_id or row.id[:8]
        if row.stale_reason:
            blockers.append(
                {"row_id": row.id, "item": label, "reason": f"stale ({row.stale_reason})"}
            )
        if row.severity is not None and row.severity >= severity_min and not row.hazard_id:
            blockers.append(
                {
                    "row_id": row.id,
                    "item": label,
                    "reason": f"severity {row.severity} needs a hazard",
                }
            )
        if row.detection_kind == "none" and not (row.detection_reason or "").strip():
            blockers.append(
                {"row_id": row.id, "item": label, "reason": "no detection and no reason recorded"}
            )
        if row.action_status in {"open", "in_progress"} and not (row.action_owner or "").strip():
            blockers.append({"row_id": row.id, "item": label, "reason": "open action has no owner"})
    return blockers


def release(
    db: Session, worksheet: FmeaWorksheet, actor: str | None, note: str | None
) -> FmeaRelease:
    drawing = db.get(Drawing, worksheet.drawing_id) if worksheet.drawing_id else None
    label = latest_revision_label(drawing)
    worksheet.revision = (worksheet.revision or 0) + 1
    worksheet.status = "released"
    worksheet.drawing_revision_label = label or worksheet.drawing_revision_label
    frozen = [_freeze(view) for view in row_views(db, worksheet, list(worksheet.rows))]
    entry = FmeaRelease(
        worksheet_id=worksheet.id,
        revision=worksheet.revision,
        drawing_revision_label=label,
        rows=frozen,
        released_by=actor,
        note=note,
    )
    db.add(entry)
    db.flush()
    return entry


_FROZEN_FIELDS = (
    "id",
    "sheet_id",
    "item_id",
    "item_tag",
    "part_number",
    "failure_mode_id",
    "failure_mode_name",
    "failure_mode_title",
    "operating_modes",
    "cause",
    "local_effect",
    "next_effect",
    "end_effect",
    "detected_by_tag",
    "detection_kind",
    "severity",
    "occurrence",
    "detection",
    "rpn",
    "hazard_key",
    "recommended_action",
    "action_owner",
    "action_status",
    "severity_residual",
    "occurrence_residual",
    "detection_residual",
    "not_applicable",
)


def _freeze(view: dict[str, Any]) -> dict[str, Any]:
    frozen = {field: view.get(field) for field in _FROZEN_FIELDS}
    frozen["controls"] = [control["label"] for control in view.get("controls", [])]
    return frozen


def _diff_key(row: dict[str, Any]) -> tuple:
    return (
        row.get("sheet_id") or "",
        row.get("item_id") or "",
        row.get("failure_mode_id") or (row.get("failure_mode_title") or "").lower(),
        tuple(sorted(row.get("operating_modes") or [])),
    )


def diff(db: Session, worksheet: FmeaWorksheet, against: FmeaRelease) -> dict[str, Any]:
    current = {
        _diff_key(view): _freeze(view) for view in row_views(db, worksheet, list(worksheet.rows))
    }
    previous = {_diff_key(row): row for row in against.rows}
    added = [current[key] for key in current.keys() - previous.keys()]
    removed = [previous[key] for key in previous.keys() - current.keys()]
    changed = []
    compare = (
        "cause",
        "local_effect",
        "next_effect",
        "end_effect",
        "detected_by_tag",
        "severity",
        "occurrence",
        "detection",
        "rpn",
        "hazard_key",
        "recommended_action",
        "action_status",
        "controls",
        "not_applicable",
    )
    for key in current.keys() & previous.keys():
        before, after = previous[key], current[key]
        fields = {
            field: {"from": before.get(field), "to": after.get(field)}
            for field in compare
            if before.get(field) != after.get(field)
        }
        if fields:
            changed.append(
                {
                    "item_tag": after.get("item_tag"),
                    "failure_mode_title": after.get("failure_mode_title"),
                    "fields": fields,
                }
            )
    return {"added": added, "removed": removed, "changed": changed}


def export_rows(views: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for view in views:
        detection = view.get("detected_by_tag") or (
            view.get("detection_kind") if view.get("detection_kind") != "none" else "none"
        )
        if view.get("detection_kind") == "none" and view.get("detection_reason"):
            detection = f"none ({view['detection_reason']})"
        rows.append(
            {
                **view,
                "item_tag": view.get("item_tag") or view.get("subject_text") or "",
                "operating_modes_text": ", ".join(view.get("operating_modes") or []),
                "detection_text": detection,
                "controls_text": ", ".join(c["label"] for c in view.get("controls", [])),
            }
        )
    return rows


def worksheet_hazard_causes(db: Session, hazard_ids: list[str]) -> dict[str, int]:
    if not hazard_ids:
        return {}
    return {
        hazard_id: int(count)
        for hazard_id, count in db.execute(
            select(FmeaRow.hazard_id, func.count(FmeaRow.id))
            .where(FmeaRow.hazard_id.in_(hazard_ids))
            .group_by(FmeaRow.hazard_id)
        ).all()
    }
