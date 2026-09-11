import re
from datetime import datetime
from typing import Any

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator


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
    part_name_prefix: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    owner: str | None = None
    part_name_prefix: str | None = None


class ProjectRead(ProjectCreate, OrmModel):
    id: str
    created_at: datetime
    updated_at: datetime
    part_name_next_sequence: int = 1


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
    lifecycle_status: str = "draft"
    preferred: bool = False
    notes: str | None = None
    metadata: dict[str, Any] = Field(
        default_factory=dict, validation_alias=AliasChoices("metadata", "metadata_")
    )

    @field_validator("part_number", "description", "part_type")
    @classmethod
    def _required_text(cls, value: str) -> str:
        return clean_required_text(value)

    @field_validator("source_type")
    @classmethod
    def _source_type(cls, value: str) -> str:
        from app.services.catalog import SOURCE_TYPES

        if value not in SOURCE_TYPES:
            raise ValueError("must be one of: " + ", ".join(sorted(SOURCE_TYPES)))
        return value

    @field_validator("lifecycle_status")
    @classmethod
    def _lifecycle(cls, value: str) -> str:
        from app.services.catalog import LIFECYCLE_STATUSES

        if value not in LIFECYCLE_STATUSES:
            raise ValueError("must be one of: " + ", ".join(sorted(LIFECYCLE_STATUSES)))
        return value

    @field_validator("qualification_status")
    @classmethod
    def _qualification(cls, value: str) -> str:
        from app.services.catalog import QUALIFICATION_STATUSES

        if value not in QUALIFICATION_STATUSES:
            raise ValueError("must be one of: " + ", ".join(sorted(QUALIFICATION_STATUSES)))
        return value

    @field_validator("certification_status")
    @classmethod
    def _certification(cls, value: str) -> str:
        from app.services.catalog import CERTIFICATION_STATUSES

        if value not in CERTIFICATION_STATUSES:
            raise ValueError("must be one of: " + ", ".join(sorted(CERTIFICATION_STATUSES)))
        return value

    @model_validator(mode="after")
    def _active_when_qualified(self) -> "PartCreate":
        if self.lifecycle_status == "draft" and (
            self.preferred or self.qualification_status == "qualified"
        ):
            self.lifecycle_status = "active"
        return self


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
    preferred: bool | None = None
    notes: str | None = None
    metadata: dict[str, Any] | None = Field(
        default=None, validation_alias=AliasChoices("metadata", "metadata_")
    )

    @field_validator("part_number", "description", "part_type")
    @classmethod
    def _required_text(cls, value: str | None) -> str | None:
        return clean_optional_text(value)

    @field_validator("source_type")
    @classmethod
    def _source_type(cls, value: str | None) -> str | None:
        from app.services.catalog import SOURCE_TYPES

        if value is None:
            return None
        if value not in SOURCE_TYPES:
            raise ValueError("must be one of: " + ", ".join(sorted(SOURCE_TYPES)))
        return value

    @field_validator("lifecycle_status")
    @classmethod
    def _lifecycle(cls, value: str | None) -> str | None:
        from app.services.catalog import LIFECYCLE_STATUSES

        if value is None:
            return None
        if value not in LIFECYCLE_STATUSES:
            raise ValueError("must be one of: " + ", ".join(sorted(LIFECYCLE_STATUSES)))
        return value

    @field_validator("qualification_status")
    @classmethod
    def _qualification(cls, value: str | None) -> str | None:
        from app.services.catalog import QUALIFICATION_STATUSES

        if value is None:
            return None
        if value not in QUALIFICATION_STATUSES:
            raise ValueError("must be one of: " + ", ".join(sorted(QUALIFICATION_STATUSES)))
        return value

    @field_validator("certification_status")
    @classmethod
    def _certification(cls, value: str | None) -> str | None:
        from app.services.catalog import CERTIFICATION_STATUSES

        if value is None:
            return None
        if value not in CERTIFICATION_STATUSES:
            raise ValueError("must be one of: " + ", ".join(sorted(CERTIFICATION_STATUSES)))
        return value


class PartRead(PartCreate, OrmModel):
    id: str
    created_at: datetime
    updated_at: datetime
    completeness: int = 0
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        validation_alias="metadata_",
        serialization_alias="metadata",
    )


class CatalogSettingsRead(OrmModel):
    prefix: str
    sequence_padding: int
    next_sequence: int
    part_types: list[str]


