"""Hazard log: key generation, the computed control state of a hazard, the
risk matrix counts, and the safety-critical flag on requirements.

A hazard is *controlled* when every control resolves to a verified (or
waived) requirement, hardware controls are covered by a requirement, and the
number of independent controls meets the project's fault-tolerance policy.
``status`` stays a human act (open, accepted, closed)."""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    DrcRequirementCheck,
    Hazard,
    Project,
    Requirement,
    SheetItem,
    TraceLink,
)
from app.services.safety_settings import fault_tolerance_for, get_settings, risk_class

CONTROL_LINK_TYPES = ("mitigates", "controls")
SAFETY_CRITICAL_SEVERITIES = {"I", "II"}
_KEY_RE = re.compile(r"^HZ-(\d+)$")


def next_hazard_key(db: Session, project_id: str) -> str:
    highest = 0
    for (key,) in db.execute(select(Hazard.key).where(Hazard.project_id == project_id)):
        match = _KEY_RE.match(key or "")
        if match:
            highest = max(highest, int(match.group(1)))
    return f"HZ-{highest + 1:03d}"


def control_links(db: Session, hazard: Hazard) -> list[TraceLink]:
    return list(
        db.scalars(
            select(TraceLink).where(
                TraceLink.target_type == "hazard",
                TraceLink.target_id == hazard.id,
                TraceLink.link_type.in_(CONTROL_LINK_TYPES),
            )
        )
    )


def _covering_requirements(db: Session, item: SheetItem) -> list[Requirement]:
    """Requirements that apply to a sheet item: a DRC check on it, or a trace link to it."""
    checked_ids = {
        requirement_id
        for (requirement_id,) in db.execute(
            select(DrcRequirementCheck.requirement_id).where(
                DrcRequirementCheck.sheet_id == item.sheet_id,
                DrcRequirementCheck.item_id == item.item_id,
            )
        )
    }
    linked_ids = {
        source_id
        for (source_id,) in db.execute(
            select(TraceLink.source_id).where(
                TraceLink.source_type == "requirement",
                TraceLink.target_type == "sheet_item",
                TraceLink.target_id == item.id,
            )
        )
    }
    ids = checked_ids | linked_ids
    if not ids:
        return []
    return list(db.scalars(select(Requirement).where(Requirement.id.in_(ids))))


def _status_of(requirements: list[Requirement]) -> str:
    statuses = {requirement.verification_status for requirement in requirements}
    if statuses & {"verified", "waived"}:
        return "verified"
    if "failed" in statuses:
        return "failed"
    if "in_progress" in statuses:
        return "in_progress"
    return "planned"


def resolve_controls(db: Session, hazard: Hazard) -> list[dict[str, Any]]:
    controls: list[dict[str, Any]] = []
    for link in control_links(db, hazard):
        if link.source_type == "requirement":
            requirement = db.get(Requirement, link.source_id)
            if requirement is None:
                continue
            controls.append(
                {
                    "link_id": link.id,
                    "type": "requirement",
                    "id": requirement.id,
                    "label": requirement.key,
                    "title": requirement.title,
                    "verification_status": requirement.verification_status,
                    "covered": True,
                    "covering_requirements": [],
                }
            )
        elif link.source_type == "sheet_item":
            item = db.get(SheetItem, link.source_id)
            if item is None:
                continue
            covering = _covering_requirements(db, item)
            controls.append(
                {
                    "link_id": link.id,
                    "type": "sheet_item",
                    "id": item.id,
                    "label": item.tag or item.label or item.item_id,
                    "title": item.symbol_name,
                    "verification_status": _status_of(covering) if covering else "uncovered",
                    "covered": bool(covering),
                    "covering_requirements": sorted(r.key for r in covering),
                }
            )
    return controls


