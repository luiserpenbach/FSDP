import csv
import io
import re
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, defer, selectinload

from app.core.security import require_admin, require_writer
from app.db import get_db
from app.models import (
    BomSnapshot,
    CatalogDocument,
    ChangeEvent,
    ComponentInstance,
    Diagram,
    Drawing,
    DrawingSheet,
    FluidSystem,
    Part,
    PidSymbolDef,
    Project,
    Requirement,
    SheetItem,
    SheetLine,
    TraceLink,
    User,
)
from app.schemas import (
    BomDiffRead,
    BomReadinessRead,
    BomSnapshotRead,
    BomStatusUpdate,
    CatalogDocumentRead,
    CatalogSettingsRead,
    CatalogSettingsUpdate,
    ChangeEventRead,
    ComponentInstanceRead,
    DiagramRead,
    DiagramSummaryRead,
    FluidSystemCreate,
    FluidSystemRead,
    FluidSystemUpdate,
    GeneratePartNameRead,
    ImpactRead,
    PartCreate,
    PartRead,
    PartUpdate,
    PartUsageBomRead,
    PartUsageComponentRead,
    PartUsageDrawingItemRead,
    PartUsageRead,
    PidSymbolCreate,
    PidSymbolRead,
    PidSymbolUpdate,
    ProjectBomRead,
    ProjectCreate,
    ProjectRead,
    ProjectUpdate,
    RequirementCreate,
    RequirementRead,
    RequirementUpdate,
    SchematicRead,
    TraceLinkCreate,
    TraceLinkRead,
)
from app.services.catalog import (
    DOCUMENT_KINDS,
    MAX_DOCUMENT_BYTES,
    catalog_files_root,
    document_suffix_allowed,
    ensure_catalog_settings,
    generate_part_name,
    qualification_warnings,
    remember_part_type,
    sanitize_upload_filename,
)
from app.services.change_impact import get_change_impact
from app.services.lists import rows_to_xlsx, spreadsheet_safe
from app.services.sheet_index import (
    mark_project_sheets_stale,
    mark_sheets_stale_for_part,
    stale_sheets_note,
)
from app.services.traceability import (
    delete_trace_links_for,
    delete_trace_links_for_many,
    drawing_trace_endpoints,
    get_trace_links,
)

router = APIRouter()


def require_model(db: Session, model: type, object_id: str):
    item = db.get(model, object_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"{model.__name__} not found")
    return item


def record_change(
    db: Session,
    object_type: str,
    object_id: str,
    action: str,
    summary: str,
    actor: str | None = None,
) -> None:
    db.add(
        ChangeEvent(
            object_type=object_type,
            object_id=object_id,
            action=action,
            summary=summary,
            actor=actor,
        )
    )


def apply_updates(item, payload) -> None:
    for field, value in payload.model_dump(exclude_unset=True).items():
        if field == "metadata":
            item.metadata_ = value
        else:
            setattr(item, field, value)


def normalized_name(name: str) -> str:
    return name.strip().lower()


def _diagram_trace_endpoints(db: Session, diagram_id: str) -> list[tuple[str, str]]:
    endpoints: list[tuple[str, str]] = [("diagram", diagram_id)]
    for component in db.scalars(
        select(ComponentInstance).where(ComponentInstance.diagram_id == diagram_id)
    ):
        endpoints.append(("component", component.id))
    return endpoints


def _system_trace_endpoints(db: Session, system_id: str) -> list[tuple[str, str]]:
    endpoints: list[tuple[str, str]] = [("fluid_system", system_id)]
    for diagram in db.scalars(select(Diagram).where(Diagram.system_id == system_id)):
        endpoints.extend(_diagram_trace_endpoints(db, diagram.id))
    return endpoints


def _project_trace_endpoints(db: Session, project_id: str) -> list[tuple[str, str]]:
    endpoints: list[tuple[str, str]] = [("project", project_id)]
    for system in db.scalars(select(FluidSystem).where(FluidSystem.project_id == project_id)):
        endpoints.extend(_system_trace_endpoints(db, system.id))
    for requirement in db.scalars(select(Requirement).where(Requirement.project_id == project_id)):
        endpoints.append(("requirement", requirement.id))
    drawing_ids = db.scalars(select(Drawing.id).where(Drawing.project_id == project_id))
    endpoints.extend(drawing_trace_endpoints(db, drawing_ids))
    return endpoints


def normalized_column(column):
    return func.lower(func.trim(column))


@router.post("/projects", response_model=ProjectRead, status_code=201)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Project:
    clean_name = payload.name.strip()
    if not clean_name:
        raise HTTPException(status_code=422, detail="Project name cannot be blank")

    existing = db.scalar(
        select(Project).where(normalized_column(Project.name) == normalized_name(payload.name))
    )
    if existing:
        raise HTTPException(status_code=409, detail="Project name already exists")

    project = Project(**{**payload.model_dump(), "name": clean_name})
    db.add(project)
    db.flush()
    record_change(
        db, "project", project.id, "created", f"Created project {project.name}", actor=user.email
    )
    db.commit()
    db.refresh(project)
    return project


@router.get("/projects", response_model=list[ProjectRead])
def list_projects(db: Session = Depends(get_db)) -> list[Project]:
    return list(db.scalars(select(Project).order_by(Project.created_at.desc())))


@router.get("/projects/{project_id}", response_model=ProjectRead)
def get_project(project_id: str, db: Session = Depends(get_db)) -> Project:
    return require_model(db, Project, project_id)


