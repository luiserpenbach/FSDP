from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def uuid_str() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(40), nullable=False, default="engineer")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Project(TimestampMixin, Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    owner: Mapped[str | None] = mapped_column(String(160))
    part_name_prefix: Mapped[str | None] = mapped_column(String(40))
    part_name_next_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    systems: Mapped[list[FluidSystem]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    requirements: Mapped[list[Requirement]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class FluidSystem(TimestampMixin, Base):
    __tablename__ = "fluid_systems"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    fluid: Mapped[str | None] = mapped_column(String(80))
    description: Mapped[str | None] = mapped_column(Text)

    project: Mapped[Project] = relationship(back_populates="systems")
    diagrams: Mapped[list[Diagram]] = relationship(
        back_populates="system", cascade="all, delete-orphan"
    )


class Part(TimestampMixin, Base):
    __tablename__ = "parts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    part_number: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    revision: Mapped[str | None] = mapped_column(String(40))
    description: Mapped[str] = mapped_column(Text, nullable=False)
    manufacturer: Mapped[str | None] = mapped_column(String(160))
    part_type: Mapped[str] = mapped_column(String(80), nullable=False)
    source_type: Mapped[str] = mapped_column(String(40), nullable=False, default="internal")
    material: Mapped[str | None] = mapped_column(String(120))
    pressure_rating_bar: Mapped[float | None] = mapped_column(Float)
    temperature_min_c: Mapped[float | None] = mapped_column(Float)
    temperature_max_c: Mapped[float | None] = mapped_column(Float)
    cv: Mapped[float | None] = mapped_column(Float)
    mass_kg: Mapped[float | None] = mapped_column(Float)
    dimensions: Mapped[dict] = mapped_column(JSON, default=dict)
    certification_status: Mapped[str] = mapped_column(String(80), default="unreviewed")
    qualification_status: Mapped[str] = mapped_column(String(80), default="unqualified")
    lifecycle_status: Mapped[str] = mapped_column(String(40), nullable=False, default="draft")
    preferred: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    notes: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict] = mapped_column("metadata", JSON, default=dict)

    @property
    def completeness(self) -> int:
        checks = [
            bool(self.part_number),
            bool(self.description),
            bool(self.part_type),
            bool(self.material),
            self.pressure_rating_bar is not None,
            self.temperature_min_c is not None or self.temperature_max_c is not None,
            bool(self.manufacturer) or self.source_type == "custom",
        ]
        return round(100 * sum(1 for check in checks if check) / len(checks))


class Diagram(TimestampMixin, Base):
    __tablename__ = "diagrams"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    system_id: Mapped[str] = mapped_column(ForeignKey("fluid_systems.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    diagram_type: Mapped[str] = mapped_column(String(40), nullable=False, default="pid")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    graph: Mapped[dict] = mapped_column(JSON, default=dict)
    # Schematic document (mm paper space) authored by the drafting editor.
    # NULL until a diagram has been opened and saved there; the legacy React
    # Flow `graph` stays the source for the classic editor until conversion.
    schematic: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    system: Mapped[FluidSystem] = relationship(back_populates="diagrams")
    nodes: Mapped[list[DiagramNode]] = relationship(
        back_populates="diagram", cascade="all, delete-orphan"
    )
    edges: Mapped[list[DiagramEdge]] = relationship(
        back_populates="diagram", cascade="all, delete-orphan"
    )
    components: Mapped[list[ComponentInstance]] = relationship(
        back_populates="diagram", cascade="all, delete-orphan"
    )
    bom_snapshots: Mapped[list[BomSnapshot]] = relationship(
        back_populates="diagram", cascade="all, delete-orphan"
    )


class DiagramNode(TimestampMixin, Base):
    __tablename__ = "diagram_nodes"
    __table_args__ = (UniqueConstraint("diagram_id", "external_id", name="uq_node_external_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    diagram_id: Mapped[str] = mapped_column(ForeignKey("diagrams.id", ondelete="CASCADE"))
    external_id: Mapped[str] = mapped_column(String(120), nullable=False)
    node_type: Mapped[str] = mapped_column(String(80), nullable=False)
    label: Mapped[str] = mapped_column(String(160), nullable=False)
    position: Mapped[dict] = mapped_column(JSON, default=dict)
    properties: Mapped[dict] = mapped_column(JSON, default=dict)

    diagram: Mapped[Diagram] = relationship(back_populates="nodes")
    component: Mapped[ComponentInstance | None] = relationship(back_populates="node", uselist=False)


class DiagramEdge(TimestampMixin, Base):
    __tablename__ = "diagram_edges"
    __table_args__ = (UniqueConstraint("diagram_id", "external_id", name="uq_edge_external_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    diagram_id: Mapped[str] = mapped_column(ForeignKey("diagrams.id", ondelete="CASCADE"))
    external_id: Mapped[str] = mapped_column(String(120), nullable=False)
    source_node_id: Mapped[str] = mapped_column(String(120), nullable=False)
    target_node_id: Mapped[str] = mapped_column(String(120), nullable=False)
    fluid: Mapped[str | None] = mapped_column(String(80))
    pressure_bar: Mapped[float | None] = mapped_column(Float)
    temperature_c: Mapped[float | None] = mapped_column(Float)
    diameter_mm: Mapped[float | None] = mapped_column(Float)
    material: Mapped[str | None] = mapped_column(String(120))
    flow_direction: Mapped[str] = mapped_column(String(40), default="forward")
    properties: Mapped[dict] = mapped_column(JSON, default=dict)

    diagram: Mapped[Diagram] = relationship(back_populates="edges")


class ComponentInstance(TimestampMixin, Base):
    __tablename__ = "component_instances"
    __table_args__ = (
        UniqueConstraint("diagram_id", "tag", name="uq_component_tag"),
        # One component per canvas node (NULLs allowed for unbound instances).
        UniqueConstraint("node_id", name="uq_component_node"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    diagram_id: Mapped[str] = mapped_column(ForeignKey("diagrams.id", ondelete="CASCADE"))
    node_id: Mapped[str | None] = mapped_column(ForeignKey("diagram_nodes.id", ondelete="SET NULL"))
    part_id: Mapped[str | None] = mapped_column(ForeignKey("parts.id", ondelete="SET NULL"))
    tag: Mapped[str] = mapped_column(String(80), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    properties: Mapped[dict] = mapped_column(JSON, default=dict)

    diagram: Mapped[Diagram] = relationship(back_populates="components")
    node: Mapped[DiagramNode | None] = relationship(back_populates="component")
    part: Mapped[Part | None] = relationship()


class Drawing(TimestampMixin, Base):
    """Controlled drawing: a numbered, titled document made of sheets."""

    __tablename__ = "drawings"
    __table_args__ = (UniqueConstraint("project_id", "number", name="uq_drawing_number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    system_id: Mapped[str | None] = mapped_column(
        ForeignKey("fluid_systems.id", ondelete="SET NULL")
    )
    number: Mapped[str] = mapped_column(String(80), nullable=False)
    # Up to three title lines separated by newlines, as printed in the title block.
    title: Mapped[str] = mapped_column(Text, nullable=False)
    size: Mapped[str] = mapped_column(String(16), nullable=False, default="A3")
    units: Mapped[str] = mapped_column(String(16), nullable=False, default="mm")
    discipline: Mapped[str] = mapped_column(String(40), nullable=False, default="P&ID")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="working")
    frame_template: Mapped[str] = mapped_column(String(40), nullable=False, default="fsdp-standard")
    # Title-block extras (company, bldg/sys, area, scale) and general notes.
    fields: Mapped[dict] = mapped_column(JSON, default=dict)
    notes: Mapped[list] = mapped_column(JSON, default=list)

    sheets: Mapped[list[DrawingSheet]] = relationship(
        back_populates="drawing",
        cascade="all, delete-orphan",
        order_by="DrawingSheet.sheet_no",
    )
    revisions: Mapped[list[DrawingRevision]] = relationship(
        back_populates="drawing",
        cascade="all, delete-orphan",
        order_by="DrawingRevision.sequence",
    )


class DrawingSheet(TimestampMixin, Base):
    __tablename__ = "drawing_sheets"
    __table_args__ = (UniqueConstraint("drawing_id", "sheet_no", name="uq_drawing_sheet_no"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    drawing_id: Mapped[str] = mapped_column(ForeignKey("drawings.id", ondelete="CASCADE"))
    sheet_no: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    title: Mapped[str | None] = mapped_column(String(160))
    # Legacy diagram this sheet was converted from, if any.
    source_diagram_id: Mapped[str | None] = mapped_column(
        ForeignKey("diagrams.id", ondelete="SET NULL")
    )
    document: Mapped[dict] = mapped_column(JSON, default=dict)

    drawing: Mapped[Drawing] = relationship(back_populates="sheets")


class DrawingRevision(TimestampMixin, Base):
    __tablename__ = "drawing_revisions"
    __table_args__ = (UniqueConstraint("drawing_id", "sequence", name="uq_drawing_revision_seq"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    drawing_id: Mapped[str] = mapped_column(ForeignKey("drawings.id", ondelete="CASCADE"))
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    label: Mapped[str] = mapped_column(String(16), nullable=False, default="-")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="Initial issue")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="working")
    drawn_by: Mapped[str | None] = mapped_column(String(160))
    drawn_date: Mapped[str | None] = mapped_column(String(32))
    checked_by: Mapped[str | None] = mapped_column(String(160))
    checked_date: Mapped[str | None] = mapped_column(String(32))
    approved_by: Mapped[str | None] = mapped_column(String(160))
    approved_date: Mapped[str | None] = mapped_column(String(32))

    drawing: Mapped[Drawing] = relationship(back_populates="revisions")


class PidSymbolDef(TimestampMixin, Base):
    """User-defined P&ID symbol: sanitized SVG markup plus connection ports.

    Ports are stored in viewBox coordinates as
    ``[{"id": str, "x": float, "y": float, "side": str}, ...]``.
    """

    __tablename__ = "pid_symbols"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    view_box: Mapped[str] = mapped_column(String(80), nullable=False, default="0 0 64 40")
    svg: Mapped[str] = mapped_column(Text, nullable=False)
    ports: Mapped[list] = mapped_column(JSON, default=list)
    # Library metadata: palette category, legend text, default tag letters.
    category: Mapped[str | None] = mapped_column(String(40))
    legend: Mapped[str | None] = mapped_column(String(200))
    tag_prefix: Mapped[str | None] = mapped_column(String(16))


class LineClass(TimestampMixin, Base):
    """Project pipe/tube class: material, rating, wall, and the sizes it comes in."""

    __tablename__ = "line_classes"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_line_class_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    material: Mapped[str | None] = mapped_column(String(120))
    rating: Mapped[str | None] = mapped_column(String(80))
    wall: Mapped[str | None] = mapped_column(String(80))
    sizes: Mapped[list] = mapped_column(JSON, default=list)
    insulation: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)


class TagScheme(TimestampMixin, Base):
    """Per-project tag scheme (function letters, separator, id structure)."""

    __tablename__ = "tag_schemes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    scheme: Mapped[dict] = mapped_column(JSON, default=dict)


class Requirement(TimestampMixin, Base):
    __tablename__ = "requirements"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(80), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    requirement_type: Mapped[str] = mapped_column(String(80), nullable=False)
    verification_method: Mapped[str | None] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(80), default="draft")
    owner: Mapped[str | None] = mapped_column(String(160))

    project: Mapped[Project] = relationship(back_populates="requirements")


class TraceLink(TimestampMixin, Base):
    __tablename__ = "trace_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    source_type: Mapped[str] = mapped_column(String(80), nullable=False)
    source_id: Mapped[str] = mapped_column(String(36), nullable=False)
    target_type: Mapped[str] = mapped_column(String(80), nullable=False)
    target_id: Mapped[str] = mapped_column(String(36), nullable=False)
    link_type: Mapped[str] = mapped_column(String(80), nullable=False)
    rationale: Mapped[str | None] = mapped_column(Text)


class BomSnapshot(TimestampMixin, Base):
    __tablename__ = "bom_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    diagram_id: Mapped[str] = mapped_column(ForeignKey("diagrams.id", ondelete="CASCADE"))
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[str] = mapped_column(String(80), default="draft")
    rows: Mapped[list] = mapped_column(JSON, default=list)

    diagram: Mapped[Diagram] = relationship(back_populates="bom_snapshots")

    @property
    def diagram_name(self) -> str:
        return self.diagram.name if self.diagram else ""


class ChangeEvent(TimestampMixin, Base):
    __tablename__ = "change_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    object_type: Mapped[str] = mapped_column(String(80), nullable=False)
    object_id: Mapped[str] = mapped_column(String(36), nullable=False)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    actor: Mapped[str | None] = mapped_column(String(160))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


CATALOG_SETTINGS_ID = "default"

DEFAULT_PART_TYPES = [
    "valve",
    "check_valve",
    "regulator",
    "relief_valve",
    "sensor",
    "filter",
    "pump",
    "fitting",
    "hose",
    "orifice",
    "tank",
    "quick_disconnect",
    "other",
]


class CatalogSettings(TimestampMixin, Base):
    """Singleton org catalog numbering and type vocabulary."""

    __tablename__ = "catalog_settings"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: CATALOG_SETTINGS_ID
    )
    prefix: Mapped[str] = mapped_column(String(40), nullable=False, default="AMPH")
    sequence_padding: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    next_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    part_types: Mapped[list] = mapped_column(JSON, default=list)


class CatalogDocument(TimestampMixin, Base):
    __tablename__ = "catalog_documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    part_id: Mapped[str] = mapped_column(ForeignKey("parts.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(40), nullable=False, default="other")
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(
        String(120), nullable=False, default="application/octet-stream"
    )
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    storage_path: Mapped[str] = mapped_column(String(500), nullable=False)
    source_url: Mapped[str | None] = mapped_column(String(500))
    uploaded_by: Mapped[str | None] = mapped_column(String(160))

    part: Mapped[Part] = relationship()
