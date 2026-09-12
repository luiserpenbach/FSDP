"""Safety routes: the hazard log, hazard controls, derived requirements,
acceptance, the risk matrix, and per-project safety settings."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.routes import record_change, require_model
from app.core.security import require_admin, require_safety_approver, require_writer
from app.db import get_db
from app.models import (
    Drawing,
    DrawingSheet,
    FailureMode,
    FluidSystem,
    FmeaRelease,
    FmeaRow,
    FmeaRowComment,
    FmeaWorksheet,
    Hazard,
    Project,
    Requirement,
    SheetItem,
    TraceLink,
    User,
)
from app.schemas import (
    FailureModeCreate,
    FailureModeRead,
    FailureModeUpdate,
    FmeaBulkIn,
    FmeaCommentCreate,
    FmeaCommentRead,
    FmeaCommentUpdate,
    FmeaDiffRead,
    FmeaGateRead,
    FmeaGenerateIn,
    FmeaGenerateRead,
    FmeaReleaseIn,
    FmeaReleaseRead,
    FmeaRowControlIn,
    FmeaRowIn,
    FmeaRowRead,
    FmeaWorksheetCreate,
    FmeaWorksheetRead,
    FmeaWorksheetUpdate,
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
    SheetItemRefRead,
)
from app.services.export import svg_to_pdf
from app.services.failure_modes import library
from app.services.fmea import (
    EXPORT_COLUMNS as FMEA_EXPORT_COLUMNS,
)
from app.services.fmea import (
    apply_row,
    confirm_row,
    diff,
    generate_rows,
    latest_revision_label,
    release,
    release_gate,
    row_views,
    validate_row,
    worksheet_view,
)
from app.services.fmea import (
    export_rows as fmea_export_rows,
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
from app.services.lists import list_filename, rows_to_csv, rows_to_xlsx
from app.services.safety_settings import get_settings, save_settings
from app.services.svg_tables import table_pages
from app.services.traceability import delete_trace_links_for, delete_trace_links_for_many

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
    record_change(db, "project", project.id, "updated", "Updated safety settings", actor=user.email)
    db.commit()
    return {"project_id": project.id, "settings": settings}


@safety_router.get("/projects/{project_id}/sheet-items", response_model=list[SheetItemRefRead])
def list_sheet_items(
    project_id: str,
    q: str | None = None,
    category: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
) -> list[dict]:
    """Tagged items across the project's drawings, for pickers."""
    require_model(db, Project, project_id)
    query = (
        select(SheetItem, DrawingSheet, Drawing)
        .join(DrawingSheet, SheetItem.sheet_id == DrawingSheet.id)
        .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
        .where(Drawing.project_id == project_id, SheetItem.dnp.is_(False))
    )
    if category:
        query = query.where(SheetItem.category == category)
    if q:
        pattern = f"%{q.strip()}%"
        query = query.where(
            or_(
                SheetItem.tag.ilike(pattern),
                SheetItem.label.ilike(pattern),
                SheetItem.symbol_name.ilike(pattern),
            )
        )
    rows = db.execute(
        query.order_by(Drawing.number, DrawingSheet.sheet_no, SheetItem.tag).limit(
            max(1, min(limit, 500))
        )
    ).all()
    return [
        {
            "id": item.id,
            "sheet_id": sheet.id,
            "item_id": item.item_id,
            "tag": item.tag,
            "label": item.label,
            "category": item.category,
            "symbol_name": item.symbol_name,
            "zone": item.zone,
            "part_id": item.part_id,
            "drawing_id": drawing.id,
            "drawing_number": drawing.number,
            "sheet_no": sheet.sheet_no,
        }
        for item, sheet, drawing in rows
    ]


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


@safety_router.post("/projects/{project_id}/hazards", response_model=HazardRead, status_code=201)
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
        hazard.fault_tolerance_required = default_fault_tolerance(settings, hazard.severity_initial)
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


# ---- Failure-mode library ----


@safety_router.get("/failure-modes", response_model=list[FailureModeRead])
def list_failure_modes(db: Session = Depends(get_db)) -> list[FailureMode]:
    entries = library(db)
    db.commit()
    return entries


