"""Design rule check storage: findings and requirement checks replaced on save,
waivers kept by finding key, drawing summaries, and the verification matrix."""

from __future__ import annotations

from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    Drawing,
    DrawingSheet,
    DrcRequirementCheck,
    DrcResult,
    DrcWaiver,
    Hazard,
    Project,
    Requirement,
    RequirementEvidence,
    TraceLink,
)
from app.schemas import DrcIn


def replace_sheet_drc(db: Session, sheet: DrawingSheet, drc: DrcIn) -> None:
    """Replace the stored findings and requirement checks of a sheet."""
    for existing in db.scalars(select(DrcResult).where(DrcResult.sheet_id == sheet.id)):
        db.delete(existing)
    for existing in db.scalars(
        select(DrcRequirementCheck).where(DrcRequirementCheck.sheet_id == sheet.id)
    ):
        db.delete(existing)
    db.flush()
    requirement_ids = {
        requirement_id
        for (requirement_id,) in db.execute(
            select(Requirement.id).where(
                Requirement.id.in_(
                    {check.requirement_id for check in drc.checks}
                    | {f.requirement_id for f in drc.findings if f.requirement_id}
                )
            )
        )
    }
    seen: set[str] = set()
    for finding in drc.findings:
        if finding.key in seen:
            continue
        seen.add(finding.key)
        data = finding.model_dump()
        if data["requirement_id"] not in requirement_ids:
            data["requirement_id"] = None
        db.add(DrcResult(sheet_id=sheet.id, **data))
    for check in drc.checks:
        if check.requirement_id not in requirement_ids:
            continue
        db.add(DrcRequirementCheck(sheet_id=sheet.id, **check.model_dump()))
    db.flush()


def sheet_drc(db: Session, sheet: DrawingSheet) -> dict:
    findings = list(
        db.scalars(
            select(DrcResult)
            .where(DrcResult.sheet_id == sheet.id)
            .order_by(DrcResult.severity, DrcResult.rule, DrcResult.subject)
        )
    )
    waivers = list(db.scalars(select(DrcWaiver).where(DrcWaiver.sheet_id == sheet.id)))
    checks = list(
        db.scalars(select(DrcRequirementCheck).where(DrcRequirementCheck.sheet_id == sheet.id))
    )
    waived_keys = {waiver.key for waiver in waivers}
    open_findings = [finding for finding in findings if finding.key not in waived_keys]
    counts = Counter(finding.severity for finding in open_findings)
    return {
        "sheet_id": sheet.id,
        "sheet_no": sheet.sheet_no,
        "counts": {
            "error": counts.get("error", 0),
            "warning": counts.get("warning", 0),
            "info": counts.get("info", 0),
            "waived": len(findings) - len(open_findings),
        },
        "findings": findings,
        "waivers": waivers,
        "checks": checks,
    }


def drawing_drc(db: Session, drawing: Drawing) -> dict:
    sheets = [sheet_drc(db, sheet) for sheet in drawing.sheets]
    totals: Counter[str] = Counter()
    for entry in sheets:
        totals.update(entry["counts"])
    return {
        "drawing_id": drawing.id,
        "counts": {key: totals.get(key, 0) for key in ("error", "warning", "info", "waived")},
        "sheets": sheets,
    }