def hazard_view(db: Session, hazard: Hazard, settings: dict[str, Any]) -> dict[str, Any]:
    controls = resolve_controls(db, hazard)
    verified = [c for c in controls if c["verification_status"] == "verified"]
    independent = len({(c["type"], c["id"]) for c in controls})
    if hazard.status in {"accepted", "closed"}:
        computed = hazard.status
    elif (
        controls
        and len(verified) == len(controls)
        and independent >= (hazard.fault_tolerance_required or 1)
    ):
        computed = "controlled"
    else:
        computed = "open"
    view = {
        column.name: getattr(hazard, column.name) for column in Hazard.__table__.columns
    }
    view.update(
        {
            "computed_status": computed,
            "risk_initial": risk_class(
                settings, hazard.severity_initial, hazard.likelihood_initial
            ),
            "risk_residual": risk_class(
                settings, hazard.severity_residual, hazard.likelihood_residual
            ),
            "controls_total": len(controls),
            "controls_verified": len(verified),
            "independent_controls": independent,
            "controls": controls,
            "causes": 0,
        }
    )
    return view


def project_hazards(db: Session, project: Project, **filters: Any) -> list[dict[str, Any]]:
    settings = get_settings(db, project)
    query = select(Hazard).where(Hazard.project_id == project.id).order_by(Hazard.key)
    for field in ("category", "status", "system_id", "severity_initial"):
        value = filters.get(field)
        if value:
            query = query.where(getattr(Hazard, field) == value)
    views = [hazard_view(db, hazard, settings) for hazard in db.scalars(query)]
    mode = filters.get("mode")
    if mode:
        views = [view for view in views if mode in (view.get("operating_modes") or [])]
    computed = filters.get("computed_status")
    if computed:
        views = [view for view in views if view["computed_status"] == computed]
    return views


def default_fault_tolerance(settings: dict[str, Any], severity: str | None) -> int:
    return fault_tolerance_for(settings, severity)


def matrix_counts(db: Session, project: Project) -> dict[str, Any]:
    settings = get_settings(db, project)
    severities = [entry["code"] for entry in settings["severity_scale"]]
    likelihoods = [entry["code"] for entry in settings["likelihood_scale"]]
    empty = {severity: {likelihood: 0 for likelihood in likelihoods} for severity in severities}
    initial = {s: dict(row) for s, row in empty.items()}
    residual = {s: dict(row) for s, row in empty.items()}
    unrated = 0
    for hazard in db.scalars(select(Hazard).where(Hazard.project_id == project.id)):
        if hazard.severity_initial in initial and hazard.likelihood_initial in likelihoods:
            initial[hazard.severity_initial][hazard.likelihood_initial] += 1
        else:
            unrated += 1
        severity = hazard.severity_residual or hazard.severity_initial
        likelihood = hazard.likelihood_residual or hazard.likelihood_initial
        if severity in residual and likelihood in likelihoods:
            residual[severity][likelihood] += 1
    return {
        "project_id": project.id,
        "severity_scale": settings["severity_scale"],
        "likelihood_scale": settings["likelihood_scale"],
        "risk_matrix": settings["risk_matrix"],
        "initial": initial,
        "residual": residual,
        "unrated": unrated,
    }


def refresh_safety_critical(db: Session, requirement_ids: set[str]) -> None:
    """A requirement is safety-critical when it mitigates a severity I or II hazard."""
    if not requirement_ids:
        return
    for requirement in db.scalars(select(Requirement).where(Requirement.id.in_(requirement_ids))):
        hazard_ids = {
            target_id
            for (target_id,) in db.execute(
                select(TraceLink.target_id).where(
                    TraceLink.source_type == "requirement",
                    TraceLink.source_id == requirement.id,
                    TraceLink.target_type == "hazard",
                    TraceLink.link_type == "mitigates",
                )
            )
        }
        critical = False
        if hazard_ids:
            critical = any(
                hazard.severity_initial in SAFETY_CRITICAL_SEVERITIES
                for hazard in db.scalars(select(Hazard).where(Hazard.id.in_(hazard_ids)))
            )
        requirement.safety_critical = critical
    db.flush()


def mitigating_requirement_ids(db: Session, hazard: Hazard) -> set[str]:
    return {
        source_id
        for (source_id,) in db.execute(
            select(TraceLink.source_id).where(
                TraceLink.source_type == "requirement",
                TraceLink.target_type == "hazard",
                TraceLink.target_id == hazard.id,
                TraceLink.link_type == "mitigates",
            )
        )
    }