@router.put("/projects/{project_id}", response_model=ProjectRead)
def update_project(
    project_id: str,
    payload: ProjectUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Project:
    project = require_model(db, Project, project_id)
    if payload.name is not None:
        clean_name = payload.name.strip()
        if not clean_name:
            raise HTTPException(status_code=422, detail="Project name cannot be blank")

        existing = db.scalar(
            select(Project).where(
                normalized_column(Project.name) == normalized_name(payload.name),
                Project.id != project_id,
            )
        )
        if existing:
            raise HTTPException(status_code=409, detail="Project name already exists")
        payload.name = clean_name

    apply_updates(project, payload)
    record_change(
        db, "project", project.id, "updated", f"Updated project {project.name}", actor=user.email
    )
    db.commit()
    db.refresh(project)
    return project


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    project = require_model(db, Project, project_id)
    delete_trace_links_for_many(db, _project_trace_endpoints(db, project_id))
    record_change(
        db, "project", project.id, "deleted", f"Deleted project {project.name}", actor=user.email
    )
    db.delete(project)
    db.commit()
    return Response(status_code=204)


@router.post("/projects/{project_id}/systems", response_model=FluidSystemRead, status_code=201)
def create_system(
    project_id: str,
    payload: FluidSystemCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> FluidSystem:
    require_model(db, Project, project_id)
    clean_name = payload.name.strip()
    if not clean_name:
        raise HTTPException(status_code=422, detail="System name cannot be blank")

    existing = db.scalar(
        select(FluidSystem).where(
            FluidSystem.project_id == project_id,
            normalized_column(FluidSystem.name) == normalized_name(payload.name),
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="System name already exists in project")

    system = FluidSystem(project_id=project_id, **{**payload.model_dump(), "name": clean_name})
    db.add(system)
    db.flush()
    record_change(
        db, "fluid_system", system.id, "created", f"Created system {system.name}", actor=user.email
    )
    db.commit()
    db.refresh(system)
    return system


@router.get("/projects/{project_id}/systems", response_model=list[FluidSystemRead])
def list_systems(project_id: str, db: Session = Depends(get_db)) -> list[FluidSystem]:
    require_model(db, Project, project_id)
    return list(db.scalars(select(FluidSystem).where(FluidSystem.project_id == project_id)))


@router.put("/systems/{system_id}", response_model=FluidSystemRead)
def update_system(
    system_id: str,
    payload: FluidSystemUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> FluidSystem:
    system = require_model(db, FluidSystem, system_id)
    if payload.name is not None:
        clean_name = payload.name.strip()
        if not clean_name:
            raise HTTPException(status_code=422, detail="System name cannot be blank")

        existing = db.scalar(
            select(FluidSystem).where(
                FluidSystem.project_id == system.project_id,
                normalized_column(FluidSystem.name) == normalized_name(payload.name),
                FluidSystem.id != system_id,
            )
        )
        if existing:
            raise HTTPException(status_code=409, detail="System name already exists in project")
        payload.name = clean_name

    apply_updates(system, payload)
    record_change(
        db, "fluid_system", system.id, "updated", f"Updated system {system.name}", actor=user.email
    )
    db.commit()
    db.refresh(system)
    return system


@router.delete("/systems/{system_id}", status_code=204)
def delete_system(
    system_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    system = require_model(db, FluidSystem, system_id)
    delete_trace_links_for_many(db, _system_trace_endpoints(db, system_id))
    record_change(
        db, "fluid_system", system.id, "deleted", f"Deleted system {system.name}", actor=user.email
    )
    db.delete(system)
    db.commit()
    return Response(status_code=204)


# Legacy diagrams (the retired React Flow editor) are import-only: they are listed and
# read so Drafting can convert them into drawings, and deleted once converted. Their
# components and diagram BoM snapshots stay readable as history.


@router.get("/systems/{system_id}/diagrams", response_model=list[DiagramRead])
def list_diagrams(system_id: str, db: Session = Depends(get_db)) -> list[Diagram]:
    require_model(db, FluidSystem, system_id)
    return list(db.scalars(select(Diagram).where(Diagram.system_id == system_id)))


@router.get("/projects/{project_id}/diagrams", response_model=list[DiagramSummaryRead])
def list_project_diagrams(project_id: str, db: Session = Depends(get_db)) -> list[Diagram]:
    """Legacy diagrams of every system in the project (conversion sources), by system."""
    require_model(db, Project, project_id)
    return list(
        db.scalars(
            select(Diagram)
            .join(FluidSystem, Diagram.system_id == FluidSystem.id)
            .where(FluidSystem.project_id == project_id)
            .options(defer(Diagram.graph), defer(Diagram.schematic))
            .order_by(func.lower(FluidSystem.name), func.lower(Diagram.name))
        )
    )


@router.get("/diagrams/{diagram_id}", response_model=DiagramRead)
def get_diagram(diagram_id: str, db: Session = Depends(get_db)) -> Diagram:
    return require_model(db, Diagram, diagram_id)


@router.delete("/diagrams/{diagram_id}", status_code=204)
def delete_diagram(
    diagram_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    diagram = require_model(db, Diagram, diagram_id)
    delete_trace_links_for_many(db, _diagram_trace_endpoints(db, diagram_id))
    record_change(
        db, "diagram", diagram.id, "deleted", f"Deleted diagram {diagram.name}", actor=user.email
    )
    db.delete(diagram)
    db.commit()
    return Response(status_code=204)


@router.get("/diagrams/{diagram_id}/schematic", response_model=SchematicRead)
def get_diagram_schematic(diagram_id: str, db: Session = Depends(get_db)) -> dict:
    diagram = require_model(db, Diagram, diagram_id)
    return {"diagram_id": diagram.id, "revision": diagram.revision, "document": diagram.schematic}


@router.post("/symbols", response_model=PidSymbolRead, status_code=201)
def create_symbol(
    payload: PidSymbolCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> PidSymbolDef:
    existing = db.scalar(
        select(PidSymbolDef).where(
            normalized_column(PidSymbolDef.name) == normalized_name(payload.name)
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="Symbol name already exists")

    data = payload.model_dump()
    data["ports"] = [port.model_dump() for port in payload.ports]
    symbol = PidSymbolDef(**data)
    db.add(symbol)
    db.flush()
    record_change(
        db, "symbol", symbol.id, "created", f"Created P&ID symbol {symbol.name}", actor=user.email
    )
    db.commit()
    db.refresh(symbol)
    return symbol


@router.get("/symbols", response_model=list[PidSymbolRead])
def list_symbols(db: Session = Depends(get_db)) -> list[PidSymbolDef]:
    return list(db.scalars(select(PidSymbolDef).order_by(PidSymbolDef.name)))


@router.put("/symbols/{symbol_id}", response_model=PidSymbolRead)
def update_symbol(
    symbol_id: str,
    payload: PidSymbolUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> PidSymbolDef:
    symbol = require_model(db, PidSymbolDef, symbol_id)
    if payload.name:
        existing = db.scalar(
            select(PidSymbolDef).where(
                normalized_column(PidSymbolDef.name) == normalized_name(payload.name),
                PidSymbolDef.id != symbol_id,
            )
        )
        if existing:
            raise HTTPException(status_code=409, detail="Symbol name already exists")

    updates = payload.model_dump(exclude_unset=True)
    if "ports" in updates and updates["ports"] is not None:
        updates["ports"] = [port.model_dump() for port in payload.ports or []]
    for field, value in updates.items():
        setattr(symbol, field, value)
    record_change(
        db, "symbol", symbol.id, "updated", f"Updated P&ID symbol {symbol.name}", actor=user.email
    )
    db.commit()
    db.refresh(symbol)
    return symbol


@router.delete("/symbols/{symbol_id}", status_code=204)
def delete_symbol(
    symbol_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    symbol = require_model(db, PidSymbolDef, symbol_id)
    record_change(
        db, "symbol", symbol.id, "deleted", f"Deleted P&ID symbol {symbol.name}", actor=user.email
    )
    db.delete(symbol)
    db.commit()
    return Response(status_code=204)


@router.post("/parts", response_model=PartRead, status_code=201)
def create_part(
    payload: PartCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Part:
    existing = db.scalar(select(Part).where(Part.part_number == payload.part_number))
    if existing:
        raise HTTPException(status_code=409, detail="Part name already exists")

    data = payload.model_dump()
    data["metadata_"] = data.pop("metadata")
    part = Part(**data)
    db.add(part)
    remember_part_type(db, part.part_type)
    db.flush()
    record_change(
        db, "part", part.id, "created", f"Created part {part.part_number}", actor=user.email
    )
    db.commit()
    db.refresh(part)
    return part


@router.get("/parts", response_model=list[PartRead])
def list_parts(
    q: str | None = None,
    part_type: str | None = None,
    material: str | None = None,
    manufacturer: str | None = None,
    qualification_status: str | None = None,
    lifecycle_status: str | None = None,
    preferred: bool | None = None,
    min_pressure_bar: float | None = None,
    db: Session = Depends(get_db),
) -> list[Part]:
    stmt = select(Part)
    if q and q.strip():
        term = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Part.part_number.ilike(term),
                Part.description.ilike(term),
                Part.manufacturer.ilike(term),
            )
        )
    if part_type:
        stmt = stmt.where(Part.part_type == part_type)
    if material:
        stmt = stmt.where(Part.material == material)
    if manufacturer:
        stmt = stmt.where(Part.manufacturer == manufacturer)
    if qualification_status:
        stmt = stmt.where(Part.qualification_status == qualification_status)
    if lifecycle_status:
        stmt = stmt.where(Part.lifecycle_status == lifecycle_status)
    if preferred is not None:
        stmt = stmt.where(Part.preferred.is_(preferred))
    if min_pressure_bar is not None:
        stmt = stmt.where(Part.pressure_rating_bar >= min_pressure_bar)
    return list(db.scalars(stmt.order_by(Part.part_number)))


@router.get("/parts/{part_id}", response_model=PartRead)
def get_part(part_id: str, db: Session = Depends(get_db)) -> Part:
    return require_model(db, Part, part_id)


@router.put("/parts/{part_id}", response_model=PartRead)
def update_part(
    part_id: str,
    payload: PartUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Part:
    part = require_model(db, Part, part_id)
    if payload.part_number:
        existing = db.scalar(
            select(Part).where(Part.part_number == payload.part_number, Part.id != part_id)
        )
        if existing:
            raise HTTPException(status_code=409, detail="Part name already exists")

    before = PartRead.model_validate(part).model_dump(exclude={"updated_at"})
    apply_updates(part, payload)
    if payload.part_type:
        remember_part_type(db, payload.part_type)
    if PartRead.model_validate(part).model_dump(exclude={"updated_at"}) != before:
        # Ratings, material, and lifecycle feed the drawing DRC computed in the browser.
        mark_sheets_stale_for_part(db, part.id)
    record_change(
        db, "part", part.id, "updated", f"Updated part {part.part_number}", actor=user.email
    )
    db.commit()
    db.refresh(part)
    return part


@router.delete("/parts/{part_id}", status_code=204)
def delete_part(
    part_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    part = require_model(db, Part, part_id)
    usage_count = db.scalar(
        select(func.count())
        .select_from(ComponentInstance)
        .where(ComponentInstance.part_id == part_id)
    )
    usage_count = (usage_count or 0) + (
        db.scalar(select(func.count()).select_from(SheetItem).where(SheetItem.part_id == part_id))
        or 0
    )
    if usage_count:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Part {part.part_number} is placed on {usage_count} component instance(s). "
                "Remove those components first or mark the part obsolete instead of deleting it."
            ),
        )
    for document in db.scalars(select(CatalogDocument).where(CatalogDocument.part_id == part_id)):
        stored = catalog_files_root() / document.storage_path
        if stored.is_file():
            stored.unlink()
    delete_trace_links_for(db, "part", part.id)
    record_change(
        db, "part", part.id, "deleted", f"Deleted part {part.part_number}", actor=user.email
    )
    db.delete(part)
    db.commit()
    return Response(status_code=204)


@router.get("/catalog/settings", response_model=CatalogSettingsRead)
def get_catalog_settings(db: Session = Depends(get_db)) -> CatalogSettingsRead:
    row = ensure_catalog_settings(db)
    db.commit()
    return CatalogSettingsRead(
        prefix=row.prefix,
        sequence_padding=row.sequence_padding,
        next_sequence=row.next_sequence,
        part_types=list(row.part_types or []),
    )


@router.put("/catalog/settings", response_model=CatalogSettingsRead)
def update_catalog_settings(
    payload: CatalogSettingsUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> CatalogSettingsRead:
    row = ensure_catalog_settings(db)
    data = payload.model_dump(exclude_unset=True)
    if "part_types" in data and data["part_types"] is not None:
        seen: list[str] = []
        existing = set()
        for item in data["part_types"]:
            cleaned = item.strip()
            if cleaned and cleaned.casefold() not in existing:
                seen.append(cleaned)
                existing.add(cleaned.casefold())
        data["part_types"] = seen
    for field, value in data.items():
        setattr(row, field, value)
    record_change(
        db,
        "catalog_settings",
        row.id,
        "updated",
        f"Updated catalog settings (prefix {row.prefix})",
        actor=user.email,
    )
    db.commit()
    db.refresh(row)
    return CatalogSettingsRead(
        prefix=row.prefix,
        sequence_padding=row.sequence_padding,
        next_sequence=row.next_sequence,
        part_types=list(row.part_types or []),
    )


@router.post("/catalog/generate-name", response_model=GeneratePartNameRead)
def generate_catalog_part_name(
    project_id: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> GeneratePartNameRead:
    if project_id:
        require_model(db, Project, project_id)
    name = generate_part_name(db, project_id)
    record_change(
        db,
        "catalog_settings",
        "default",
        "generated",
        f"Generated part name {name}",
        actor=user.email,
    )
    db.commit()
    return GeneratePartNameRead(part_number=name)


@router.post("/parts/{part_id}/obsolete", response_model=PartRead)
def obsolete_part(
    part_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Part:
    part = require_model(db, Part, part_id)
    part.lifecycle_status = "obsolete"
    part.preferred = False
    mark_sheets_stale_for_part(db, part.id)
    record_change(
        db, "part", part.id, "updated", f"Marked part {part.part_number} obsolete", actor=user.email
    )
    db.commit()
    db.refresh(part)
    return part


@router.get("/parts/{part_id}/usage", response_model=PartUsageRead)
def get_part_usage(part_id: str, db: Session = Depends(get_db)) -> PartUsageRead:
    part = require_model(db, Part, part_id)
    components = list(
        db.scalars(select(ComponentInstance).where(ComponentInstance.part_id == part.id))
    )
    usage_components: list[PartUsageComponentRead] = []
    diagram_ids: set[str] = set()
    for component in components:
        diagram = db.get(Diagram, component.diagram_id)
        system = db.get(FluidSystem, diagram.system_id) if diagram else None
        project = db.get(Project, system.project_id) if system else None
        if diagram is None or system is None or project is None:
            continue
        diagram_ids.add(diagram.id)
        usage_components.append(
            PartUsageComponentRead(
                id=component.id,
                tag=component.tag,
                quantity=component.quantity,
                diagram_id=diagram.id,
                diagram_name=diagram.name,
                system_id=system.id,
                system_name=system.name,
                project_id=project.id,
                project_name=project.name,
            )
        )
    snapshots = []
    if diagram_ids:
        snapshots = list(
            db.scalars(
                select(BomSnapshot)
                .where(BomSnapshot.diagram_id.in_(diagram_ids))
                .order_by(BomSnapshot.created_at.desc())
            )
        )
    drawing_rows = db.execute(
        select(SheetItem, DrawingSheet, Drawing)
        .join(DrawingSheet, SheetItem.sheet_id == DrawingSheet.id)
        .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
        .where(SheetItem.part_id == part.id)
        .order_by(Drawing.number, DrawingSheet.sheet_no, SheetItem.tag)
    ).all()
    drawing_ids = {drawing.id for _, _, drawing in drawing_rows}
    if drawing_ids:
        snapshots.extend(
            db.scalars(
                select(BomSnapshot)
                .where(BomSnapshot.drawing_id.in_(drawing_ids))
                .order_by(BomSnapshot.created_at.desc())
            )
        )
    return PartUsageRead(
        components=usage_components,
        bom_snapshots=[
            PartUsageBomRead(
                id=snapshot.id,
                diagram_id=snapshot.diagram_id or snapshot.drawing_id or "",
                revision=snapshot.revision,
                status=snapshot.status,
            )
            for snapshot in snapshots
        ],
        drawing_items=[
            PartUsageDrawingItemRead(
                sheet_id=item.sheet_id,
                item_id=item.item_id,
                tag=item.tag,
                zone=item.zone,
                dnp=item.dnp,
                drawing_id=drawing.id,
                drawing_number=drawing.number,
                drawing_title=drawing.title.replace("\n", " "),
                sheet_no=sheet.sheet_no,
                project_id=drawing.project_id,
            )
            for item, sheet, drawing in drawing_rows
        ],
    )


def _document_file_path(storage_path: str) -> Path:
    root = catalog_files_root().resolve()
    path = (root / storage_path).resolve()
    if root not in path.parents and path != root:
        raise HTTPException(status_code=400, detail="Invalid document path")
    return path


@router.get("/parts/{part_id}/documents", response_model=list[CatalogDocumentRead])
def list_part_documents(part_id: str, db: Session = Depends(get_db)) -> list[CatalogDocument]:
    require_model(db, Part, part_id)
    return list(
        db.scalars(
            select(CatalogDocument)
            .where(CatalogDocument.part_id == part_id)
            .order_by(CatalogDocument.created_at.desc())
        )
    )


@router.post("/parts/{part_id}/documents", response_model=CatalogDocumentRead, status_code=201)
def upload_part_document(
    part_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
    file: UploadFile = File(...),
    title: str | None = Form(None),
    kind: str = Form("other"),
    source_url: str | None = Form(None),
) -> CatalogDocument:
    part = require_model(db, Part, part_id)
    if kind not in DOCUMENT_KINDS:
        raise HTTPException(status_code=422, detail="Invalid document kind")
    filename = sanitize_upload_filename(file.filename or "upload")
    if not document_suffix_allowed(filename):
        raise HTTPException(status_code=422, detail="File type is not allowed")
    payload = file.file.read()
    if len(payload) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="File is larger than 25 MB")
    if not payload:
        raise HTTPException(status_code=422, detail="File is empty")

    document = CatalogDocument(
        part_id=part.id,
        title=(title or "").strip() or Path(filename).stem,
        kind=kind,
        original_filename=filename,
        content_type=file.content_type or "application/octet-stream",
        size_bytes=len(payload),
        storage_path="",
        source_url=(source_url or "").strip() or None,
        uploaded_by=user.email,
    )
    db.add(document)
    db.flush()
    relative = f"{part.id}/{document.id}_{filename}"
    dest = _document_file_path(relative)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(payload)
    document.storage_path = relative
    record_change(
        db,
        "part",
        part.id,
        "updated",
        f"Uploaded {filename} to {part.part_number}",
        actor=user.email,
    )
    db.commit()
    db.refresh(document)
    return document


@router.get("/parts/{part_id}/documents/{document_id}/file")
def download_part_document(
    part_id: str, document_id: str, db: Session = Depends(get_db)
) -> FileResponse:
    require_model(db, Part, part_id)
    document = require_model(db, CatalogDocument, document_id)
    if document.part_id != part_id:
        raise HTTPException(status_code=404, detail="CatalogDocument not found")
    path = _document_file_path(document.storage_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File is missing")
    return FileResponse(
        path,
        filename=document.original_filename,
        media_type=document.content_type,
    )


@router.delete("/parts/{part_id}/documents/{document_id}", status_code=204)
def delete_part_document(
    part_id: str,
    document_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    part = require_model(db, Part, part_id)
    document = require_model(db, CatalogDocument, document_id)
    if document.part_id != part_id:
        raise HTTPException(status_code=404, detail="CatalogDocument not found")
    stored = _document_file_path(document.storage_path)
    if stored.is_file():
        stored.unlink()
    record_change(
        db,
        "part",
        part.id,
        "updated",
        f"Removed document {document.original_filename} from {part.part_number}",
        actor=user.email,
    )
    db.delete(document)
    db.commit()
    return Response(status_code=204)


@router.get("/diagrams/{diagram_id}/components", response_model=list[ComponentInstanceRead])
def list_components(diagram_id: str, db: Session = Depends(get_db)) -> list[ComponentInstance]:
    require_model(db, Diagram, diagram_id)
    return list(
        db.scalars(
            select(ComponentInstance)
            .where(ComponentInstance.diagram_id == diagram_id)
            .options(selectinload(ComponentInstance.node))
        )
    )


@router.post("/requirements", response_model=RequirementRead, status_code=201)
def create_requirement(
    payload: RequirementCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Requirement:
    require_model(db, Project, payload.project_id)
    existing = db.scalar(
        select(Requirement).where(
            Requirement.project_id == payload.project_id,
            Requirement.key == payload.key,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="Requirement key already exists in project")

    requirement = Requirement(**payload.model_dump())
    db.add(requirement)
    db.flush()
    if requirement.constraint is not None:
        # Requirement checks run inside the drawing DRC in the browser.
        mark_project_sheets_stale(db, requirement.project_id)
    record_change(
        db,
        "requirement",
        requirement.id,
        "created",
        f"Created requirement {requirement.key}",
        actor=user.email,
    )
    db.commit()
    db.refresh(requirement)
    return requirement


@router.get("/projects/{project_id}/requirements", response_model=list[RequirementRead])
def list_requirements(project_id: str, db: Session = Depends(get_db)) -> list[Requirement]:
    require_model(db, Project, project_id)
    return list(db.scalars(select(Requirement).where(Requirement.project_id == project_id)))


@router.put("/requirements/{requirement_id}", response_model=RequirementRead)
def update_requirement(
    requirement_id: str,
    payload: RequirementUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Requirement:
    requirement = require_model(db, Requirement, requirement_id)
    if payload.key:
        existing = db.scalar(
            select(Requirement).where(
                Requirement.project_id == requirement.project_id,
                Requirement.key == payload.key,
                Requirement.id != requirement_id,
            )
        )
        if existing:
            raise HTTPException(status_code=409, detail="Requirement key already exists in project")

    had_constraint = requirement.constraint is not None
    apply_updates(requirement, payload)
    if had_constraint or requirement.constraint is not None:
        mark_project_sheets_stale(db, requirement.project_id)
    record_change(
        db,
        "requirement",
        requirement.id,
        "updated",
        f"Updated requirement {requirement.key}",
        actor=user.email,
    )
    db.commit()
    db.refresh(requirement)
    return requirement


@router.delete("/requirements/{requirement_id}", status_code=204)
def delete_requirement(
    requirement_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    requirement = require_model(db, Requirement, requirement_id)
    delete_trace_links_for(db, "requirement", requirement.id)
    if requirement.constraint is not None:
        mark_project_sheets_stale(db, requirement.project_id)
    record_change(
        db,
        "requirement",
        requirement.id,
        "deleted",
        f"Deleted requirement {requirement.key}",
        actor=user.email,
    )
    db.delete(requirement)
    db.commit()
    return Response(status_code=204)


TRACE_OBJECT_MODELS: dict[str, type] = {
    "project": Project,
    "fluid_system": FluidSystem,
    "drawing": Drawing,
    "sheet_item": SheetItem,
    "sheet_line": SheetLine,
    "part": Part,
    "requirement": Requirement,
}

# Legacy diagram objects: existing links to them still read and delete; new ones are refused.
LEGACY_TRACE_TYPES = frozenset({"diagram", "component"})


def _trace_object_project_id(obj: object) -> str | None:
    """Project a trace endpoint belongs to; None for catalog parts, which are shared."""
    if isinstance(obj, Project):
        return obj.id
    if isinstance(obj, FluidSystem | Drawing | Requirement):
        return obj.project_id
    if isinstance(obj, SheetItem | SheetLine):
        return obj.sheet.drawing.project_id
    return None


@router.post("/trace-links", response_model=TraceLinkRead, status_code=201)
def create_trace_link(
    payload: TraceLinkCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> TraceLink:
    for type_name in (payload.source_type, payload.target_type):
        if type_name in LEGACY_TRACE_TYPES:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Legacy {type_name}s are read-only; trace to drawings and their items "
                    "(drawing, sheet_item) instead."
                ),
            )
    project_ids: list[str | None] = []
    for kind, type_name, object_id in (
        ("source", payload.source_type, payload.source_id),
        ("target", payload.target_type, payload.target_id),
    ):
        model = TRACE_OBJECT_MODELS.get(type_name)
        if model is None:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Unknown {kind} type '{type_name}'. Expected one of: "
                    + ", ".join(sorted(TRACE_OBJECT_MODELS))
                ),
            )
        project_ids.append(_trace_object_project_id(require_model(db, model, object_id)))
    if None not in project_ids and project_ids[0] != project_ids[1]:
        raise HTTPException(
            status_code=400, detail="Trace link endpoints belong to different projects"
        )

    existing = db.scalar(
        select(TraceLink).where(
            TraceLink.source_type == payload.source_type,
            TraceLink.source_id == payload.source_id,
            TraceLink.target_type == payload.target_type,
            TraceLink.target_id == payload.target_id,
            TraceLink.link_type == payload.link_type,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="Identical trace link already exists")

    link = TraceLink(**payload.model_dump())
    db.add(link)
    db.flush()
    record_change(
        db,
        "trace_link",
        link.id,
        "created",
        f"Created {link.link_type} trace link",
        actor=user.email,
    )
    db.commit()
    db.refresh(link)
    return link


@router.delete("/trace-links/{link_id}", status_code=204)
def delete_trace_link(
    link_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    link = require_model(db, TraceLink, link_id)
    record_change(
        db,
        "trace_link",
        link.id,
        "deleted",
        f"Deleted {link.link_type} trace link",
        actor=user.email,
    )
    db.delete(link)
    db.commit()
    return Response(status_code=204)


@router.get("/objects/{object_type}/{object_id}/trace", response_model=list[TraceLinkRead])
def object_trace(
    object_type: str, object_id: str, db: Session = Depends(get_db)
) -> list[TraceLink]:
    return get_trace_links(db, object_type, object_id)


@router.get("/diagrams/{diagram_id}/bom", response_model=list[BomSnapshotRead])
def list_diagram_bom_snapshots(diagram_id: str, db: Session = Depends(get_db)) -> list[BomSnapshot]:
    require_model(db, Diagram, diagram_id)
    return list(
        db.scalars(
            select(BomSnapshot)
            .where(BomSnapshot.diagram_id == diagram_id)
            .order_by(BomSnapshot.revision.desc())
        )
    )


@router.get("/projects/{project_id}/bom", response_model=list[ProjectBomRead])
def list_project_bom_snapshots(project_id: str, db: Session = Depends(get_db)) -> list[BomSnapshot]:
    require_model(db, Project, project_id)
    diagram_snapshots = db.scalars(
        select(BomSnapshot)
        .join(Diagram, BomSnapshot.diagram_id == Diagram.id)
        .join(FluidSystem)
        .where(FluidSystem.project_id == project_id)
    ).all()
    drawing_snapshots = db.scalars(
        select(BomSnapshot)
        .join(Drawing, BomSnapshot.drawing_id == Drawing.id)
        .where(Drawing.project_id == project_id)
    ).all()
    return sorted(
        [*diagram_snapshots, *drawing_snapshots],
        key=lambda snapshot: snapshot.created_at or datetime.min.replace(tzinfo=UTC),
        reverse=True,
    )


def _bom_readiness(db: Session, snapshot: BomSnapshot) -> dict:
    part_ids = {row["part_id"] for row in snapshot.rows if row.get("part_id")}
    parts = (
        {part.id: part for part in db.scalars(select(Part).where(Part.id.in_(part_ids)))}
        if part_ids
        else {}
    )
    issues = []
    if snapshot.stale_sheets:
        issues.append(
            {
                "part_number": None,
                "component_tags": [],
                "warnings": [stale_sheets_note(snapshot.stale_sheets)],
                "code": "stale_index",
                "severity": "blocking",
            }
        )
    for row in snapshot.rows:
        warnings: list[str] = []
        code = "part_incomplete"
        severity = "warning"
        if row.get("kind") == "bulk":
            # Drawing-derived bulk items: tubing needs a size and a class/spec.
            if not row.get("size"):
                warnings.append("Line has no size; tubing and fittings cannot be quantified.")
                code = "line_no_size"
            elif not row.get("line_class") and not row.get("spec") and row.get("unit") == "m":
                warnings.append("Line has no line class or spec.")
                code = "line_no_class"
        else:
            part = parts.get(row.get("part_id")) if row.get("part_id") else None
            if part is None:
                warnings.append("No catalog part is linked to this BoM row.")
                code = "no_part"
                severity = "blocking"
            else:
                warnings.extend(qualification_warnings(part))
                if part.lifecycle_status in {"obsolete", "restricted"}:
                    code = f"part_{part.lifecycle_status}"
                    severity = "blocking"
        if warnings:
            issues.append(
                {
                    "part_number": row.get("part_number"),
                    "component_tags": row.get("component_tags") or [],
                    "warnings": warnings,
                    "code": code,
                    "severity": severity,
                }
            )
    blocking = sum(1 for issue in issues if issue["severity"] == "blocking")
    return {
        "snapshot_id": snapshot.id,
        "row_count": len(snapshot.rows),
        "issue_count": len(issues),
        "blocking_count": blocking,
        "warning_count": len(issues) - blocking,
        "ready": not issues,
        "issues": issues,
    }


@router.put("/bom/{snapshot_id}/status", response_model=BomSnapshotRead)
def update_bom_status(
    snapshot_id: str,
    payload: BomStatusUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> BomSnapshot:
    """Release a BoM snapshot. Released snapshots are immutable baselines.

    Release is refused (409) while readiness has blocking issues; `detail.issues`
    lists them. A released snapshot cannot return to draft: generate a new one.
    """
    snapshot = require_model(db, BomSnapshot, snapshot_id)
    if snapshot.diagram_id is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "Legacy diagram BoMs are read-only history; convert the diagram into a "
                "drawing and release the drawing's BoM."
            ),
        )
    if payload.status == snapshot.status:
        return snapshot
    if snapshot.status == "released":
        raise HTTPException(
            status_code=409,
            detail=(
                f"BoM revision {snapshot.revision} is released and immutable; "
                "generate a new BoM revision instead."
            ),
        )
    if payload.status == "released":
        readiness = _bom_readiness(db, snapshot)
        blocking = [issue for issue in readiness["issues"] if issue["severity"] == "blocking"]
        if blocking:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": (
                        f"BoM revision {snapshot.revision} has {len(blocking)} blocking "
                        "issue(s) and cannot be released."
                    ),
                    "issues": blocking,
                },
            )
        snapshot.released_by = user.email
        snapshot.released_at = datetime.now(UTC)
    snapshot.status = payload.status
    record_change(
        db,
        "bom_snapshot",
        snapshot.id,
        "updated",
        f"BoM revision {snapshot.revision} status set to {payload.status}",
        actor=user.email,
    )
    db.commit()
    db.refresh(snapshot)
    return snapshot


@router.get("/bom/{snapshot_id}/readiness", response_model=BomReadinessRead)
def bom_readiness(snapshot_id: str, db: Session = Depends(get_db)) -> dict:
    return _bom_readiness(db, require_model(db, BomSnapshot, snapshot_id))


def _bom_row_key(row: dict) -> str:
    """Identity of a BoM row across snapshots, mirroring how services/bom.py rolls rows up."""
    if row.get("part_id"):
        return f"part:{row['part_id']}"
    if row.get("kind") == "bulk":
        # Tube rows roll up per (class or spec, size), fittings and tees per size; the
        # description and unit name all of that. Line refs are shared across these rows.
        return f"bulk:{row.get('unit')}|{row.get('description')}"
    if row.get("symbol_key"):
        return f"symbol:{row['symbol_key']}"
    tags = row.get("component_tags") or []
    return f"tag:{tags[0] if tags else row.get('description', '?')}"


@router.get("/bom/{snapshot_id}/diff", response_model=BomDiffRead)
def bom_diff(snapshot_id: str, against_id: str, db: Session = Depends(get_db)) -> dict:
    current = require_model(db, BomSnapshot, snapshot_id)
    baseline = require_model(db, BomSnapshot, against_id)
    # Drawing snapshots have no diagram_id, so both sources must match.
    if (current.diagram_id, current.drawing_id) != (baseline.diagram_id, baseline.drawing_id):
        raise HTTPException(
            status_code=400,
            detail="BoM snapshots must belong to the same diagram or drawing to compare",
        )

    current_rows = {_bom_row_key(row): row for row in current.rows}
    baseline_rows = {_bom_row_key(row): row for row in baseline.rows}
    added = [current_rows[key] for key in sorted(current_rows.keys() - baseline_rows.keys())]
    removed = [baseline_rows[key] for key in sorted(baseline_rows.keys() - current_rows.keys())]
    changed = [
        {
            "part_number": current_rows[key].get("part_number"),
            "description": current_rows[key].get("description"),
            "from_quantity": baseline_rows[key].get("quantity", 0),
            "to_quantity": current_rows[key].get("quantity", 0),
        }
        for key in sorted(current_rows.keys() & baseline_rows.keys())
        if current_rows[key].get("quantity") != baseline_rows[key].get("quantity")
    ]
    return {
        "snapshot_id": current.id,
        "against_id": baseline.id,
        "added": added,
        "removed": removed,
        "changed": changed,
    }


BOM_CSV_FIELDS = [
    "part_number",
    "revision",
    "description",
    "manufacturer",
    "material",
    "pressure_rating_bar",
    "mass_kg",
    "cv",
    "quantity",
    "qualification_status",
    "certification_status",
    "component_tags",
    "kind",
    "unit",
    "spare_quantity",
    "dnp_tags",
    "sheets",
]


BOM_COLUMN_LABELS = {
    "part_number": "Part number",
    "revision": "Part rev",
    "description": "Description",
    "manufacturer": "Manufacturer",
    "material": "Material",
    "pressure_rating_bar": "Pressure rating (bar)",
    "mass_kg": "Mass (kg)",
    "cv": "Cv",
    "quantity": "Quantity",
    "qualification_status": "Qualification",
    "certification_status": "Certification",
    "component_tags": "Tags",
    "kind": "Kind",
    "unit": "Unit",
    "spare_quantity": "Spares",
    "dnp_tags": "DNP tags",
    "sheets": "Sheets",
}


def _bom_export_rows(snapshot: BomSnapshot) -> list[dict]:
    rows = []
    for row in snapshot.rows:
        record = {key: row.get(key) for key in BOM_CSV_FIELDS}
        for key in ("component_tags", "dnp_tags", "sheets"):
            if isinstance(record.get(key), list):
                record[key] = "; ".join(str(entry) for entry in record[key])
        rows.append(record)
    return rows


def _bom_filename(snapshot: BomSnapshot, extension: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", snapshot.diagram_name).strip("-.").lower() or "bom"
    return f"bom-{slug}-rev{snapshot.revision}.{extension}"


def _bom_header(db: Session, snapshot: BomSnapshot) -> dict:
    """Header block of a BoM export: what it was generated from and its release state."""
    header: dict = {"list": "Bill of materials"}
    if snapshot.drawing is not None:
        drawing = snapshot.drawing
        project = db.get(Project, drawing.project_id)
        header.update(
            {
                "project": project.name if project else "",
                "drawing_number": drawing.number,
                "drawing_title": drawing.title.replace("\n", " "),
                "drawing_revision": snapshot.drawing_revision or "-",
            }
        )
    elif snapshot.diagram is not None:
        header.update(
            {
                "project": snapshot.diagram.system.project.name,
                "diagram": snapshot.diagram.name,
            }
        )
    header.update(
        {
            "bom_revision": snapshot.revision,
            "status": snapshot.status,
            "generated": snapshot.created_at.strftime("%Y-%m-%d %H:%M UTC")
            if snapshot.created_at
            else "",
        }
    )
    if snapshot.released_by:
        header["released_by"] = snapshot.released_by
    if snapshot.stale_sheets:
        header["warning"] = stale_sheets_note(snapshot.stale_sheets)
    return header


@router.get("/bom/{snapshot_id}/csv")
def export_bom_csv(snapshot_id: str, db: Session = Depends(get_db)) -> Response:
    snapshot = require_model(db, BomSnapshot, snapshot_id)
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=BOM_CSV_FIELDS)
    writer.writeheader()
    for record in _bom_export_rows(snapshot):
        writer.writerow({key: spreadsheet_safe(value) for key, value in record.items()})
    return Response(
        buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{_bom_filename(snapshot, "csv")}"'},
    )


@router.get("/bom/{snapshot_id}/xlsx")
def export_bom_xlsx(snapshot_id: str, db: Session = Depends(get_db)) -> Response:
    """BoM snapshot as a workbook with a header block (project, source, revision, status)."""
    snapshot = require_model(db, BomSnapshot, snapshot_id)
    columns = [(key, BOM_COLUMN_LABELS[key]) for key in BOM_CSV_FIELDS]
    filename = _bom_filename(snapshot, "xlsx")
    return Response(
        rows_to_xlsx(_bom_header(db, snapshot), columns, _bom_export_rows(snapshot)),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/changes/impact", response_model=ImpactRead)
def change_impact(object_type: str, object_id: str, db: Session = Depends(get_db)) -> dict:
    return get_change_impact(db, object_type, object_id)


@router.get("/changes", response_model=list[ChangeEventRead])
def list_changes(limit: int = 50, db: Session = Depends(get_db)) -> list[ChangeEvent]:
    capped = max(1, min(limit, 200))
    return list(
        db.scalars(
            select(ChangeEvent)
            .order_by(ChangeEvent.created_at.desc(), ChangeEvent.id)
            .limit(capped)
        )
    )
