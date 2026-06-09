import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import (
    BomSnapshot,
    ChangeEvent,
    ComponentInstance,
    Diagram,
    DiagramEdge,
    DiagramNode,
    FluidSystem,
    Part,
    Project,
    Requirement,
    TraceLink,
)
from app.schemas import (
    BomSnapshotRead,
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
    ImpactRead,
    PartCreate,
    PartRead,
    PartUpdate,
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
from app.services.change_impact import get_change_impact
from app.services.traceability import get_trace_links

router = APIRouter()


def require_model(db: Session, model: type, object_id: str):
    item = db.get(model, object_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"{model.__name__} not found")
    return item


def record_change(db: Session, object_type: str, object_id: str, action: str, summary: str) -> None:
    db.add(
        ChangeEvent(object_type=object_type, object_id=object_id, action=action, summary=summary)
    )


def apply_updates(item, payload) -> None:
    for field, value in payload.model_dump(exclude_unset=True).items():
        if field == "metadata":
            item.metadata_ = value
        else:
            setattr(item, field, value)


def normalized_name(name: str) -> str:
    return name.strip().lower()


def normalized_column(column):
    return func.lower(func.trim(column))


@router.post("/projects", response_model=ProjectRead, status_code=201)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)) -> Project:
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
    record_change(db, "project", project.id, "created", f"Created project {project.name}")
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
    project_id: str, payload: ProjectUpdate, db: Session = Depends(get_db)
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
    record_change(db, "project", project.id, "updated", f"Updated project {project.name}")
    db.commit()
    db.refresh(project)
    return project


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, db: Session = Depends(get_db)) -> Response:
    project = require_model(db, Project, project_id)
    db.delete(project)
    db.commit()
    return Response(status_code=204)


