import re
from datetime import datetime
from typing import Any

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


def clean_required_text(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("must not be blank")
    return cleaned


def clean_optional_text(value: str | None) -> str | None:
    return None if value is None else clean_required_text(value)


class OrmModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


VALID_USER_ROLES = {"admin", "engineer", "viewer"}


def clean_email(value: str) -> str:
    cleaned = value.strip().lower()
    if len(cleaned) < 3 or "@" not in cleaned or " " in cleaned:
        raise ValueError("must be a valid email address")
    return cleaned


def clean_role(value: str) -> str:
    if value not in VALID_USER_ROLES:
        raise ValueError("must be one of: " + ", ".join(sorted(VALID_USER_ROLES)))
    return value


class LoginRequest(BaseModel):
    email: str
    password: str


class UserCreate(BaseModel):
    email: str
    name: str
    password: str = Field(min_length=8, max_length=72)
    role: str = "engineer"

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        return clean_email(value)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return clean_required_text(value)

    @field_validator("role")
    @classmethod
    def _role(cls, value: str) -> str:
        return clean_role(value)


class UserUpdate(BaseModel):
    name: str | None = None
    password: str | None = Field(default=None, min_length=8, max_length=72)
    role: str | None = None
    is_active: bool | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return clean_optional_text(value)

    @field_validator("role")
    @classmethod
    def _role(cls, value: str | None) -> str | None:
        return None if value is None else clean_role(value)


class UserRead(OrmModel):
    id: str
    email: str
    name: str
    role: str
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ChangeEventRead(OrmModel):
    id: str
    object_type: str
    object_id: str
    action: str
    summary: str
    actor: str | None
    created_at: datetime


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

    @field_validator("part_number", "description", "part_type")
    @classmethod
    def _required_text(cls, value: str) -> str:
        return clean_required_text(value)


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

    @field_validator("part_number", "description", "part_type")
    @classmethod
    def _required_text(cls, value: str | None) -> str | None:
        return clean_optional_text(value)


class PartRead(PartCreate, OrmModel):
    id: str
    created_at: datetime
    updated_at: datetime
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        validation_alias="metadata_",
        serialization_alias="metadata",
    )


# Symbols are rendered via dangerouslySetInnerHTML. Block active content and
# nesting vectors that the earlier script/onload checks missed (data: URIs in
# <use>/<image>, SMIL <set attributeName="onload">, <style> imports, etc.).
_SVG_BLOCKLIST = (
    "<script",
    "<foreignobject",
    "<iframe",
    "<style",
    "<use",
    "<image",
    "<set",
    "<animate",  # animate, animateTransform, animateMotion
    "<a ",
    "<a>",
    "<a/",
    "javascript:",
    "data:",
    "vbscript:",
)
_SVG_EVENT_ATTR = re.compile(r"\son\w+\s*=")
_SVG_SMIL_EVENT_ATTR = re.compile(r"""attributename\s*=\s*['"]?\s*on""", re.IGNORECASE)
# Only fragment hrefs (#id) are allowed; anything else is an external/data load.
_SVG_EXTERNAL_HREF = re.compile(r"""(?:xlink:)?href\s*=\s*['"]?\s*(?!#)""", re.IGNORECASE)


def clean_symbol_svg(value: str) -> str:
    """Reject active content; the frontend sanitizes too, but the API is the trust boundary."""
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("must not be blank")
    lowered = cleaned.lower()
    if (
        any(token in lowered for token in _SVG_BLOCKLIST)
        or _SVG_EVENT_ATTR.search(lowered)
        or _SVG_SMIL_EVENT_ATTR.search(lowered)
        or _SVG_EXTERNAL_HREF.search(lowered)
    ):
        raise ValueError("SVG markup must not contain scripts, embeds, or event handlers")
    return cleaned


class SymbolPort(BaseModel):
    id: str
    x: float
    y: float
    side: str = "left"

    @field_validator("id")
    @classmethod
    def _required_text(cls, value: str) -> str:
        return clean_required_text(value)

    @field_validator("side")
    @classmethod
    def _valid_side(cls, value: str) -> str:
        if value not in {"left", "right", "top", "bottom"}:
            raise ValueError("must be one of: left, right, top, bottom")
        return value