class CatalogSettingsUpdate(BaseModel):
    prefix: str | None = None
    sequence_padding: int | None = Field(default=None, ge=1, le=8)
    next_sequence: int | None = Field(default=None, ge=1)
    part_types: list[str] | None = None

    @field_validator("prefix")
    @classmethod
    def _prefix(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("must not be blank")
        if any(ch.isspace() for ch in cleaned):
            raise ValueError("must not contain spaces")
        return cleaned


class GeneratePartNameRequest(BaseModel):
    project_id: str | None = None


class GeneratePartNameRead(BaseModel):
    part_number: str


class CatalogDocumentRead(OrmModel):
    id: str
    part_id: str
    title: str
    kind: str
    original_filename: str
    content_type: str
    size_bytes: int
    source_url: str | None = None
    uploaded_by: str | None = None
    created_at: datetime
    updated_at: datetime


class PartUsageComponentRead(OrmModel):
    id: str
    tag: str
    quantity: int
    diagram_id: str
    diagram_name: str
    system_id: str
    system_name: str
    project_id: str
    project_name: str


class PartUsageBomRead(OrmModel):
    id: str
    diagram_id: str
    revision: int
    status: str


class PartUsageDrawingItemRead(BaseModel):
    sheet_id: str
    item_id: str
    tag: str | None
    zone: str | None
    dnp: bool
    drawing_id: str
    drawing_number: str
    drawing_title: str
    sheet_no: int
    project_id: str


class PartUsageRead(BaseModel):
    components: list[PartUsageComponentRead]
    bom_snapshots: list[PartUsageBomRead]
    drawing_items: list[PartUsageDrawingItemRead] = []


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
    category: str | None = None
    legend: str | None = None
    tag_prefix: str | None = None

    @field_validator("category", "legend", "tag_prefix")
    @classmethod
    def _optional_meta(cls, value: str | None) -> str | None:
        return clean_optional_text(value)

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
    category: str | None = None
    legend: str | None = None
    tag_prefix: str | None = None

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
    category: str | None = None
    legend: str | None = None
    tag_prefix: str | None = None
    created_at: datetime
    updated_at: datetime


class LineClassCreate(BaseModel):
    name: str
    description: str | None = None
    material: str | None = None
    rating: str | None = None
    wall: str | None = None
    sizes: list[str] = Field(default_factory=list)
    insulation: str | None = None
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return clean_required_text(value)

    @field_validator("sizes", mode="before")
    @classmethod
    def _sizes_list(cls, value: Any) -> Any:
        return [] if value is None else value

    @field_validator("sizes")
    @classmethod
    def _sizes(cls, value: list[str]) -> list[str]:
        cleaned = [str(entry).strip() for entry in value if str(entry).strip()]
        return list(dict.fromkeys(cleaned))


class LineClassUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    material: str | None = None
    rating: str | None = None
    wall: str | None = None
    sizes: list[str] | None = None
    insulation: str | None = None
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return clean_optional_text(value)

    @field_validator("sizes", mode="before")
    @classmethod
    def _sizes_list(cls, value: Any) -> Any:
        # Explicit JSON null must not persist: LineClassRead requires a list, and
        # one null sizes row makes GET /projects/{id}/line-classes fail for the project.
        return [] if value is None else value

    @field_validator("sizes")
    @classmethod
    def _sizes(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        cleaned = [str(entry).strip() for entry in value if str(entry).strip()]
        return list(dict.fromkeys(cleaned))


class LineClassRead(OrmModel):
    id: str
    project_id: str
    name: str
    description: str | None
    material: str | None
    rating: str | None
    wall: str | None
    sizes: list[str] = Field(default_factory=list)
    insulation: str | None
    notes: str | None
    created_at: datetime
    updated_at: datetime

    @field_validator("sizes", mode="before")
    @classmethod
    def _sizes_list(cls, value: Any) -> Any:
        return [] if value is None else value


class LineClassImportIn(BaseModel):
    """CSV text with a header row.

    Columns: name, material, rating, wall, sizes (semicolon separated), insulation,
    description, notes.
    """

    csv: str
    replace: bool = False


class LineClassImportRead(BaseModel):
    created: int
    updated: int
    errors: list[str]


class TagSchemeIn(BaseModel):
    scheme: dict[str, Any]

    @field_validator("scheme")
    @classmethod
    def _validate_scheme(cls, value: dict[str, Any]) -> dict[str, Any]:
        kind = value.get("kind", "simple")
        if kind not in {"simple", "structured"}:
            raise ValueError("kind must be simple or structured")
        separator = value.get("separator", "-")
        if not isinstance(separator, str) or len(separator) > 2:
            raise ValueError("separator must be a string of at most two characters")
        for key in ("functionLetters", "firstLetters", "succeedingLetters", "systems", "classes"):
            entries = value.get(key, [])
            if not isinstance(entries, list) or any(
                not isinstance(entry, dict) for entry in entries
            ):
                raise ValueError(f"{key} must be a list of objects")
        length = value.get("sequenceLength", 1)
        if not isinstance(length, int) or length < 1 or length > 6:
            raise ValueError("sequenceLength must be between 1 and 6")
        return value


class TagSchemeRead(BaseModel):
    project_id: str
    scheme: dict[str, Any] | None


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


SCHEMATIC_SCHEMA_VERSION = 1


class SchematicDocumentIn(BaseModel):
    document: dict[str, Any]

    @field_validator("document")
    @classmethod
    def _validate_document(cls, value: dict[str, Any]) -> dict[str, Any]:
        if value.get("schemaVersion") != SCHEMATIC_SCHEMA_VERSION:
            raise ValueError(f"schemaVersion must be {SCHEMATIC_SCHEMA_VERSION}")
        if not isinstance(value.get("sheet"), dict):
            raise ValueError("sheet is required")
        items = value.get("items")
        if not isinstance(items, list):
            raise ValueError("items must be a list")
        seen: set[str] = set()
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                raise ValueError("every item needs a string id")
            if item["id"] in seen:
                raise ValueError(f"duplicate item id {item['id']}")
            seen.add(item["id"])
            if not isinstance(item.get("kind"), str):
                raise ValueError(f"item {item['id']} has no kind")
        return value


class SchematicRead(BaseModel):
    diagram_id: str
    revision: int
    document: dict[str, Any] | None


VALID_SHEET_SIZES = {"A4", "A3", "A2", "A1", "A0", "ANSI_A", "ANSI_B", "ANSI_C", "ANSI_D", "ANSI_E"}
VALID_FRAME_TEMPLATES = {"none", "basic", "fsdp-standard"}


def _clean_sheet_size(value: str | None) -> str | None:
    if value is None:
        return None
    if value not in VALID_SHEET_SIZES:
        raise ValueError(f"size must be one of {sorted(VALID_SHEET_SIZES)}")
    return value


def _clean_frame_template(value: str | None) -> str | None:
    if value is None:
        return None
    if value not in VALID_FRAME_TEMPLATES:
        raise ValueError(f"frame_template must be one of {sorted(VALID_FRAME_TEMPLATES)}")
    return value


class DrawingRevisionCreate(BaseModel):
    label: str = "-"
    description: str = "Initial issue"
    drawn_by: str | None = None
    drawn_date: str | None = None
    checked_by: str | None = None
    checked_date: str | None = None
    approved_by: str | None = None
    approved_date: str | None = None

    @field_validator("label")
    @classmethod
    def _label(cls, value: str) -> str:
        return clean_required_text(value)


class DrawingRevisionUpdate(BaseModel):
    label: str | None = None
    description: str | None = None
    drawn_by: str | None = None
    drawn_date: str | None = None
    checked_by: str | None = None
    checked_date: str | None = None
    approved_by: str | None = None
    approved_date: str | None = None


class DrawingRevisionRead(OrmModel):
    id: str
    drawing_id: str
    sequence: int
    label: str
    description: str
    status: str
    drawn_by: str | None
    drawn_date: str | None
    checked_by: str | None
    checked_date: str | None
    approved_by: str | None
    approved_date: str | None
    created_at: datetime


class DrawingSheetCreate(BaseModel):
    title: str | None = None
    source_diagram_id: str | None = None
    document: dict[str, Any] | None = None

    @field_validator("document")
    @classmethod
    def _document(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        return SchematicDocumentIn(document=value).document


class SheetIndexItemIn(BaseModel):
    """One symbol or equipment item as indexed by the engine at save time."""

    item_id: str
    kind: str
    category: str | None = None
    symbol_key: str | None = None
    symbol_name: str | None = None
    tag: str | None = None
    label: str | None = None
    zone: str | None = None
    x: float | None = None
    y: float | None = None
    part_id: str | None = None
    dnp: bool = False
    spare: int = 0
    fields: dict[str, Any] = Field(default_factory=dict)

    @field_validator("kind")
    @classmethod
    def _kind(cls, value: str) -> str:
        if value not in {"symbol", "equipment"}:
            raise ValueError("must be 'symbol' or 'equipment'")
        return value

    @field_validator("spare")
    @classmethod
    def _spare(cls, value: int) -> int:
        return max(0, value)


class SheetIndexLineIn(BaseModel):
    line_id: str
    line_number: str | None = None
    line_type: str = "process"
    service: str | None = None
    size: str | None = None
    spec: str | None = None
    line_class: str | None = None
    from_item: str | None = None
    from_tag: str | None = None
    to_item: str | None = None
    to_tag: str | None = None
    zone: str | None = None
    length_mm: float = 0.0
    length_m: float | None = None
    connection_count: int = 0
    tee_count: int = 0
    design_pressure: str | None = None
    design_temperature: str | None = None
    operating_pressure: str | None = None
    operating_temperature: str | None = None
    insulation: str | None = None
    tracing: str | None = None
    fields: dict[str, Any] = Field(default_factory=dict)


class SheetIndexIn(BaseModel):
    items: list[SheetIndexItemIn] = Field(default_factory=list)
    lines: list[SheetIndexLineIn] = Field(default_factory=list)


class SheetItemRead(SheetIndexItemIn, OrmModel):
    id: str
    sheet_id: str


class SheetLineRead(SheetIndexLineIn, OrmModel):
    id: str
    sheet_id: str


class SheetIndexRead(BaseModel):
    sheet_id: str
    items: list[SheetItemRead]
    lines: list[SheetLineRead]


class ListColumnRead(BaseModel):
    key: str
    label: str


class ListRead(BaseModel):
    """An engineering list (instrument index, line list, ...) with its header."""

    kind: str
    title: str
    scope: str
    header: dict[str, Any]
    columns: list[ListColumnRead]
    rows: list[dict[str, Any]]


DRC_SEVERITIES = {"error", "warning", "info"}


class DrcFindingIn(BaseModel):
    key: str
    rule: str
    severity: str = "warning"
    message: str
    item_id: str | None = Field(default=None, validation_alias=AliasChoices("item_id", "itemId"))
    subject: str | None = None
    zone: str | None = None
    requirement_id: str | None = Field(
        default=None, validation_alias=AliasChoices("requirement_id", "requirementId")
    )

    @field_validator("severity")
    @classmethod
    def _severity(cls, value: str) -> str:
        if value not in DRC_SEVERITIES:
            raise ValueError("must be one of: " + ", ".join(sorted(DRC_SEVERITIES)))
        return value


class DrcRequirementCheckIn(BaseModel):
    requirement_id: str = Field(validation_alias=AliasChoices("requirement_id", "requirementId"))
    item_id: str = Field(validation_alias=AliasChoices("item_id", "itemId"))
    subject: str | None = None
    zone: str | None = None
    status: str = "pass"
    message: str = ""

    @field_validator("status")
    @classmethod
    def _status(cls, value: str) -> str:
        if value not in {"pass", "fail"}:
            raise ValueError("must be 'pass' or 'fail'")
        return value


class DrcIn(BaseModel):
    """The engine's DRC run for a sheet: open findings and requirement checks."""

    findings: list[DrcFindingIn] = Field(default_factory=list)
    checks: list[DrcRequirementCheckIn] = Field(default_factory=list)


class DrcResultRead(OrmModel):
    id: str
    sheet_id: str
    key: str
    rule: str
    severity: str
    message: str
    item_id: str | None
    subject: str | None
    zone: str | None
    requirement_id: str | None


class DrcWaiverIn(BaseModel):
    key: str
    reason: str

    @field_validator("key", "reason")
    @classmethod
    def _text(cls, value: str) -> str:
        return clean_required_text(value)


class DrcWaiverRead(OrmModel):
    id: str
    sheet_id: str
    key: str
    reason: str
    waived_by: str | None
    created_at: datetime


class DrcRequirementCheckRead(OrmModel):
    id: str
    sheet_id: str
    requirement_id: str
    item_id: str
    subject: str | None
    zone: str | None
    status: str
    message: str


class SheetDrcRead(BaseModel):
    sheet_id: str
    sheet_no: int
    counts: dict[str, int]
    findings: list[DrcResultRead]
    waivers: list[DrcWaiverRead]
    checks: list[DrcRequirementCheckRead]


class DrawingDrcRead(BaseModel):
    drawing_id: str
    counts: dict[str, int]
    sheets: list[SheetDrcRead]


class VerificationRowRead(BaseModel):
    requirement_id: str
    key: str
    title: str
    status: str
    constraint: dict[str, Any] | None
    checked: int
    passed: int
    failed: int
    verdict: str
    drawings: list[dict[str, Any]]
    linked_components: int
    linked_drawings: int
    failures: list[DrcRequirementCheckRead]


class VerificationMatrixRead(BaseModel):
    project_id: str
    rows: list[VerificationRowRead]


class DrawingSheetUpdate(BaseModel):
    title: str | None = None
    document: dict[str, Any] | None = None
    # Index rows computed by the engine for this document (replaces the stored index).
    index: SheetIndexIn | None = None
    # The engine's DRC run for this document (replaces stored findings and checks).
    drc: DrcIn | None = None

    @field_validator("document")
    @classmethod
    def _document(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        return SchematicDocumentIn(document=value).document


class DrawingSheetRead(OrmModel):
    id: str
    drawing_id: str
    sheet_no: int
    title: str | None
    source_diagram_id: str | None
    document: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class DrawingSheetSummary(OrmModel):
    id: str
    sheet_no: int
    title: str | None
    source_diagram_id: str | None


class DrawingCreate(BaseModel):
    title: str
    number: str | None = None
    system_id: str | None = None
    size: str = "A3"
    units: str = "mm"
    discipline: str = "P&ID"
    frame_template: str = "fsdp-standard"
    fields: dict[str, Any] = Field(default_factory=dict)
    notes: list[str] = Field(default_factory=list)
    first_sheet: DrawingSheetCreate | None = None
    revision: DrawingRevisionCreate | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        return clean_required_text(value)

    @field_validator("number")
    @classmethod
    def _number(cls, value: str | None) -> str | None:
        return clean_optional_text(value)

    @field_validator("size")
    @classmethod
    def _size(cls, value: str) -> str:
        return _clean_sheet_size(value) or "A3"

    @field_validator("frame_template")
    @classmethod
    def _frame(cls, value: str) -> str:
        return _clean_frame_template(value) or "fsdp-standard"

    @field_validator("fields", mode="before")
    @classmethod
    def _fields_object(cls, value: Any) -> Any:
        return {} if value is None else value

    @field_validator("notes", mode="before")
    @classmethod
    def _notes_list(cls, value: Any) -> Any:
        return [] if value is None else value


class DrawingUpdate(BaseModel):
    title: str | None = None
    number: str | None = None
    system_id: str | None = None
    size: str | None = None
    units: str | None = None
    discipline: str | None = None
    status: str | None = None
    frame_template: str | None = None
    fields: dict[str, Any] | None = None
    notes: list[str] | None = None

    @field_validator("title", "number")
    @classmethod
    def _text(cls, value: str | None) -> str | None:
        return clean_optional_text(value)

    @field_validator("size")
    @classmethod
    def _size(cls, value: str | None) -> str | None:
        return _clean_sheet_size(value)

    @field_validator("frame_template")
    @classmethod
    def _frame(cls, value: str | None) -> str | None:
        return _clean_frame_template(value)

    @field_validator("fields", mode="before")
    @classmethod
    def _fields_object(cls, value: Any) -> Any:
        # Explicit JSON null must not persist: DrawingRead requires an object, and
        # one null fields row makes GET /projects/{id}/drawings fail for the project.
        return {} if value is None else value

    @field_validator("notes", mode="before")
    @classmethod
    def _notes_list(cls, value: Any) -> Any:
        # Explicit JSON null must not persist: DrawingRead requires a list.
        return [] if value is None else value


class DrawingRead(OrmModel):
    id: str
    project_id: str
    system_id: str | None
    number: str
    title: str
    size: str
    units: str
    discipline: str
    status: str
    frame_template: str
    fields: dict[str, Any] = Field(default_factory=dict)
    notes: list[str] = Field(default_factory=list)
    sheets: list[DrawingSheetSummary]
    revisions: list[DrawingRevisionRead]
    created_at: datetime
    updated_at: datetime

    @field_validator("fields", mode="before")
    @classmethod
    def _fields_object(cls, value: Any) -> Any:
        return {} if value is None else value

    @field_validator("notes", mode="before")
    @classmethod
    def _notes_list(cls, value: Any) -> Any:
        return [] if value is None else value


class SheetExportIn(BaseModel):
    """Rendered SVG of one sheet (from the shared renderer) to convert on the server."""

    svg: str
    format: str = "pdf"
    dpi: int = 300
    # Extra SVG pages appended after the sheet (PDF only), e.g. the DRC findings page.
    pages: list[str] = Field(default_factory=list)

    @field_validator("svg")
    @classmethod
    def _svg(cls, value: str) -> str:
        return cls._check_svg(value)

    @field_validator("pages")
    @classmethod
    def _pages(cls, value: list[str]) -> list[str]:
        if len(value) > 10:
            raise ValueError("at most 10 extra pages")
        return [cls._check_svg(page) for page in value]

    @staticmethod
    def _check_svg(value: str) -> str:
        text = value.strip()
        if not text.startswith("<?xml") and not text.startswith("<svg"):
            raise ValueError("svg must be an SVG document")
        if len(text) > 20_000_000:
            raise ValueError("svg is too large")
        return text

    @field_validator("format")
    @classmethod
    def _format(cls, value: str) -> str:
        if value not in {"pdf", "png", "svg"}:
            raise ValueError("format must be pdf, png, or svg")
        return value

    @field_validator("dpi")
    @classmethod
    def _dpi(cls, value: int) -> int:
        if value < 50 or value > 1200:
            raise ValueError("dpi must be between 50 and 1200")
        return value


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


CONSTRAINT_KINDS = {
    "material_in",
    "material_not_in",
    "pressure_rating_min",
    "part_qualified",
    "line_class_in",
    "relief_required",
}


def clean_constraint(value: dict[str, Any] | None) -> dict[str, Any] | None:
    """Normalize a requirement constraint: kind, string values, optional scope lists."""
    if value is None:
        return None
    kind = value.get("kind")
    if kind not in CONSTRAINT_KINDS:
        raise ValueError("constraint.kind must be one of: " + ", ".join(sorted(CONSTRAINT_KINDS)))
    raw_values = value.get("values") or []
    if not isinstance(raw_values, list):
        raise ValueError("constraint.values must be a list")
    values = [str(entry).strip() for entry in raw_values if str(entry).strip()]
    if kind not in {"relief_required", "part_qualified"} and not values:
        raise ValueError(f"constraint.values must not be empty for {kind}")
    scope_in = value.get("scope") or {}
    scope: dict[str, list[str]] = {}
    for field in ("categories", "services"):
        entries = scope_in.get(field) if isinstance(scope_in, dict) else None
        if entries:
            scope[field] = [str(entry).strip() for entry in entries if str(entry).strip()]
    return {"kind": kind, "values": values, "scope": scope}


class RequirementCreate(BaseModel):
    project_id: str
    key: str
    title: str
    text: str
    requirement_type: str
    verification_method: str | None = None
    status: str = "draft"
    owner: str | None = None
    constraint: dict[str, Any] | None = None

    @field_validator("key", "title", "text", "requirement_type")
    @classmethod
    def _required_text(cls, value: str) -> str:
        return clean_required_text(value)

    @field_validator("constraint")
    @classmethod
    def _constraint(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        return clean_constraint(value)


class RequirementUpdate(BaseModel):
    key: str | None = None
    title: str | None = None
    text: str | None = None
    requirement_type: str | None = None
    verification_method: str | None = None
    status: str | None = None
    owner: str | None = None
    constraint: dict[str, Any] | None = None

    @field_validator("key", "title", "text", "requirement_type")
    @classmethod
    def _required_text(cls, value: str | None) -> str | None:
        return clean_optional_text(value)

    @field_validator("constraint")
    @classmethod
    def _constraint(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        return clean_constraint(value)


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
    diagram_id: str | None
    drawing_id: str | None = None
    source_kind: str = "diagram"
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
    # Issue code and severity ("blocking" stops release, "warning" informs).
    code: str = "part_incomplete"
    severity: str = "warning"


class BomReadinessRead(BaseModel):
    snapshot_id: str
    row_count: int
    issue_count: int
    blocking_count: int = 0
    warning_count: int = 0
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