@router.post("/projects/{project_id}/systems", response_model=FluidSystemRead, status_code=201)
def create_system(
    project_id: str, payload: FluidSystemCreate, db: Session = Depends(get_db)
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
    record_change(db, "fluid_system", system.id, "created", f"Created system {system.name}")
    db.commit()
    db.refresh(system)
    return system


@router.get("/projects/{project_id}/systems", response_model=list[FluidSystemRead])
def list_systems(project_id: str, db: Session = Depends(get_db)) -> list[FluidSystem]:
    require_model(db, Project, project_id)
    return list(db.scalars(select(FluidSystem).where(FluidSystem.project_id == project_id)))


@router.put("/systems/{system_id}", response_model=FluidSystemRead)
def update_system(
    system_id: str, payload: FluidSystemUpdate, db: Session = Depends(get_db)
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
    record_change(db, "fluid_system", system.id, "updated", f"Updated system {system.name}")
    db.commit()
    db.refresh(system)
    return system


@router.delete("/systems/{system_id}", status_code=204)
def delete_system(system_id: str, db: Session = Depends(get_db)) -> Response:
    system = require_model(db, FluidSystem, system_id)
    db.delete(system)
    db.commit()
    return Response(status_code=204)


@router.post("/systems/{system_id}/diagrams", response_model=DiagramRead, status_code=201)
def create_diagram(
    system_id: str, payload: DiagramCreate, db: Session = Depends(get_db)
) -> Diagram:
    require_model(db, FluidSystem, system_id)
    diagram = Diagram(system_id=system_id, graph={"nodes": [], "edges": []}, **payload.model_dump())
    db.add(diagram)
    db.flush()
    record_change(db, "diagram", diagram.id, "created", f"Created diagram {diagram.name}")
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
    diagram_id: str, payload: DiagramUpdate, db: Session = Depends(get_db)
) -> Diagram:
    diagram = require_model(db, Diagram, diagram_id)
    apply_updates(diagram, payload)
    record_change(db, "diagram", diagram.id, "updated", f"Updated diagram {diagram.name}")
    db.commit()
    db.refresh(diagram)
    return diagram


@router.delete("/diagrams/{diagram_id}", status_code=204)
def delete_diagram(diagram_id: str, db: Session = Depends(get_db)) -> Response:
    diagram = require_model(db, Diagram, diagram_id)
    db.delete(diagram)
    db.commit()
    return Response(status_code=204)


@router.put("/diagrams/{diagram_id}/graph", response_model=DiagramRead)
def update_diagram_graph(
    diagram_id: str, payload: DiagramGraphUpdate, db: Session = Depends(get_db)
) -> Diagram:
    diagram = require_model(db, Diagram, diagram_id)
    db.query(DiagramNode).filter(DiagramNode.diagram_id == diagram_id).delete()
    db.query(DiagramEdge).filter(DiagramEdge.diagram_id == diagram_id).delete()

    diagram.graph = payload.graph
    diagram.revision += 1
    db.add_all([DiagramNode(diagram_id=diagram_id, **node.model_dump()) for node in payload.nodes])
    db.add_all([DiagramEdge(diagram_id=diagram_id, **edge.model_dump()) for edge in payload.edges])
    record_change(db, "diagram", diagram.id, "updated", f"Updated graph for {diagram.name}")
    db.commit()
    db.refresh(diagram)
    return diagram


@router.post("/parts", response_model=PartRead, status_code=201)
def create_part(payload: PartCreate, db: Session = Depends(get_db)) -> Part:
    existing = db.scalar(select(Part).where(Part.part_number == payload.part_number))
    if existing:
        raise HTTPException(status_code=409, detail="Part number already exists")

    data = payload.model_dump()
    data["metadata_"] = data.pop("metadata")
    part = Part(**data)
    db.add(part)
    db.flush()
    record_change(db, "part", part.id, "created", f"Created part {part.part_number}")
    db.commit()
    db.refresh(part)
    return part


@router.get("/parts", response_model=list[PartRead])
def list_parts(
    part_type: str | None = None,
    material: str | None = None,
    manufacturer: str | None = None,
    qualification_status: str | None = None,
    min_pressure_bar: float | None = None,
    db: Session = Depends(get_db),
) -> list[Part]:
    stmt = select(Part)
    if part_type:
        stmt = stmt.where(Part.part_type == part_type)
    if material:
        stmt = stmt.where(Part.material == material)
    if manufacturer:
        stmt = stmt.where(Part.manufacturer == manufacturer)
    if qualification_status:
        stmt = stmt.where(Part.qualification_status == qualification_status)
    if min_pressure_bar is not None:
        stmt = stmt.where(Part.pressure_rating_bar >= min_pressure_bar)
    return list(db.scalars(stmt.order_by(Part.part_number)))


@router.get("/parts/{part_id}", response_model=PartRead)
def get_part(part_id: str, db: Session = Depends(get_db)) -> Part:
    return require_model(db, Part, part_id)


@router.put("/parts/{part_id}", response_model=PartRead)
def update_part(part_id: str, payload: PartUpdate, db: Session = Depends(get_db)) -> Part:
    part = require_model(db, Part, part_id)
    if payload.part_number:
        existing = db.scalar(
            select(Part).where(Part.part_number == payload.part_number, Part.id != part_id)
        )
        if existing:
            raise HTTPException(status_code=409, detail="Part number already exists")

    apply_updates(part, payload)
    record_change(db, "part", part.id, "updated", f"Updated part {part.part_number}")
    db.commit()
    db.refresh(part)
    return part


@router.delete("/parts/{part_id}", status_code=204)
def delete_part(part_id: str, db: Session = Depends(get_db)) -> Response:
    part = require_model(db, Part, part_id)
    db.delete(part)
    db.commit()
    return Response(status_code=204)


@router.post(
    "/diagrams/{diagram_id}/components", response_model=ComponentInstanceRead, status_code=201
)
def create_component(
    diagram_id: str, payload: ComponentInstanceCreate, db: Session = Depends(get_db)
) -> ComponentInstance:
    require_model(db, Diagram, diagram_id)
    if payload.part_id:
        require_model(db, Part, payload.part_id)
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
    record_change(db, "component", component.id, "created", f"Placed component {component.tag}")
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
    component_id: str, payload: ComponentInstanceUpdate, db: Session = Depends(get_db)
) -> ComponentInstance:
    component = require_model(db, ComponentInstance, component_id)
    if payload.part_id:
        require_model(db, Part, payload.part_id)
    if payload.node_id:
        node = require_model(db, DiagramNode, payload.node_id)
        if node.diagram_id != component.diagram_id:
            raise HTTPException(status_code=400, detail="Component node must belong to diagram")

    apply_updates(component, payload)
    record_change(db, "component", component.id, "updated", f"Updated component {component.tag}")
    db.commit()
    db.refresh(component)
    return component


