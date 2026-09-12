"""Safety routes: the hazard log, hazard controls, derived requirements,
acceptance, the risk matrix, and per-project safety settings."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes import record_change, require_model
from app.core.security import require_writer
from app.db import get_db
from app.models import (
    FluidSystem,
    Hazard,
    Project,
    Requirement,
    SheetItem,
    TraceLink,
    User,
)
from app.schemas import (
    HazardAcceptIn,
    HazardControlIn,
    HazardCreate,
    HazardDeriveIn,
    HazardMatrixRead,
    HazardRead,
    HazardUpdate,
    RequirementRead,
    SafetySettingsRead,
    SafetySettingsUpdate,
)
from app.services.hazards import (
    default_fault_tolerance,
    hazard_view,
    matrix_counts,
    mitigating_requirement_ids,
    next_hazard_key,
    project_hazards,
    refresh_safety_critical,
)
from app.services.safety_settings import get_settings, save_settings
from app.services.traceability import delete_trace_links_for

safety_router = APIRouter(tags=["safety"])


def _validate_rating(settings: dict, severity: str | None, likelihood: str | None) -> None:
    severities = {entry["code"] for entry in settings["severity_scale"]}
    likelihoods = {entry["code"] for entry in settings["likelihood_scale"]}
    if severity is not None and severity not in severities:
        raise HTTPException(
            status_code=422,
            detail="severity must be one of: " + ", ".join(sorted(severities)),
        )
    if likelihood is not None and likelihood not in likelihoods:
        raise HTTPException(
            status_code=422,
            detail="likelihood must be one of: " + ", ".join(sorted(likelihoods)),
        )


@safety_router.get("/projects/{project_id}/safety-settings", response_model=SafetySettingsRead)
def get_safety_settings(project_id: str, db: Session = Depends(get_db)) -> dict:
    project = require_model(db, Project, project_id)
    return {"project_id": project.id, "settings": get_settings(db, project)}


@safety_router.put("/projects/{project_id}/safety-settings", response_model=SafetySettingsRead)
def update_safety_settings(
    project_id: str,
    payload: SafetySettingsUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    project = require_model(db, Project, project_id)
    settings = save_settings(db, project, payload.settings)
    record_change(
        db, "project", project.id, "updated", "Updated safety settings", actor=user.email
    )
    db.commit()
    return {"project_id": project.id, "settings": settings}


@safety_router.get("/projects/{project_id}/hazards", response_model=list[HazardRead])
def list_hazards(
    project_id: str,
    category: str | None = None,
    status: str | None = None,
    computed_status: str | None = None,
    system_id: str | None = None,
    severity: str | None = None,
    mode: str | None = None,
    db: Session = Depends(get_db),
) -> list[dict]:
    project = require_model(db, Project, project_id)
    return project_hazards(
        db,
        project,
        category=category,
        status=status,
        computed_status=computed_status,
        system_id=system_id,
        severity_initial=severity,
        mode=mode,
    )


@safety_router.get("/projects/{project_id}/hazards/matrix", response_model=HazardMatrixRead)
def hazard_matrix(project_id: str, db: Session = Depends(get_db)) -> dict:
    return matrix_counts(db, require_model(db, Project, project_id))


@safety_router.post(
    "/projects/{project_id}/hazards", response_model=HazardRead, status_code=201
)
def create_hazard(
    project_id: str,
    payload: HazardCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    project = require_model(db, Project, project_id)
    settings = get_settings(db, project)
    _validate_rating(settings, payload.severity_initial, payload.likelihood_initial)
    _validate_rating(settings, payload.severity_residual, payload.likelihood_residual)
    if payload.system_id is not None:
        system = require_model(db, FluidSystem, payload.system_id)
        if system.project_id != project.id:
            raise HTTPException(status_code=422, detail="system_id belongs to another project")
    data = payload.model_dump()
    if data.get("fault_tolerance_required") is None:
        data["fault_tolerance_required"] = default_fault_tolerance(
            settings, payload.severity_initial
        )
    hazard = Hazard(project_id=project.id, key=next_hazard_key(db, project.id), **data)
    db.add(hazard)
    db.flush()
    record_change(
        db, "hazard", hazard.id, "created", f"Created hazard {hazard.key}", actor=user.email
    )
    db.commit()
    db.refresh(hazard)
    return hazard_view(db, hazard, settings)


@safety_router.get("/hazards/{hazard_id}", response_model=HazardRead)
def get_hazard(hazard_id: str, db: Session = Depends(get_db)) -> dict:
    hazard = require_model(db, Hazard, hazard_id)
    project = require_model(db, Project, hazard.project_id)
    return hazard_view(db, hazard, get_settings(db, project))


@safety_router.put("/hazards/{hazard_id}", response_model=HazardRead)
def update_hazard(
    hazard_id: str,
    payload: HazardUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    hazard = require_model(db, Hazard, hazard_id)
    project = require_model(db, Project, hazard.project_id)
    settings = get_settings(db, project)
    data = payload.model_dump(exclude_unset=True)
    _validate_rating(settings, data.get("severity_initial"), data.get("likelihood_initial"))
    _validate_rating(settings, data.get("severity_residual"), data.get("likelihood_residual"))
    if data.get("system_id") is not None:
        system = require_model(db, FluidSystem, data["system_id"])
        if system.project_id != project.id:
            raise HTTPException(status_code=422, detail="system_id belongs to another project")
    if data.get("status") == "accepted" and hazard.status != "accepted":
        raise HTTPException(
            status_code=422, detail="Use the accept action to accept a hazard with a justification"
        )
    severity_changed = "severity_initial" in data and data["severity_initial"] != (
        hazard.severity_initial
    )
    for field, value in data.items():
        setattr(hazard, field, value)
    if severity_changed and "fault_tolerance_required" not in data:
        hazard.fault_tolerance_required = default_fault_tolerance(
            settings, hazard.severity_initial
        )
    db.flush()
    if severity_changed:
        refresh_safety_critical(db, mitigating_requirement_ids(db, hazard))
    record_change(
        db, "hazard", hazard.id, "updated", f"Updated hazard {hazard.key}", actor=user.email
    )
    db.commit()
    db.refresh(hazard)
    return hazard_view(db, hazard, settings)


@safety_router.delete("/hazards/{hazard_id}", status_code=204)
def delete_hazard(
    hazard_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    hazard = require_model(db, Hazard, hazard_id)
    affected = mitigating_requirement_ids(db, hazard)
    delete_trace_links_for(db, "hazard", hazard.id)
    db.flush()
    refresh_safety_critical(db, affected)
    record_change(
        db, "hazard", hazard.id, "deleted", f"Deleted hazard {hazard.key}", actor=user.email
    )
    db.delete(hazard)
    db.commit()
    return Response(status_code=204)


@safety_router.post("/hazards/{hazard_id}/controls", response_model=HazardRead, status_code=201)
def add_hazard_control(
    hazard_id: str,
    payload: HazardControlIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    hazard = require_model(db, Hazard, hazard_id)
    project = require_model(db, Project, hazard.project_id)
    if payload.type == "requirement":
        requirement = require_model(db, Requirement, payload.id)
        if requirement.project_id != hazard.project_id:
            raise HTTPException(status_code=422, detail="Requirement belongs to another project")
        link_type = "mitigates"
        label = requirement.key
    else:
        item = require_model(db, SheetItem, payload.id)
        link_type = "controls"
        label = item.tag or item.item_id
    existing = db.scalar(
        select(TraceLink).where(
            TraceLink.source_type == payload.type,
            TraceLink.source_id == payload.id,
            TraceLink.target_type == "hazard",
            TraceLink.target_id == hazard.id,
            TraceLink.link_type == link_type,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="This control is already linked")
    db.add(
        TraceLink(
            source_type=payload.type,
            source_id=payload.id,
            target_type="hazard",
            target_id=hazard.id,
            link_type=link_type,
        )
    )
    db.flush()
    if payload.type == "requirement":
        refresh_safety_critical(db, {payload.id})
    record_change(
        db,
        "hazard",
        hazard.id,
        "updated",
        f"Added control {label} to hazard {hazard.key}",
        actor=user.email,
    )
    db.commit()
    return hazard_view(db, hazard, get_settings(db, project))


@safety_router.delete("/hazards/{hazard_id}/controls/{link_id}", response_model=HazardRead)
def remove_hazard_control(
    hazard_id: str,
    link_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    hazard = require_model(db, Hazard, hazard_id)
    project = require_model(db, Project, hazard.project_id)
    link = require_model(db, TraceLink, link_id)
    if link.target_type != "hazard" or link.target_id != hazard.id:
        raise HTTPException(status_code=404, detail="Control link not found on this hazard")
    source_type, source_id = link.source_type, link.source_id
    db.delete(link)
    db.flush()
    if source_type == "requirement":
        refresh_safety_critical(db, {source_id})
    record_change(
        db,
        "hazard",
        hazard.id,
        "updated",
        f"Removed a control from hazard {hazard.key}",
        actor=user.email,
    )
    db.commit()
    return hazard_view(db, hazard, get_settings(db, project))


@safety_router.post(
    "/hazards/{hazard_id}/derive-requirement", response_model=RequirementRead, status_code=201
)
def derive_requirement(
    hazard_id: str,
    payload: HazardDeriveIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Requirement:
    """Create a safety requirement that controls this hazard, in one step."""
    hazard = require_model(db, Hazard, hazard_id)
    duplicate = db.scalar(
        select(Requirement).where(
            Requirement.project_id == hazard.project_id, Requirement.key == payload.key
        )
    )
    if duplicate:
        raise HTTPException(status_code=409, detail="Requirement key already exists in project")
    requirement = Requirement(
        project_id=hazard.project_id,
        key=payload.key,
        title=payload.title,
        text=payload.text,
        requirement_type=payload.category,
        category=payload.category,
        verification_method=payload.verification_method,
        rationale=f"Controls {hazard.key}: {hazard.title}",
        status="draft",
    )
    db.add(requirement)
    db.flush()
    db.add(
        TraceLink(
            source_type="requirement",
            source_id=requirement.id,
            target_type="hazard",
            target_id=hazard.id,
            link_type="mitigates",
            rationale=f"Derived from {hazard.key}",
        )
    )
    db.flush()
    refresh_safety_critical(db, {requirement.id})
    record_change(
        db,
        "requirement",
        requirement.id,
        "created",
        f"Derived requirement {requirement.key} from hazard {hazard.key}",
        actor=user.email,
    )
    db.commit()
    db.refresh(requirement)
    return requirement


@safety_router.post("/hazards/{hazard_id}/accept", response_model=HazardRead)
def accept_hazard(
    hazard_id: str,
    payload: HazardAcceptIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    hazard = require_model(db, Hazard, hazard_id)
    project = require_model(db, Project, hazard.project_id)
    hazard.status = "accepted"
    hazard.accepted_by = user.email
    hazard.accepted_at = datetime.now(UTC)
    hazard.acceptance_justification = payload.justification
    record_change(
        db,
        "hazard",
        hazard.id,
        "updated",
        f"Accepted hazard {hazard.key}: {payload.justification}",
        actor=user.email,
    )
    db.commit()
    db.refresh(hazard)
    return hazard_view(db, hazard, get_settings(db, project))
