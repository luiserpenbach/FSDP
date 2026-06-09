from datetime import datetime
from typing import Any

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class OrmModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class ProjectCreate(BaseModel):
    name: str
    description: str | None = None
    owner: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    owner: str | None = None


class ProjectRead(ProjectCreate, OrmModel):
    id: str
    created_at: datetime
    updated_at: datetime


class FluidSystemCreate(BaseModel):
    name: str
    fluid: str | None = None
    description: str | None = None


class FluidSystemUpdate(BaseModel):
    name: str | None = None
    fluid: str | None = None
    description: str | None = None


class FluidSystemRead(FluidSystemCreate, OrmModel):
    id: str
    project_id: str
    created_at: datetime
    updated_at: datetime


class PartCreate(BaseModel):
    part_number: str
    revision: str | None = None
    description: str
    manufacturer: str | None = None
    part_type: str
    source_type: str = "internal"
    material: str | None = None
    pressure_rating_bar: float | None = None
    temperature_min_c: float | None = None
    temperature_max_c: float | None = None
    cv: float | None = None
    mass_kg: float | None = None
    dimensions: dict[str, Any] = Field(default_factory=dict)
    certification_status: str = "unreviewed"
    qualification_status: str = "unqualified"
    metadata: dict[str, Any] = Field(
        default_factory=dict, validation_alias=AliasChoices("metadata", "metadata_")
    )


class PartUpdate(BaseModel):
    part_number: str | None = None
    revision: str | None = None
    description: str | None = None
    manufacturer: str | None = None
    part_type: str | None = None
    source_type: str | None = None
    material: str | None = None
    pressure_rating_bar: float | None = None
    temperature_min_c: float | None = None
    temperature_max_c: float | None = None
    cv: float | None = None
    mass_kg: float | None = None
    dimensions: dict[str, Any] | None = None
    certification_status: str | None = None
    qualification_status: str | None = None
    metadata: dict[str, Any] | None = Field(
        default=None, validation_alias=AliasChoices("metadata", "metadata_")
    )


class PartRead(PartCreate, OrmModel):
    id: str
    created_at: datetime
    updated_at: datetime
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        validation_alias="metadata_",
        serialization_alias="metadata",
    )


class DiagramCreate(BaseModel):
    name: str
    diagram_type: str = "pid"


class DiagramUpdate(BaseModel):
    name: str | None = None
    diagram_type: str | None = None


class GraphNodeIn(BaseModel):
    external_id: str
    node_type: str
    label: str
    position: dict[str, Any] = Field(default_factory=dict)
    properties: dict[str, Any] = Field(default_factory=dict)


class GraphEdgeIn(BaseModel):
    external_id: str
    source_node_id: str
    target_node_id: str
    fluid: str | None = None
    pressure_bar: float | None = None
    temperature_c: float | None = None
    diameter_mm: float | None = None
    material: str | None = None
    flow_direction: str = "forward"
    properties: dict[str, Any] = Field(default_factory=dict)


class DiagramGraphUpdate(BaseModel):
    graph: dict[str, Any] = Field(default_factory=dict)
    nodes: list[GraphNodeIn] = Field(default_factory=list)
    edges: list[GraphEdgeIn] = Field(default_factory=list)


class DiagramRead(OrmModel):
    id: str
    system_id: str
    name: str
    diagram_type: str
    revision: int
    graph: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class ComponentInstanceCreate(BaseModel):
    node_id: str | None = None
    part_id: str | None = None
    tag: str
    quantity: int = 1
    properties: dict[str, Any] = Field(default_factory=dict)


class ComponentInstanceUpdate(BaseModel):
    node_id: str | None = None
    part_id: str | None = None
    tag: str | None = None
    quantity: int | None = None
    properties: dict[str, Any] | None = None


class ComponentInstanceRead(ComponentInstanceCreate, OrmModel):
    id: str
    diagram_id: str
    created_at: datetime
    updated_at: datetime


class RequirementCreate(BaseModel):
    project_id: str
    key: str
    title: str
    text: str
    requirement_type: str
    verification_method: str | None = None
    status: str = "draft"
    owner: str | None = None


class RequirementUpdate(BaseModel):
    key: str | None = None
    title: str | None = None
    text: str | None = None
    requirement_type: str | None = None
    verification_method: str | None = None
    status: str | None = None
    owner: str | None = None


class RequirementRead(RequirementCreate, OrmModel):
    id: str
    created_at: datetime
    updated_at: datetime


class TraceLinkCreate(BaseModel):
    source_type: str
    source_id: str
    target_type: str
    target_id: str
    link_type: str
    rationale: str | None = None


class TraceLinkRead(TraceLinkCreate, OrmModel):
    id: str
    created_at: datetime
    updated_at: datetime


class BomSnapshotRead(OrmModel):
    id: str
    diagram_id: str
    revision: int
    status: str
    rows: list[dict[str, Any]]
    created_at: datetime
    updated_at: datetime


class ImpactRead(BaseModel):
    object_type: str
    object_id: str
    direct_links: list[TraceLinkRead]
    affected_bom_snapshots: list[BomSnapshotRead]
    affected_components: list[ComponentInstanceRead]