@router.delete("/components/{component_id}", status_code=204)
def delete_component(component_id: str, db: Session = Depends(get_db)) -> Response:
    component = require_model(db, ComponentInstance, component_id)
    db.delete(component)
    db.commit()
    return Response(status_code=204)


@router.post("/requirements", response_model=RequirementRead, status_code=201)
def create_requirement(payload: RequirementCreate, db: Session = Depends(get_db)) -> Requirement:
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
        db, "requirement", requirement.id, "created", f"Created requirement {requirement.key}"
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
    requirement_id: str, payload: RequirementUpdate, db: Session = Depends(get_db)
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
        db, "requirement", requirement.id, "updated", f"Updated requirement {requirement.key}"
    )
    db.commit()
    db.refresh(requirement)
    return requirement


@router.delete("/requirements/{requirement_id}", status_code=204)
def delete_requirement(requirement_id: str, db: Session = Depends(get_db)) -> Response:
    requirement = require_model(db, Requirement, requirement_id)
    db.delete(requirement)
    db.commit()
    return Response(status_code=204)


@router.post("/trace-links", response_model=TraceLinkRead, status_code=201)
def create_trace_link(payload: TraceLinkCreate, db: Session = Depends(get_db)) -> TraceLink:
    link = TraceLink(**payload.model_dump())
    db.add(link)
    db.flush()
    record_change(db, "trace_link", link.id, "created", f"Created {link.link_type} trace link")
    db.commit()
    db.refresh(link)
    return link


@router.get("/objects/{object_type}/{object_id}/trace", response_model=list[TraceLinkRead])
def object_trace(
    object_type: str, object_id: str, db: Session = Depends(get_db)
) -> list[TraceLink]:
    return get_trace_links(db, object_type, object_id)


@router.post("/diagrams/{diagram_id}/bom", response_model=BomSnapshotRead, status_code=201)
def create_bom(diagram_id: str, db: Session = Depends(get_db)):
    diagram = require_model(db, Diagram, diagram_id)
    snapshot = generate_bom_snapshot(db, diagram)
    record_change(db, "bom_snapshot", snapshot.id, "created", f"Generated BoM for {diagram.name}")
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


@router.get("/projects/{project_id}/bom", response_model=list[BomSnapshotRead])
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


@router.get("/bom/{snapshot_id}/csv")
def export_bom_csv(snapshot_id: str, db: Session = Depends(get_db)) -> Response:
    snapshot = require_model(db, BomSnapshot, snapshot_id)
    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer,
        fieldnames=[
            "part_number",
            "revision",
            "description",
            "manufacturer",
            "quantity",
            "qualification_status",
            "certification_status",
        ],
    )
    writer.writeheader()
    for row in snapshot.rows:
        writer.writerow({key: row.get(key) for key in writer.fieldnames})
    return Response(buffer.getvalue(), media_type="text/csv")


@router.get("/changes/impact", response_model=ImpactRead)
def change_impact(object_type: str, object_id: str, db: Session = Depends(get_db)) -> dict:
    return get_change_impact(db, object_type, object_id)