class PidSymbolCreate(BaseModel):
    name: str
    view_box: str = "0 0 64 40"
    svg: str
    ports: list[SymbolPort] = Field(default_factory=list)

    @field_validator("name", "view_box")
    @classmethod
    def _required_text(cls, value: str) -> str:
        return clean_required_text(value)

    @field_validator("svg")
    @classmethod
    def _safe_svg(cls, value: str) -> str:
        return clean_symbol_svg(value)


class PidSymbolUpdate(BaseModel):
    name: str | None = None
    view_box: str | None = None
    svg: str | None = None
    ports: list[SymbolPort] | None = None

    @field_validator("name", "view_box")
    @classmethod
    def _required_text(cls, value: str | None) -> str | None:
        return clean_optional_text(value)

    @field_validator("svg")
    @classmethod
    def _safe_svg(cls, value: str | None) -> str | None:
        return None if value is None else clean_symbol_svg(value)


class PidSymbolRead(OrmModel):
    id: str
    name: str
    view_box: str
    svg: str
    ports: list[SymbolPort]
    created_at: datetime
    updated_at: datetime


class DiagramCreate(BaseModel):
    name: str
    diagram_type: str = "pid"

    @field_validator("name")
    @classmethod
    def _required_text(cls, value: str) -> str:
        return clean_required_text(value)


class DiagramUpdate(BaseModel):
    name: str | None = None
    diagram_type: str | None = None

    @field_validator("name")
    @classmethod
    def _required_text(cls, value: str | None) -> str | None:
        return clean_optional_text(value)


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
    quantity: int = Field(default=1, ge=1)
    properties: dict[str, Any] = Field(default_factory=dict)

    @field_validator("tag")
    @classmethod
    def _required_text(cls, value: str) -> str:
        return clean_required_text(value)


class ComponentInstanceUpdate(BaseModel):
    node_id: str | None = None
    part_id: str | None = None
    tag: str | None = None
    quantity: int | None = Field(default=None, ge=1)
    properties: dict[str, Any] | None = None

    @field_validator("tag")
    @classmethod
    def _required_text(cls, value: str | None) -> str | None:
        return clean_optional_text(value)


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

    @field_validator("key", "title", "text", "requirement_type")
    @classmethod
    def _required_text(cls, value: str) -> str:
        return clean_required_text(value)


class RequirementUpdate(BaseModel):
    key: str | None = None
    title: str | None = None
    text: str | None = None
    requirement_type: str | None = None
    verification_method: str | None = None
    status: str | None = None
    owner: str | None = None

    @field_validator("key", "title", "text", "requirement_type")
    @classmethod
    def _required_text(cls, value: str | None) -> str | None:
        return clean_optional_text(value)


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


class ProjectBomRead(BomSnapshotRead):
    diagram_name: str


VALID_BOM_STATUSES = {"draft", "released"}


class BomStatusUpdate(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def _status(cls, value: str) -> str:
        if value not in VALID_BOM_STATUSES:
            raise ValueError("must be one of: " + ", ".join(sorted(VALID_BOM_STATUSES)))
        return value


class BomReadinessIssue(BaseModel):
    part_number: str | None
    component_tags: list[str]
    warnings: list[str]


class BomReadinessRead(BaseModel):
    snapshot_id: str
    row_count: int
    issue_count: int
    ready: bool
    issues: list[BomReadinessIssue]


class BomQuantityChange(BaseModel):
    part_number: str | None
    description: str | None
    from_quantity: int
    to_quantity: int


class BomDiffRead(BaseModel):
    snapshot_id: str
    against_id: str
    added: list[dict[str, Any]]
    removed: list[dict[str, Any]]
    changed: list[BomQuantityChange]


class ImpactRead(BaseModel):
    object_type: str
    object_id: str
    direct_links: list[TraceLinkRead]
    affected_bom_snapshots: list[BomSnapshotRead]
    affected_components: list[ComponentInstanceRead]
