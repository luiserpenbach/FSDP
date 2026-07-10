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
    lifecycle_status: str = "active"
    family_id: str | None = None
    replacement_part_id: str | None = None
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
    lifecycle_status: str | None = None
    family_id: str | None = None
    replacement_part_id: str | None = None
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
    lifecycle_status: str = "active"
    verification_status: str = "not_started"
    set_id: str | None = None
    superseded_by_requirement_id: str | None = None


class RequirementUpdate(BaseModel):
    key: str | None = None
    title: str | None = None
    text: str | None = None
    requirement_type: str | None = None
    verification_method: str | None = None
    status: str | None = None
    owner: str | None = None
    lifecycle_status: str | None = None
    verification_status: str | None = None
    set_id: str | None = None
    superseded_by_requirement_id: str | None = None


class RequirementRead(RequirementCreate, OrmModel):
    id: str
    created_at: datetime
    updated_at: datetime


class RequirementSetCreate(BaseModel):
    name: str
    description: str | None = None
    requirement_type: str
    default_verification_method: str | None = None
    template_text: str | None = None
    template_properties: dict[str, Any] = Field(default_factory=dict)


class RequirementSetRead(RequirementSetCreate, OrmModel):
    id: str
    project_id: str
    created_at: datetime
    updated_at: datetime


class RequirementRevisionRead(OrmModel):
    id: str
    requirement_id: str
    revision_label: str | None
    change_summary: str
    snapshot: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class RequirementAttachmentCreate(BaseModel):
    filename: str
    attachment_type: str
    mime_type: str | None = None
    size_bytes: int | None = None
    content_base64: str | None = None


class RequirementAttachmentRead(RequirementAttachmentCreate, OrmModel):
    id: str
    requirement_id: str
    created_at: datetime
    updated_at: datetime


class RequirementCompareRead(BaseModel):
    left: RequirementRead
    right: RequirementRead
    differences: list[dict[str, Any]]


class RequirementBulkUpdate(BaseModel):
    requirement_ids: list[str]
    status: str | None = None
    owner: str | None = None
    verification_method: str | None = None
    requirement_type: str | None = None
    lifecycle_status: str | None = None
    verification_status: str | None = None
    set_id: str | None = None


class RequirementImportRequest(BaseModel):
    project_id: str
    csv_text: str
    column_mapping: dict[str, str]
    on_duplicate: str = "skip"


class RequirementImportResult(BaseModel):
    created: int
    updated: int
    skipped: int
    errors: list[str]


class RequirementVerificationMatrixRow(BaseModel):
    requirement_id: str
    key: str
    title: str
    requirement_type: str
    verification_method: str | None = None
    status: str
    verification_status: str
    verification_display: str
    link_count: int
    evidence_count: int
    linked_components: list[str]
    lifecycle_status: str


class TraceableComponentRead(BaseModel):
    component_id: str
    tag: str
    diagram_id: str
    diagram_name: str
    system_name: str
    part_number: str | None = None


class RequirementCoverageEntry(BaseModel):
    link_count: int
    linked: bool
    evidence_count: int = 0
    verification_display: str = "not_started"


class RequirementTraceabilityRead(BaseModel):
    requirement_id: str
    links: list[dict[str, Any]]
    components: list[dict[str, Any]]
    diagrams: list[dict[str, Any]]
    parts: list[dict[str, Any]]


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


class PartFamilyCreate(BaseModel):
    name: str
    description: str | None = None
    part_type: str
    template_properties: dict[str, Any] = Field(default_factory=dict)


class PartFamilyRead(PartFamilyCreate, OrmModel):
    id: str
    created_at: datetime
    updated_at: datetime


class PartRevisionRead(OrmModel):
    id: str
    part_id: str
    revision_label: str | None
    change_summary: str
    snapshot: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class PartAttachmentCreate(BaseModel):
    filename: str
    attachment_type: str
    mime_type: str | None = None
    size_bytes: int | None = None
    content_base64: str | None = None


class PartAttachmentRead(PartAttachmentCreate, OrmModel):
    id: str
    part_id: str
    created_at: datetime
    updated_at: datetime


class PartWhereUsedRead(BaseModel):
    part_id: str
    components: list[dict[str, Any]]
    diagrams: list[dict[str, Any]]
    bom_snapshots: list[dict[str, Any]]
    requirements: list[dict[str, Any]]


class PartCompareRead(BaseModel):
    left: PartRead
    right: PartRead
    differences: list[dict[str, Any]]


class PartBulkUpdate(BaseModel):
    part_ids: list[str]
    manufacturer: str | None = None
    material: str | None = None
    qualification_status: str | None = None
    certification_status: str | None = None
    lifecycle_status: str | None = None
    family_id: str | None = None


class PartImportRequest(BaseModel):
    csv_text: str
    column_mapping: dict[str, str]
    on_duplicate: str = "skip"


class PartImportResult(BaseModel):
    created: int
    updated: int
    skipped: int
    errors: list[str]