def verification_matrix(db: Session, project: Project) -> dict:
    """One row per requirement: constraint checks across the project's drawings and trace links."""
    requirements = list(
        db.scalars(
            select(Requirement)
            .where(Requirement.project_id == project.id)
            .order_by(Requirement.key)
        )
    )
    rows = []
    for requirement in requirements:
        checks = db.execute(
            select(DrcRequirementCheck, DrawingSheet, Drawing)
            .join(DrawingSheet, DrcRequirementCheck.sheet_id == DrawingSheet.id)
            .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
            .where(
                DrcRequirementCheck.requirement_id == requirement.id,
                Drawing.project_id == project.id,
            )
            .order_by(Drawing.number, DrawingSheet.sheet_no)
        ).all()
        by_drawing: dict[str, dict] = {}
        for check, sheet, drawing in checks:
            entry = by_drawing.setdefault(
                drawing.id,
                {
                    "drawing_id": drawing.id,
                    "drawing_number": drawing.number,
                    "checked": 0,
                    "failed": 0,
                    "sheets": [],
                },
            )
            entry["checked"] += 1
            entry["failed"] += check.status == "fail"
            if sheet.sheet_no not in entry["sheets"]:
                entry["sheets"].append(sheet.sheet_no)
        links = list(
            db.scalars(
                select(TraceLink).where(
                    TraceLink.source_type == "requirement",
                    TraceLink.source_id == requirement.id,
                )
            )
        )
        evidence: Counter[str] = Counter(
            kind
            for (kind,) in db.execute(
                select(RequirementEvidence.kind).where(
                    RequirementEvidence.requirement_id == requirement.id
                )
            )
        )
        hazard_ids = [
            link.target_id
            for link in links
            if link.target_type == "hazard" and link.link_type == "mitigates"
        ]
        hazard_keys = (
            sorted(
                key
                for (key,) in db.execute(select(Hazard.key).where(Hazard.id.in_(hazard_ids)))
            )
            if hazard_ids
            else []
        )
        checked = len(checks)
        failed = sum(1 for check, _, _ in checks if check.status == "fail")
        if requirement.constraint is None:
            verdict = "manual"
        elif checked == 0:
            verdict = "no_data"
        elif failed:
            verdict = "fail"
        else:
            verdict = "pass"
        rows.append(
            {
                "requirement_id": requirement.id,
                "key": requirement.key,
                "title": requirement.title,
                "status": requirement.status,
                "constraint": requirement.constraint,
                "checked": checked,
                "passed": checked - failed,
                "failed": failed,
                "verdict": verdict,
                "drawings": list(by_drawing.values()),
                "linked_components": sum(1 for link in links if link.target_type == "component"),
                "linked_drawings": sum(
                    1
                    for link in links
                    if link.target_type in {"drawing", "sheet_item", "sheet_line"}
                ),
                "failures": [check for check, _, _ in checks if check.status == "fail"],
                "category": requirement.category,
                "verification_method": requirement.verification_method,
                "owner": requirement.owner,
                "verification_status": requirement.verification_status,
                "safety_critical": requirement.safety_critical,
                "evidence": dict(evidence),
                "hazards": hazard_keys,
            }
        )
    return {"project_id": project.id, "rows": rows}


def project_findings(db: Session, project: Project) -> dict:
    """Findings and waivers across every drawing of the project, flat, with the
    hazard key a relief finding created."""
    drawings = list(
        db.scalars(
            select(Drawing)
            .where(Drawing.project_id == project.id)
            .options(selectinload(Drawing.sheets))
            .order_by(Drawing.number)
        )
    )
    entries = []
    totals = {"error": 0, "warning": 0, "info": 0, "waived": 0}
    for drawing in drawings:
        summary = drawing_drc(db, drawing)
        for key in totals:
            totals[key] += summary["counts"].get(key, 0)
        for sheet in summary["sheets"]:
            for finding in sheet["findings"]:
                entries.append(
                    {
                        "drawing_id": drawing.id,
                        "drawing_number": drawing.number,
                        "sheet_id": sheet["sheet_id"],
                        "sheet_no": sheet["sheet_no"],
                        "key": finding.key,
                        "rule": finding.rule,
                        "severity": finding.severity,
                        "message": finding.message,
                        "item_id": finding.item_id,
                        "subject": finding.subject,
                        "zone": finding.zone,
                        "requirement_id": finding.requirement_id,
                        "hazard_id": finding.hazard_id,
                        "waived": any(w.key == finding.key for w in sheet["waivers"]),
                        "waiver_reason": next(
                            (w.reason for w in sheet["waivers"] if w.key == finding.key), None
                        ),
                    }
                )
    hazard_keys = {
        hazard.id: hazard.key
        for hazard in db.scalars(select(Hazard).where(Hazard.project_id == project.id))
    }
    for entry in entries:
        entry["hazard_key"] = hazard_keys.get(entry["hazard_id"]) if entry["hazard_id"] else None
    return {"project_id": project.id, "counts": totals, "findings": entries}
