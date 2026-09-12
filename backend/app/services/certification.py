"""Certification evidence: what a project can already show (released
worksheets, accepted hazards, verified safety requirements, analyses,
packages) and the gaps that stand between it and a complete evidence set."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    Analysis,
    Drawing,
    FmeaWorksheet,
    Project,
    Requirement,
    SafetyPackage,
)
from app.services.analyses import analysis_view
from app.services.drc import project_findings
from app.services.fmea import latest_revision_label
from app.services.hazards import project_hazards
from app.services.safety_package import package_view


def evidence(db: Session, project: Project) -> dict[str, Any]:
    gaps: list[dict[str, Any]] = []

    hazards = project_hazards(db, project)
    accepted = [
        {
            "id": h["id"],
            "key": h["key"],
            "title": h["title"],
            "severity_initial": h.get("severity_initial"),
            "risk_residual": h.get("risk_residual"),
            "accepted_by": h.get("accepted_by"),
            "accepted_at": h.get("accepted_at"),
            "status": h["computed_status"],
        }
        for h in hazards
        if h["computed_status"] in {"accepted", "closed"}
    ]
    for hazard in hazards:
        if hazard.get("severity_initial") in {"I", "II"} and hazard["computed_status"] not in {
            "accepted",
            "closed",
        }:
            gaps.append(
                {
                    "kind": "hazard_not_accepted",
                    "ref_type": "hazard",
                    "ref_id": hazard["id"],
                    "key": hazard["key"],
                    "title": hazard["title"],
                    "detail": (
                        f"severity {hazard['severity_initial']} hazard is "
                        f"{hazard['computed_status']}; {hazard['independent_controls']} of "
                        f"{hazard['fault_tolerance_required']} independent controls verified"
                    ),
                }
            )

    requirements = list(
        db.scalars(
            select(Requirement)
            .where(Requirement.project_id == project.id)
            .order_by(Requirement.key)
        )
    )
    verified = [
        {
            "id": r.id,
            "key": r.key,
            "title": r.title,
            "verification_method": r.verification_method,
            "verification_status": r.verification_status,
            "safety_critical": r.safety_critical,
        }
        for r in requirements
        if r.safety_critical and r.verification_status in {"verified", "waived"}
    ]
    for requirement in requirements:
        if requirement.safety_critical and requirement.verification_status not in {
            "verified",
            "waived",
        }:
            gaps.append(
                {
                    "kind": "requirement_not_verified",
                    "ref_type": "requirement",
                    "ref_id": requirement.id,
                    "key": requirement.key,
                    "title": requirement.title,
                    "detail": f"safety-critical, verification {requirement.verification_status}",
                }
            )

    drawings = {
        drawing.id: drawing
        for drawing in db.scalars(
            select(Drawing)
            .where(Drawing.project_id == project.id)
            .options(selectinload(Drawing.revisions))
        )
    }
    worksheets = list(
        db.scalars(
            select(FmeaWorksheet)
            .where(FmeaWorksheet.project_id == project.id)
            .options(selectinload(FmeaWorksheet.releases), selectinload(FmeaWorksheet.rows))
            .order_by(FmeaWorksheet.title)
        )
    )
    released = []
    for worksheet in worksheets:
        drawing = drawings.get(worksheet.drawing_id) if worksheet.drawing_id else None
        current_label = latest_revision_label(drawing)
        latest = max(worksheet.releases, key=lambda r: r.revision, default=None)
        stale_rows = sum(1 for row in worksheet.rows if row.stale_reason)
        if latest is not None:
            released.append(
                {
                    "id": worksheet.id,
                    "title": worksheet.title,
                    "revision": latest.revision,
                    "released_by": latest.released_by,
                    "released_at": latest.created_at,
                    "drawing_number": drawing.number if drawing else None,
                    "drawing_revision": latest.drawing_revision_label,
                    "current_drawing_revision": current_label,
                    "behind_drawing": bool(
                        current_label and latest.drawing_revision_label != current_label
                    ),
                    "status": worksheet.status,
                }
            )
        if latest is None:
            gaps.append(
                {
                    "kind": "worksheet_not_released",
                    "ref_type": "fmea_worksheet",
                    "ref_id": worksheet.id,
                    "key": None,
                    "title": worksheet.title,
                    "detail": f"{worksheet.status}, never released ({len(worksheet.rows)} rows)",
                }
            )
        elif current_label and latest.drawing_revision_label != current_label:
            gaps.append(
                {
                    "kind": "worksheet_behind_drawing",
                    "ref_type": "fmea_worksheet",
                    "ref_id": worksheet.id,
                    "key": None,
                    "title": worksheet.title,
                    "detail": (
                        f"released against drawing rev {latest.drawing_revision_label or '-'}, "
                        f"drawing is at rev {current_label}"
                        + (f"; {stale_rows} stale row(s)" if stale_rows else "")
                    ),
                }
            )

    analyses = [
        analysis_view(db, analysis)
        for analysis in db.scalars(
            select(Analysis).where(Analysis.project_id == project.id).order_by(Analysis.created_at)
        )
    ]
    analysis_rows = [
        {
            "id": a["id"],
            "kind": a["kind"],
            "title": a["title"],
            "verdict": a.get("verdict"),
            "outdated": a.get("outdated"),
            "drawing_number": a.get("drawing_number"),
            "evidence_for": a.get("evidence_for") or [],
        }
        for a in analyses
    ]
    for analysis in analyses:
        if analysis.get("outdated"):
            gaps.append(
                {
                    "kind": "analysis_outdated",
                    "ref_type": "analysis",
                    "ref_id": analysis["id"],
                    "key": None,
                    "title": analysis["title"],
                    "detail": "the sheet changed after the last run",
                }
            )
        elif analysis.get("verdict") == "fail":
            gaps.append(
                {
                    "kind": "analysis_failed",
                    "ref_type": "analysis",
                    "ref_id": analysis["id"],
                    "key": None,
                    "title": analysis["title"],
                    "detail": "last run failed",
                }
            )

    drc = project_findings(db, project)
    for finding in drc["findings"]:
        if finding["severity"] == "error" and not finding["waived"]:
            gaps.append(
                {
                    "kind": "drc_error",
                    "ref_type": "sheet",
                    "ref_id": finding["sheet_id"],
                    "key": f"{finding['drawing_number']} sh {finding['sheet_no']}",
                    "title": finding["rule"].replace("_", " "),
                    "detail": finding["message"],
                }
            )

    packages = [
        package_view(package)
        for package in db.scalars(
            select(SafetyPackage)
            .where(SafetyPackage.project_id == project.id)
            .order_by(SafetyPackage.generated_at.desc())
        )
    ]
    if not packages:
        gaps.append(
            {
                "kind": "no_package",
                "ref_type": "project",
                "ref_id": project.id,
                "key": None,
                "title": "No safety review package",
                "detail": "generate one on the Reviews page",
            }
        )

    counts = {
        "hazards": len(hazards),
        "hazards_accepted": len(accepted),
        "requirements_safety": sum(1 for r in requirements if r.safety_critical),
        "requirements_verified": len(verified),
        "worksheets": len(worksheets),
        "worksheets_released": len(released),
        "analyses": len(analyses),
        "packages": len(packages),
        "gaps": len(gaps),
    }
    return {
        "project_id": project.id,
        "ready": not gaps,
        "counts": counts,
        "released_worksheets": released,
        "accepted_hazards": accepted,
        "verified_requirements": verified,
        "analyses": analysis_rows,
        "packages": packages,
        "gaps": gaps,
    }
