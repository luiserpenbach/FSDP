import csv
import io
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.security import require_admin, require_writer
from app.db import get_db
from app.models import (
    BomSnapshot,
    CatalogDocument,
    ChangeEvent,
    ComponentInstance,
    Diagram,
    DiagramEdge,
    DiagramNode,
    FluidSystem,
    Part,
    PidSymbolDef,
    Project,
    Requirement,
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
    ComponentInstanceCreate,
    ComponentInstanceRead,
    ComponentInstanceUpdate,
    DiagramCreate,
    DiagramGraphUpdate,
    DiagramRead,
    DiagramUpdate,
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
    TraceLinkCreate,
    TraceLinkRead,
)
from app.services.bom import generate_bom_snapshot
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
from app.services.traceability import (
    delete_trace_links_for,
    delete_trace_links_for_many,
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


@router.post("/systems/{system_id}/diagrams", response_model=DiagramRead, status_code=201)
def create_diagram(
    system_id: str,
    payload: DiagramCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Diagram:
    require_model(db, FluidSystem, system_id)
    existing = db.scalar(
        select(Diagram).where(
            Diagram.system_id == system_id,
            normalized_column(Diagram.name) == normalized_name(payload.name),
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="Diagram name already exists in system")

    diagram = Diagram(system_id=system_id, graph={"nodes": [], "edges": []}, **payload.model_dump())
    db.add(diagram)
    db.flush()
    record_change(
        db, "diagram", diagram.id, "created", f"Created diagram {diagram.name}", actor=user.email
    )
    db.commit()
    db.refresh(diagram)
    return diagram


@router.get("/systems/{system_id}/diagrams", response_model=list[DiagramRead])
def list_diagrams(system_id: str, db: Session = Depends(get_db)) -> list[Diagram]:
    require_model(db, FluidSystem, system_id)
    return list(db.scalars(select(Diagram).where(Diagram.system_id == system_id)))


@router.get("/diagrams/{diagram_id}", response_model=DiagramRead)
def get_diagram(diagram_id: str, db: Session = Depends(get_db)) -> Diagram:
    return require_model(db, Diagram, diagram_id)


@router.put("/diagrams/{diagram_id}", response_model=DiagramRead)
def update_diagram(
    diagram_id: str,
    payload: DiagramUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Diagram:
    diagram = require_model(db, Diagram, diagram_id)
    if payload.name is not None:
        existing = db.scalar(
            select(Diagram).where(
                Diagram.system_id == diagram.system_id,
                normalized_column(Diagram.name) == normalized_name(payload.name),
                Diagram.id != diagram_id,
            )
        )
        if existing:
            raise HTTPException(status_code=409, detail="Diagram name already exists in system")

    apply_updates(diagram, payload)
    record_change(
        db, "diagram", diagram.id, "updated", f"Updated diagram {diagram.name}", actor=user.email
    )
    db.commit()
    db.refresh(diagram)
    return diagram


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


@router.put("/diagrams/{diagram_id}/graph", response_model=DiagramRead)
def update_diagram_graph(
    diagram_id: str,
    payload: DiagramGraphUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Diagram:
    diagram = require_model(db, Diagram, diagram_id)

    node_ids = [node.external_id for node in payload.nodes]
    if len(node_ids) != len(set(node_ids)):
        raise HTTPException(status_code=422, detail="Diagram nodes must have unique ids")
    edge_ids = [edge.external_id for edge in payload.edges]
    if len(edge_ids) != len(set(edge_ids)):
        raise HTTPException(status_code=422, detail="Diagram lines must have unique ids")

    # Upsert by external_id so persisted node rows (and the component instances
    # bound to them) survive graph saves; only rows removed from the canvas go away.
    existing_nodes = {
        node.external_id: node
        for node in db.scalars(select(DiagramNode).where(DiagramNode.diagram_id == diagram_id))
    }
    for node_payload in payload.nodes:
        data = node_payload.model_dump()
        existing = existing_nodes.pop(node_payload.external_id, None)
        if existing is None:
            db.add(DiagramNode(diagram_id=diagram_id, **data))
        else:
            for field, value in data.items():
                setattr(existing, field, value)
    for removed_node in existing_nodes.values():
        db.delete(removed_node)

    existing_edges = {
        edge.external_id: edge
        for edge in db.scalars(select(DiagramEdge).where(DiagramEdge.diagram_id == diagram_id))
    }
    for edge_payload in payload.edges:
        data = edge_payload.model_dump()
        existing = existing_edges.pop(edge_payload.external_id, None)
        if existing is None:
            db.add(DiagramEdge(diagram_id=diagram_id, **data))
        else:
            for field, value in data.items():
                setattr(existing, field, value)
    for removed_edge in existing_edges.values():
        db.delete(removed_edge)

    diagram.graph = payload.graph
    diagram.revision += 1
    db.flush()

    # Re-bind components that lost their node link (e.g. data severed by the
    # previous delete-and-recreate save behavior) when the node still exists.
    nodes_by_external_id = {
        node.external_id: node
        for node in db.scalars(select(DiagramNode).where(DiagramNode.diagram_id == diagram_id))
    }
    components = db.scalars(
        select(ComponentInstance).where(ComponentInstance.diagram_id == diagram_id)
    )
    for component in components:
        if component.node_id is not None:
            continue
        external_id = (component.properties or {}).get("node_external_id")
        node = nodes_by_external_id.get(external_id) if external_id else None
        if node is not None:
            component.node_id = node.id

    record_change(
        db, "diagram", diagram.id, "updated", f"Updated graph for {diagram.name}", actor=user.email
    )
    db.commit()
    db.refresh(diagram)
    return diagram


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

    apply_updates(part, payload)
    if payload.part_type:
        remember_part_type(db, payload.part_type)
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
    return PartUsageRead(
        components=usage_components,
        bom_snapshots=[
            PartUsageBomRead(
                id=snapshot.id,
                diagram_id=snapshot.diagram_id,
                revision=snapshot.revision,
                status=snapshot.status,
            )
            for snapshot in snapshots
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


@router.post(
    "/parts/{part_id}/documents", response_model=CatalogDocumentRead, status_code=201
)
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


@router.post(
    "/diagrams/{diagram_id}/components", response_model=ComponentInstanceRead, status_code=201
)
def create_component(
    diagram_id: str,
    payload: ComponentInstanceCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> ComponentInstance:
    require_model(db, Diagram, diagram_id)
    if payload.part_id:
        placed = require_model(db, Part, payload.part_id)
        if placed.lifecycle_status == "obsolete":
            raise HTTPException(
                status_code=409,
                detail=f"Part {placed.part_number} is obsolete and cannot be placed.",
            )
    existing_tag = db.scalar(
        select(ComponentInstance).where(
            ComponentInstance.diagram_id == diagram_id,
            ComponentInstance.tag == payload.tag,
        )
    )
    if existing_tag:
        raise HTTPException(status_code=409, detail="Component tag already exists on this diagram")
    data = payload.model_dump()
    node_external_id = data.get("properties", {}).get("node_external_id")
    if node_external_id and not data.get("node_id"):
        node = db.scalar(
            select(DiagramNode).where(
                DiagramNode.diagram_id == diagram_id,
                DiagramNode.external_id == node_external_id,
            )
        )
        if node is None:
            raise HTTPException(status_code=400, detail="Selected diagram node does not exist")
        data["node_id"] = node.id
    if data.get("node_id"):
        node = require_model(db, DiagramNode, data["node_id"])
        if node.diagram_id != diagram_id:
            raise HTTPException(status_code=400, detail="Component node must belong to diagram")

    component = ComponentInstance(diagram_id=diagram_id, **data)
    db.add(component)
    db.flush()
    record_change(
        db, "component", component.id, "created", f"Placed component {component.tag}",
        actor=user.email,
    )
    db.commit()
    db.refresh(component)
    return component


@router.get("/diagrams/{diagram_id}/components", response_model=list[ComponentInstanceRead])
def list_components(diagram_id: str, db: Session = Depends(get_db)) -> list[ComponentInstance]:
    require_model(db, Diagram, diagram_id)
    return list(
        db.scalars(select(ComponentInstance).where(ComponentInstance.diagram_id == diagram_id))
    )


@router.put("/components/{component_id}", response_model=ComponentInstanceRead)
def update_component(
    component_id: str,
    payload: ComponentInstanceUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> ComponentInstance:
    component = require_model(db, ComponentInstance, component_id)
    if payload.part_id:
        placed = require_model(db, Part, payload.part_id)
        if placed.lifecycle_status == "obsolete":
            raise HTTPException(
                status_code=409,
                detail=f"Part {placed.part_number} is obsolete and cannot be placed.",
            )
    if payload.tag is not None:
        existing_tag = db.scalar(
            select(ComponentInstance).where(
                ComponentInstance.diagram_id == component.diagram_id,
                ComponentInstance.tag == payload.tag,
                ComponentInstance.id != component_id,
            )
        )
        if existing_tag:
            raise HTTPException(
                status_code=409, detail="Component tag already exists on this diagram"
            )
    if payload.node_id:
        node = require_model(db, DiagramNode, payload.node_id)
        if node.diagram_id != component.diagram_id:
            raise HTTPException(status_code=400, detail="Component node must belong to diagram")

    apply_updates(component, payload)
    record_change(
        db, "component", component.id, "updated", f"Updated component {component.tag}",
        actor=user.email,
    )
    db.commit()
    db.refresh(component)
    return component


@router.delete("/components/{component_id}", status_code=204)
def delete_component(
    component_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    component = require_model(db, ComponentInstance, component_id)
    delete_trace_links_for(db, "component", component.id)
    record_change(
        db, "component", component.id, "deleted", f"Deleted component {component.tag}",
        actor=user.email,
    )
    db.delete(component)
    db.commit()
    return Response(status_code=204)


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
    record_change(
        db, "requirement", requirement.id, "created", f"Created requirement {requirement.key}",
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

    apply_updates(requirement, payload)
    record_change(
        db, "requirement", requirement.id, "updated", f"Updated requirement {requirement.key}",
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
    record_change(
        db, "requirement", requirement.id, "deleted", f"Deleted requirement {requirement.key}",
        actor=user.email,
    )
    db.delete(requirement)
    db.commit()
    return Response(status_code=204)


TRACE_OBJECT_MODELS: dict[str, type] = {
    "project": Project,
    "fluid_system": FluidSystem,
    "diagram": Diagram,
    "part": Part,
    "component": ComponentInstance,
    "requirement": Requirement,
}


@router.post("/trace-links", response_model=TraceLinkRead, status_code=201)
def create_trace_link(
    payload: TraceLinkCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> TraceLink:
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
        require_model(db, model, object_id)

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
        db, "trace_link", link.id, "created", f"Created {link.link_type} trace link",
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
        db, "trace_link", link.id, "deleted", f"Deleted {link.link_type} trace link",
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


@router.post("/diagrams/{diagram_id}/bom", response_model=BomSnapshotRead, status_code=201)
def create_bom(
    diagram_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
):
    diagram = require_model(db, Diagram, diagram_id)
    snapshot = generate_bom_snapshot(db, diagram)
    record_change(
        db, "bom_snapshot", snapshot.id, "created", f"Generated BoM for {diagram.name}",
        actor=user.email,
    )
    db.commit()
    db.refresh(snapshot)
    return snapshot


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
    return list(
        db.scalars(
            select(BomSnapshot)
            .join(Diagram)
            .join(FluidSystem)
            .where(FluidSystem.project_id == project_id)
            .order_by(BomSnapshot.created_at.desc())
        )
    )


@router.put("/bom/{snapshot_id}/status", response_model=BomSnapshotRead)
def update_bom_status(
    snapshot_id: str,
    payload: BomStatusUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> BomSnapshot:
    snapshot = require_model(db, BomSnapshot, snapshot_id)
    snapshot.status = payload.status
    record_change(
        db, "bom_snapshot", snapshot.id, "updated",
        f"BoM revision {snapshot.revision} status set to {payload.status}",
        actor=user.email,
    )
    db.commit()
    db.refresh(snapshot)
    return snapshot


@router.get("/bom/{snapshot_id}/readiness", response_model=BomReadinessRead)
def bom_readiness(snapshot_id: str, db: Session = Depends(get_db)) -> dict:
    snapshot = require_model(db, BomSnapshot, snapshot_id)
    issues = []
    for row in snapshot.rows:
        warnings: list[str] = []
        part = db.get(Part, row.get("part_id")) if row.get("part_id") else None
        if part is None:
            warnings.append("No catalog part is linked to this BoM row.")
        else:
            warnings.extend(qualification_warnings(part))
        if warnings:
            issues.append(
                {
                    "part_number": row.get("part_number"),
                    "component_tags": row.get("component_tags") or [],
                    "warnings": warnings,
                }
            )
    return {
        "snapshot_id": snapshot.id,
        "row_count": len(snapshot.rows),
        "issue_count": len(issues),
        "ready": not issues,
        "issues": issues,
    }


def _bom_row_key(row: dict) -> str:
    if row.get("part_id"):
        return f"part:{row['part_id']}"
    tags = row.get("component_tags") or []
    return f"tag:{tags[0] if tags else row.get('description', '?')}"


@router.get("/bom/{snapshot_id}/diff", response_model=BomDiffRead)
def bom_diff(snapshot_id: str, against_id: str, db: Session = Depends(get_db)) -> dict:
    current = require_model(db, BomSnapshot, snapshot_id)
    baseline = require_model(db, BomSnapshot, against_id)
    if current.diagram_id != baseline.diagram_id:
        raise HTTPException(
            status_code=400, detail="BoM snapshots must belong to the same diagram to compare"
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
]


def csv_safe(value):
    # Guard spreadsheet formula injection when the CSV is opened in Excel.
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return f"'{value}"
    return value


@router.get("/bom/{snapshot_id}/csv")
def export_bom_csv(snapshot_id: str, db: Session = Depends(get_db)) -> Response:
    snapshot = require_model(db, BomSnapshot, snapshot_id)
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=BOM_CSV_FIELDS)
    writer.writeheader()
    for row in snapshot.rows:
        record = {key: row.get(key) for key in BOM_CSV_FIELDS}
        if isinstance(record.get("component_tags"), list):
            record["component_tags"] = "; ".join(str(tag) for tag in record["component_tags"])
        writer.writerow({key: csv_safe(value) for key, value in record.items()})

    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", snapshot.diagram.name).strip("-.").lower() or "diagram"
    filename = f"bom-{slug}-rev{snapshot.revision}.csv"
    return Response(
        buffer.getvalue(),
        media_type="text/csv",
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
