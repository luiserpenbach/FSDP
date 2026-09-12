"""Change impact: from a part, sheet item, line, requirement, hazard, or FMEA
row, walk the digital thread and list what a change touches."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Analysis,
    BomSnapshot,
    ComponentInstance,
    Drawing,
    DrawingSheet,
    FmeaRow,
    FmeaWorksheet,
    Hazard,
    Requirement,
    RequirementEvidence,
    SheetItem,
    SheetLine,
    TraceLink,
)
from app.services.traceability import get_trace_links


def _item_brief(db: Session, item: SheetItem) -> dict[str, Any]:
    sheet = db.get(DrawingSheet, item.sheet_id)
    drawing = db.get(Drawing, sheet.drawing_id) if sheet else None
    return {
        "id": item.id,
        "item_id": item.item_id,
        "sheet_id": item.sheet_id,
        "sheet_no": sheet.sheet_no if sheet else None,
        "drawing_id": drawing.id if drawing else None,
        "drawing_number": drawing.number if drawing else None,
        "tag": item.tag or item.label or item.item_id,
        "volume_key": (item.fields or {}).get("volume_key"),
    }


def _row_brief(db: Session, row: FmeaRow) -> dict[str, Any]:
    worksheet = db.get(FmeaWorksheet, row.worksheet_id)
    return {
        "id": row.id,
        "worksheet_id": row.worksheet_id,
        "worksheet_title": worksheet.title if worksheet else None,
        "item_tag": row.item_tag_seen or row.subject_text,
        "failure_mode": (row.failure_mode.title if row.failure_mode else row.failure_mode_text),
        "rpn": row.rpn,
        "stale_reason": row.stale_reason,
        "hazard_id": row.hazard_id,
    }


def _hazard_brief(hazard: Hazard) -> dict[str, Any]:
    return {
        "id": hazard.id,
        "key": hazard.key,
        "title": hazard.title,
        "severity_initial": hazard.severity_initial,
        "status": hazard.status,
    }


def _requirement_brief(requirement: Requirement) -> dict[str, Any]:
    return {
        "id": requirement.id,
        "key": requirement.key,
        "title": requirement.title,
        "verification_status": requirement.verification_status,
        "safety_critical": requirement.safety_critical,
    }


def get_change_impact(db: Session, object_type: str, object_id: str) -> dict:
    direct_links = get_trace_links(db, object_type, object_id)
    affected_components: list[ComponentInstance] = []
    affected_bom_snapshots: list[BomSnapshot] = []
    items: dict[str, SheetItem] = {}
    rows: dict[str, FmeaRow] = {}
    hazards: dict[str, Hazard] = {}
    requirements: dict[str, Requirement] = {}
    analyses: dict[str, Analysis] = {}

    def add_items(found: list[SheetItem]) -> None:
        for item in found:
            items[item.id] = item

    if object_type == "part":
        affected_components = list(
            db.scalars(select(ComponentInstance).where(ComponentInstance.part_id == object_id))
        )
        diagram_ids = {component.diagram_id for component in affected_components}
        if diagram_ids:
            affected_bom_snapshots = list(
                db.scalars(select(BomSnapshot).where(BomSnapshot.diagram_id.in_(diagram_ids)))
            )
        add_items(list(db.scalars(select(SheetItem).where(SheetItem.part_id == object_id))))
    elif object_type == "component":
        component = db.get(ComponentInstance, object_id)
        if component:
            affected_components = [component]
            affected_bom_snapshots = list(
                db.scalars(
                    select(BomSnapshot).where(BomSnapshot.diagram_id == component.diagram_id)
                )
            )
    elif object_type == "sheet_item":
        item = db.get(SheetItem, object_id)
        if item:
            add_items([item])
    elif object_type == "sheet_line":
        line = db.get(SheetLine, object_id)
        if line:
            found = list(
                db.scalars(
                    select(SheetItem).where(
                        SheetItem.sheet_id == line.sheet_id,
                        SheetItem.item_id.in_([i for i in (line.from_item, line.to_item) if i]),
                    )
                )
            )
            add_items(found)
    elif object_type == "requirement":
        requirement = db.get(Requirement, object_id)
        if requirement:
            requirements[requirement.id] = requirement
    elif object_type == "hazard":
        hazard = db.get(Hazard, object_id)
        if hazard:
            hazards[hazard.id] = hazard
    elif object_type == "fmea_row":
        row = db.get(FmeaRow, object_id)
        if row:
            rows[row.id] = row

    # items -> FMEA rows (by sheet/item), hazards (controls), analyses on the sheet
    if items:
        for item in items.values():
            for row in db.scalars(
                select(FmeaRow).where(
                    FmeaRow.sheet_id == item.sheet_id, FmeaRow.item_id == item.item_id
                )
            ):
                rows[row.id] = row
            for link in db.scalars(
                select(TraceLink).where(
                    TraceLink.source_type == "sheet_item",
                    TraceLink.source_id == item.id,
                    TraceLink.target_type == "hazard",
                )
            ):
                hazard = db.get(Hazard, link.target_id)
                if hazard:
                    hazards[hazard.id] = hazard
            for analysis in db.scalars(select(Analysis).where(Analysis.sheet_id == item.sheet_id)):
                analyses[analysis.id] = analysis
    # rows -> hazards
    for row in list(rows.values()):
        if row.hazard_id:
            hazard = db.get(Hazard, row.hazard_id)
            if hazard:
                hazards[hazard.id] = hazard
    # hazards -> controlling requirements and rows that cause them
    for hazard in list(hazards.values()):
        for link in db.scalars(
            select(TraceLink).where(
                TraceLink.target_type == "hazard",
                TraceLink.target_id == hazard.id,
                TraceLink.source_type == "requirement",
            )
        ):
            requirement = db.get(Requirement, link.source_id)
            if requirement:
                requirements[requirement.id] = requirement
        if object_type == "hazard":
            for row in db.scalars(select(FmeaRow).where(FmeaRow.hazard_id == hazard.id)):
                rows[row.id] = row
    # requirement -> hazards it mitigates (when starting from a requirement)
    if object_type == "requirement":
        for link in db.scalars(
            select(TraceLink).where(
                TraceLink.source_type == "requirement",
                TraceLink.source_id == object_id,
                TraceLink.target_type == "hazard",
            )
        ):
            hazard = db.get(Hazard, link.target_id)
            if hazard:
                hazards[hazard.id] = hazard
    # requirements -> evidence from analyses
    for requirement in list(requirements.values()):
        for evidence in db.scalars(
            select(RequirementEvidence).where(
                RequirementEvidence.requirement_id == requirement.id,
                RequirementEvidence.kind == "analysis",
            )
        ):
            analysis = db.get(Analysis, evidence.ref_id) if evidence.ref_id else None
            if analysis:
                analyses[analysis.id] = analysis

    return {
        "object_type": object_type,
        "object_id": object_id,
        "direct_links": direct_links,
        "affected_bom_snapshots": affected_bom_snapshots,
        "affected_components": affected_components,
        "affected_items": [_item_brief(db, item) for item in items.values()],
        "affected_fmea_rows": [_row_brief(db, row) for row in rows.values()],
        "affected_hazards": [_hazard_brief(hazard) for hazard in hazards.values()],
        "affected_requirements": [_requirement_brief(r) for r in requirements.values()],
        "affected_analyses": [
            {
                "id": a.id,
                "kind": a.kind,
                "title": a.title,
                "verdict": a.verdict,
                "outdated": a.outdated,
            }
            for a in analyses.values()
        ],
    }