@safety_router.post("/failure-modes", response_model=FailureModeRead, status_code=201)
def create_failure_mode(
    payload: FailureModeCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> FailureMode:
    library(db)
    entry = FailureMode(**payload.model_dump())
    db.add(entry)
    db.flush()
    record_change(
        db,
        "failure_mode",
        entry.id,
        "created",
        f"Added failure mode {entry.name}",
        actor=user.email,
    )
    db.commit()
    db.refresh(entry)
    return entry


@safety_router.put("/failure-modes/{mode_id}", response_model=FailureModeRead)
def update_failure_mode(
    mode_id: str,
    payload: FailureModeUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> FailureMode:
    entry = require_model(db, FailureMode, mode_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(entry, field, value)
    record_change(
        db,
        "failure_mode",
        entry.id,
        "updated",
        f"Updated failure mode {entry.name}",
        actor=user.email,
    )
    db.commit()
    db.refresh(entry)
    return entry


@safety_router.delete("/failure-modes/{mode_id}", status_code=204)
def delete_failure_mode(
    mode_id: str, db: Session = Depends(get_db), user: User = Depends(require_admin)
) -> Response:
    entry = require_model(db, FailureMode, mode_id)
    record_change(
        db,
        "failure_mode",
        entry.id,
        "deleted",
        f"Deleted failure mode {entry.name}",
        actor=user.email,
    )
    db.delete(entry)
    db.commit()
    return Response(status_code=204)


# ---- FMEA worksheets ----


def _worksheet(db: Session, worksheet_id: str) -> FmeaWorksheet:
    worksheet = db.scalar(
        select(FmeaWorksheet)
        .where(FmeaWorksheet.id == worksheet_id)
        .options(selectinload(FmeaWorksheet.rows))
    )
    if worksheet is None:
        raise HTTPException(status_code=404, detail="FmeaWorksheet not found")
    return worksheet


def _worksheet_settings(db: Session, worksheet: FmeaWorksheet) -> dict:
    return get_settings(db, require_model(db, Project, worksheet.project_id))


@safety_router.get("/projects/{project_id}/fmea", response_model=list[FmeaWorksheetRead])
def list_worksheets(project_id: str, db: Session = Depends(get_db)) -> list[dict]:
    project = require_model(db, Project, project_id)
    settings = get_settings(db, project)
    worksheets = db.scalars(
        select(FmeaWorksheet)
        .where(FmeaWorksheet.project_id == project.id)
        .options(selectinload(FmeaWorksheet.rows))
        .order_by(FmeaWorksheet.created_at)
    )
    return [worksheet_view(db, worksheet, settings) for worksheet in worksheets]


@safety_router.post(
    "/projects/{project_id}/fmea", response_model=FmeaWorksheetRead, status_code=201
)
def create_worksheet(
    project_id: str,
    payload: FmeaWorksheetCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    project = require_model(db, Project, project_id)
    settings = get_settings(db, project)
    if payload.drawing_id:
        drawing = require_model(db, Drawing, payload.drawing_id)
        if drawing.project_id != project.id:
            raise HTTPException(status_code=422, detail="drawing_id belongs to another project")
    if payload.system_id:
        system = require_model(db, FluidSystem, payload.system_id)
        if system.project_id != project.id:
            raise HTTPException(status_code=422, detail="system_id belongs to another project")
    worksheet = FmeaWorksheet(
        project_id=project.id,
        operating_modes=payload.operating_modes or settings["operating_modes"],
        **payload.model_dump(exclude={"operating_modes"}),
    )
    if worksheet.drawing_id:
        worksheet.drawing_revision_label = latest_revision_label(
            db.get(Drawing, worksheet.drawing_id)
        )
    db.add(worksheet)
    db.flush()
    record_change(
        db,
        "fmea_worksheet",
        worksheet.id,
        "created",
        f"Created FMEA worksheet {worksheet.title}",
        actor=user.email,
    )
    db.commit()
    return worksheet_view(db, _worksheet(db, worksheet.id), settings)


@safety_router.get("/fmea/{worksheet_id}", response_model=FmeaWorksheetRead)
def get_worksheet(worksheet_id: str, db: Session = Depends(get_db)) -> dict:
    worksheet = _worksheet(db, worksheet_id)
    return worksheet_view(db, worksheet, _worksheet_settings(db, worksheet))


@safety_router.put("/fmea/{worksheet_id}", response_model=FmeaWorksheetRead)
def update_worksheet(
    worksheet_id: str,
    payload: FmeaWorksheetUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    worksheet = _worksheet(db, worksheet_id)
    data = payload.model_dump(exclude_unset=True)
    if data.get("drawing_id"):
        drawing = require_model(db, Drawing, data["drawing_id"])
        if drawing.project_id != worksheet.project_id:
            raise HTTPException(status_code=422, detail="drawing_id belongs to another project")
    for field, value in data.items():
        setattr(worksheet, field, value)
    record_change(
        db,
        "fmea_worksheet",
        worksheet.id,
        "updated",
        f"Updated FMEA worksheet {worksheet.title}",
        actor=user.email,
    )
    db.commit()
    return worksheet_view(db, _worksheet(db, worksheet.id), _worksheet_settings(db, worksheet))


@safety_router.delete("/fmea/{worksheet_id}", status_code=204)
def delete_worksheet(
    worksheet_id: str, db: Session = Depends(get_db), user: User = Depends(require_writer)
) -> Response:
    worksheet = _worksheet(db, worksheet_id)
    delete_trace_links_for_many(db, [("fmea_row", row.id) for row in worksheet.rows])
    record_change(
        db,
        "fmea_worksheet",
        worksheet.id,
        "deleted",
        f"Deleted FMEA worksheet {worksheet.title}",
        actor=user.email,
    )
    db.delete(worksheet)
    db.commit()
    return Response(status_code=204)


@safety_router.post("/fmea/{worksheet_id}/generate", response_model=FmeaGenerateRead)
def generate_worksheet_rows(
    worksheet_id: str,
    payload: FmeaGenerateIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    worksheet = _worksheet(db, worksheet_id)
    drawing_id = payload.drawing_id or worksheet.drawing_id
    if not drawing_id:
        raise HTTPException(
            status_code=422, detail="The worksheet needs a drawing to generate from"
        )
    drawing = db.scalar(
        select(Drawing).where(Drawing.id == drawing_id).options(selectinload(Drawing.revisions))
    )
    if drawing is None or drawing.project_id != worksheet.project_id:
        raise HTTPException(status_code=404, detail="Drawing not found in this project")
    if worksheet.drawing_id is None:
        worksheet.drawing_id = drawing.id
    result = generate_rows(
        db,
        worksheet,
        drawing,
        sheet_ids=payload.sheet_ids,
        categories=payload.categories,
        operating_modes=payload.operating_modes,
    )
    if worksheet.status == "released" and result["added"]:
        worksheet.status = "draft"
    record_change(
        db,
        "fmea_worksheet",
        worksheet.id,
        "updated",
        f"Generated FMEA rows from {drawing.number}: {result['added']} added, "
        f"{result['kept']} kept",
        actor=user.email,
    )
    db.commit()
    return result


@safety_router.get("/fmea/{worksheet_id}/rows", response_model=list[FmeaRowRead])
def list_rows(worksheet_id: str, db: Session = Depends(get_db)) -> list[dict]:
    worksheet = _worksheet(db, worksheet_id)
    return row_views(db, worksheet, list(worksheet.rows))


@safety_router.get("/fmea/{worksheet_id}/stale", response_model=list[FmeaRowRead])
def list_stale_rows(worksheet_id: str, db: Session = Depends(get_db)) -> list[dict]:
    worksheet = _worksheet(db, worksheet_id)
    return row_views(db, worksheet, [row for row in worksheet.rows if row.stale_reason])


@safety_router.post("/fmea/{worksheet_id}/rows", response_model=FmeaRowRead, status_code=201)
def create_row(
    worksheet_id: str,
    payload: FmeaRowIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    worksheet = _worksheet(db, worksheet_id)
    settings = _worksheet_settings(db, worksheet)
    data = payload.model_dump(exclude_unset=True)
    if not data.get("item_id") and not data.get("subject_text"):
        raise HTTPException(status_code=422, detail="A row needs an item or a subject")
    error = validate_row(db, worksheet, data, int(settings["fmea_scale_max"]))
    if error:
        raise HTTPException(status_code=422, detail=error)
    row = FmeaRow(
        worksheet_id=worksheet.id,
        position=max((r.position for r in worksheet.rows), default=0) + 1,
    )
    if "detection_kind" not in data:
        data["detection_kind"] = "instrument" if data.get("detected_by_item_id") else "none"
    if data.get("item_id") and "sheet_id" not in data:
        data["sheet_id"] = None
    apply_row(db, worksheet, row, data)
    db.add(row)
    db.flush()
    record_change(
        db, "fmea_worksheet", worksheet.id, "updated", "Added an FMEA row", actor=user.email
    )
    db.commit()
    db.refresh(row)
    return row_views(db, worksheet, [row])[0]


@safety_router.put("/fmea/rows/{row_id}", response_model=FmeaRowRead)
def update_row(
    row_id: str,
    payload: FmeaRowIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    row = require_model(db, FmeaRow, row_id)
    worksheet = _worksheet(db, row.worksheet_id)
    settings = _worksheet_settings(db, worksheet)
    data = payload.model_dump(exclude_unset=True)
    merged = {**{c.name: getattr(row, c.name) for c in FmeaRow.__table__.columns}, **data}
    error = validate_row(db, worksheet, merged, int(settings["fmea_scale_max"]))
    if error:
        raise HTTPException(status_code=422, detail=error)
    apply_row(db, worksheet, row, data)
    db.commit()
    db.refresh(row)
    return row_views(db, worksheet, [row])[0]


@safety_router.post("/fmea/{worksheet_id}/rows/bulk", response_model=list[FmeaRowRead])
def bulk_update_rows(
    worksheet_id: str,
    payload: FmeaBulkIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> list[dict]:
    """Apply many partial row updates in one transaction (fill-down, paste)."""
    worksheet = _worksheet(db, worksheet_id)
    settings = _worksheet_settings(db, worksheet)
    by_id = {row.id: row for row in worksheet.rows}
    touched: list[FmeaRow] = []
    for patch in payload.rows:
        row = by_id.get(patch.id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"Row {patch.id} is not on this worksheet")
        data = patch.model_dump(exclude_unset=True, exclude={"id"})
        merged = {**{c.name: getattr(row, c.name) for c in FmeaRow.__table__.columns}, **data}
        error = validate_row(db, worksheet, merged, int(settings["fmea_scale_max"]))
        if error:
            raise HTTPException(status_code=422, detail=f"Row {patch.id}: {error}")
        apply_row(db, worksheet, row, data)
        touched.append(row)
    record_change(
        db,
        "fmea_worksheet",
        worksheet.id,
        "updated",
        f"Updated {len(touched)} FMEA row(s)",
        actor=user.email,
    )
    db.commit()
    return row_views(db, worksheet, touched)


@safety_router.delete("/fmea/rows/{row_id}", status_code=204)
def delete_row(
    row_id: str, db: Session = Depends(get_db), user: User = Depends(require_writer)
) -> Response:
    row = require_model(db, FmeaRow, row_id)
    worksheet = _worksheet(db, row.worksheet_id)
    delete_trace_links_for(db, "fmea_row", row.id)
    db.delete(row)
    if worksheet.status == "released":
        worksheet.status = "draft"
    record_change(
        db, "fmea_worksheet", worksheet.id, "updated", "Removed an FMEA row", actor=user.email
    )
    db.commit()
    return Response(status_code=204)


@safety_router.post("/fmea/rows/{row_id}/confirm", response_model=FmeaRowRead)
def confirm_stale_row(
    row_id: str, db: Session = Depends(get_db), user: User = Depends(require_writer)
) -> dict:
    row = require_model(db, FmeaRow, row_id)
    worksheet = _worksheet(db, row.worksheet_id)
    confirm_row(db, row)
    db.commit()
    db.refresh(row)
    return row_views(db, worksheet, [row])[0]


@safety_router.post("/fmea/{worksheet_id}/confirm-all", response_model=FmeaWorksheetRead)
def confirm_all_rows(
    worksheet_id: str, db: Session = Depends(get_db), user: User = Depends(require_writer)
) -> dict:
    worksheet = _worksheet(db, worksheet_id)
    for row in worksheet.rows:
        if row.stale_reason:
            confirm_row(db, row)
    record_change(
        db, "fmea_worksheet", worksheet.id, "updated", "Confirmed stale FMEA rows", actor=user.email
    )
    db.commit()
    return worksheet_view(db, _worksheet(db, worksheet.id), _worksheet_settings(db, worksheet))


@safety_router.post("/fmea/rows/{row_id}/controls", response_model=FmeaRowRead, status_code=201)
def add_row_control(
    row_id: str,
    payload: FmeaRowControlIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    row = require_model(db, FmeaRow, row_id)
    worksheet = _worksheet(db, row.worksheet_id)
    if payload.type == "requirement":
        target = require_model(db, Requirement, payload.id)
        if target.project_id != worksheet.project_id:
            raise HTTPException(status_code=422, detail="Requirement belongs to another project")
    else:
        require_model(db, SheetItem, payload.id)
    existing = db.scalar(
        select(TraceLink).where(
            TraceLink.source_type == "fmea_row",
            TraceLink.source_id == row.id,
            TraceLink.target_type == payload.type,
            TraceLink.target_id == payload.id,
            TraceLink.link_type == "controlled_by",
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="This control is already linked")
    db.add(
        TraceLink(
            source_type="fmea_row",
            source_id=row.id,
            target_type=payload.type,
            target_id=payload.id,
            link_type="controlled_by",
        )
    )
    db.commit()
    return row_views(db, worksheet, [row])[0]


@safety_router.delete("/fmea/rows/{row_id}/controls/{link_id}", response_model=FmeaRowRead)
def remove_row_control(
    row_id: str, link_id: str, db: Session = Depends(get_db), user: User = Depends(require_writer)
) -> dict:
    row = require_model(db, FmeaRow, row_id)
    worksheet = _worksheet(db, row.worksheet_id)
    link = require_model(db, TraceLink, link_id)
    if link.source_type != "fmea_row" or link.source_id != row.id:
        raise HTTPException(status_code=404, detail="Control link not found on this row")
    db.delete(link)
    db.commit()
    return row_views(db, worksheet, [row])[0]


@safety_router.get("/fmea/{worksheet_id}/gate", response_model=FmeaGateRead)
def worksheet_gate(worksheet_id: str, db: Session = Depends(get_db)) -> dict:
    worksheet = _worksheet(db, worksheet_id)
    blockers = release_gate(worksheet, _worksheet_settings(db, worksheet))
    return {"ready": not blockers, "blockers": blockers}


@safety_router.post("/fmea/{worksheet_id}/release", response_model=FmeaReleaseRead, status_code=201)
def release_worksheet(
    worksheet_id: str,
    payload: FmeaReleaseIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_safety_approver),
) -> dict:
    worksheet = _worksheet(db, worksheet_id)
    blockers = release_gate(worksheet, _worksheet_settings(db, worksheet))
    if blockers:
        raise HTTPException(
            status_code=409,
            detail={"message": "The worksheet cannot be released yet", "blockers": blockers},
        )
    entry = release(db, worksheet, user.email, payload.note)
    record_change(
        db,
        "fmea_worksheet",
        worksheet.id,
        "updated",
        f"Released FMEA worksheet {worksheet.title} revision {entry.revision}",
        actor=user.email,
    )
    db.commit()
    db.refresh(entry)
    return {
        **{c.name: getattr(entry, c.name) for c in FmeaRelease.__table__.columns},
        "row_count": len(entry.rows),
    }


@safety_router.get("/fmea/{worksheet_id}/releases", response_model=list[FmeaReleaseRead])
def list_releases(worksheet_id: str, db: Session = Depends(get_db)) -> list[dict]:
    worksheet = _worksheet(db, worksheet_id)
    return [
        {
            **{c.name: getattr(entry, c.name) for c in FmeaRelease.__table__.columns},
            "row_count": len(entry.rows),
        }
        for entry in db.scalars(
            select(FmeaRelease)
            .where(FmeaRelease.worksheet_id == worksheet.id)
            .order_by(FmeaRelease.revision)
        )
    ]


@safety_router.get("/fmea/{worksheet_id}/diff", response_model=FmeaDiffRead)
def worksheet_diff(
    worksheet_id: str, against: int | None = None, db: Session = Depends(get_db)
) -> dict:
    worksheet = _worksheet(db, worksheet_id)
    query = select(FmeaRelease).where(FmeaRelease.worksheet_id == worksheet.id)
    if against is not None:
        query = query.where(FmeaRelease.revision == against)
    entry = db.scalar(query.order_by(FmeaRelease.revision.desc()))
    if entry is None:
        raise HTTPException(status_code=404, detail="No release to compare against")
    return {
        "worksheet_id": worksheet.id,
        "against_revision": entry.revision,
        **diff(db, worksheet, entry),
    }


@safety_router.get("/fmea/{worksheet_id}/export")
def export_worksheet(
    worksheet_id: str, format: str = "xlsx", db: Session = Depends(get_db)
) -> Response:
    worksheet = _worksheet(db, worksheet_id)
    project = require_model(db, Project, worksheet.project_id)
    views = row_views(db, worksheet, list(worksheet.rows))
    rows = fmea_export_rows(views)
    drawing = db.get(Drawing, worksheet.drawing_id) if worksheet.drawing_id else None
    header = {
        "list": "FMEA",
        "project": project.name,
        "worksheet": worksheet.title,
        "drawing": f"{drawing.number} rev {worksheet.drawing_revision_label or '-'}"
        if drawing
        else "",
        "revision": worksheet.revision,
        "status": worksheet.status,
    }
    filename = list_filename("fmea", worksheet.title, format).replace("-list.", ".")
    if format == "xlsx":
        body = rows_to_xlsx(header, FMEA_EXPORT_COLUMNS, rows)
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    elif format == "csv":
        body = rows_to_csv(header, FMEA_EXPORT_COLUMNS, rows).encode("utf-8")
        media = "text/csv"
    elif format == "pdf":
        columns = [
            ("item_tag", "Item", 1.1),
            ("failure_mode_title", "Failure mode", 1.6),
            ("operating_modes_text", "Modes", 1.0),
            ("cause", "Cause", 1.6),
            ("local_effect", "Local effect", 1.8),
            ("end_effect", "End effect", 1.6),
            ("detection_text", "Detected by", 1.0),
            ("severity", "S", 0.35),
            ("occurrence", "O", 0.35),
            ("detection", "D", 0.35),
            ("rpn", "RPN", 0.5),
            ("controls_text", "Controls", 1.2),
            ("hazard_key", "Hazard", 0.7),
            ("recommended_action", "Action", 1.4),
        ]
        ordered = sorted(rows, key=lambda row: -(row.get("rpn") or 0))
        pages = table_pages(
            f"FMEA · {worksheet.title}",
            f"{project.name} · {header['drawing']} · worksheet revision {worksheet.revision} "
            f"({worksheet.status})",
            columns,
            ordered,
            footer="Generated by FSDP. Rows sorted by RPN.",
        )
        body = svg_to_pdf(pages[0], pages[1:])
        media = "application/pdf"
    else:
        raise HTTPException(status_code=400, detail="format must be xlsx, csv, or pdf")
    return Response(
        content=body,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---- Row comments ----


@safety_router.get("/fmea/rows/{row_id}/comments", response_model=list[FmeaCommentRead])
def list_row_comments(row_id: str, db: Session = Depends(get_db)) -> list[FmeaRowComment]:
    require_model(db, FmeaRow, row_id)
    return list(
        db.scalars(
            select(FmeaRowComment)
            .where(FmeaRowComment.row_id == row_id)
            .order_by(FmeaRowComment.created_at)
        )
    )


@safety_router.post("/fmea/rows/{row_id}/comments", response_model=FmeaCommentRead, status_code=201)
def add_row_comment(
    row_id: str,
    payload: FmeaCommentCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> FmeaRowComment:
    require_model(db, FmeaRow, row_id)
    comment = FmeaRowComment(row_id=row_id, author=user.email, body=payload.body)
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return comment


@safety_router.put("/fmea/comments/{comment_id}", response_model=FmeaCommentRead)
def update_row_comment(
    comment_id: str,
    payload: FmeaCommentUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> FmeaRowComment:
    comment = require_model(db, FmeaRowComment, comment_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(comment, field, value)
    db.commit()
    db.refresh(comment)
    return comment
