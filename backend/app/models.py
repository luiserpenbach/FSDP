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
    # SHA-256 of the saved document; analyses remember the hash they ran against.
    document_hash: Mapped[str | None] = mapped_column(String(64))

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


class SheetItem(TimestampMixin, Base):
    """Normalized index row for one symbol or equipment item on a sheet.

    Rebuilt from the sheet document on every save (the document stays the
    source of truth); lists, BoM roll-ups, and where-used queries read this.
    """

    __tablename__ = "sheet_items"
    __table_args__ = (UniqueConstraint("sheet_id", "item_id", name="uq_sheet_item"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    sheet_id: Mapped[str] = mapped_column(
        ForeignKey("drawing_sheets.id", ondelete="CASCADE"), nullable=False
    )
    item_id: Mapped[str] = mapped_column(String(80), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    category: Mapped[str | None] = mapped_column(String(40))
    symbol_key: Mapped[str | None] = mapped_column(String(120))
    symbol_name: Mapped[str | None] = mapped_column(String(160))
    tag: Mapped[str | None] = mapped_column(String(80))
    label: Mapped[str | None] = mapped_column(String(200))
    zone: Mapped[str | None] = mapped_column(String(16))
    x: Mapped[float | None] = mapped_column(Float)
    y: Mapped[float | None] = mapped_column(Float)
    part_id: Mapped[str | None] = mapped_column(ForeignKey("parts.id", ondelete="SET NULL"))
    dnp: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    spare: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Connected line sizes / services, connector reference, and the item's fields.
    fields: Mapped[dict] = mapped_column(JSON, default=dict)

    sheet: Mapped[DrawingSheet] = relationship()
    part: Mapped[Part | None] = relationship()


class SheetLine(TimestampMixin, Base):
    """Normalized index row for one line on a sheet (see SheetItem)."""

    __tablename__ = "sheet_lines"
    __table_args__ = (UniqueConstraint("sheet_id", "line_id", name="uq_sheet_line"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    sheet_id: Mapped[str] = mapped_column(
        ForeignKey("drawing_sheets.id", ondelete="CASCADE"), nullable=False
    )
    line_id: Mapped[str] = mapped_column(String(80), nullable=False)
    line_number: Mapped[str | None] = mapped_column(String(80))
    line_type: Mapped[str] = mapped_column(String(40), nullable=False, default="process")
    service: Mapped[str | None] = mapped_column(String(80))
    size: Mapped[str | None] = mapped_column(String(40))
    spec: Mapped[str | None] = mapped_column(String(160))
    line_class: Mapped[str | None] = mapped_column(String(80))
    from_item: Mapped[str | None] = mapped_column(String(80))
    from_tag: Mapped[str | None] = mapped_column(String(160))
    to_item: Mapped[str | None] = mapped_column(String(80))
    to_tag: Mapped[str | None] = mapped_column(String(160))
    zone: Mapped[str | None] = mapped_column(String(16))
    # Drawn length on the sheet and the estimated physical length.
    length_mm: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    length_m: Mapped[float | None] = mapped_column(Float)
    # Line ends on ports (fittings) and tees found along the line.
    connection_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tee_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    design_pressure: Mapped[str | None] = mapped_column(String(80))
    design_temperature: Mapped[str | None] = mapped_column(String(80))
    operating_pressure: Mapped[str | None] = mapped_column(String(80))
    operating_temperature: Mapped[str | None] = mapped_column(String(80))
    insulation: Mapped[str | None] = mapped_column(String(120))
    tracing: Mapped[str | None] = mapped_column(String(120))
    fields: Mapped[dict] = mapped_column(JSON, default=dict)

    sheet: Mapped[DrawingSheet] = relationship()


class DrcResult(TimestampMixin, Base):
    """One open DRC finding on a sheet, replaced on every save from the engine's run."""

    __tablename__ = "drc_results"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    sheet_id: Mapped[str] = mapped_column(
        ForeignKey("drawing_sheets.id", ondelete="CASCADE"), nullable=False
    )
    key: Mapped[str] = mapped_column(String(200), nullable=False)
    rule: Mapped[str] = mapped_column(String(60), nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, default="warning")
    item_id: Mapped[str | None] = mapped_column(String(80))
    subject: Mapped[str | None] = mapped_column(String(160))
    zone: Mapped[str | None] = mapped_column(String(16))
    message: Mapped[str] = mapped_column(Text, nullable=False)
    requirement_id: Mapped[str | None] = mapped_column(
        ForeignKey("requirements.id", ondelete="SET NULL")
    )
    # Hazard created from a relief-coverage finding (auto-hazard setting).
    hazard_id: Mapped[str | None] = mapped_column(
        ForeignKey("hazards.id", ondelete="SET NULL"), nullable=True
    )


class SheetVolume(TimestampMixin, Base):
    """Isolable volume on a sheet, derived by the engine and stored with the index."""

    __tablename__ = "sheet_volumes"
    __table_args__ = (UniqueConstraint("sheet_id", "key", name="uq_sheet_volume"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    sheet_id: Mapped[str] = mapped_column(
        ForeignKey("drawing_sheets.id", ondelete="CASCADE"), nullable=False
    )
    key: Mapped[str] = mapped_column(String(80), nullable=False)
    isolable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    relieved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    service: Mapped[str | None] = mapped_column(String(80))
    design_pressure: Mapped[str | None] = mapped_column(String(80))
    design_temperature: Mapped[str | None] = mapped_column(String(80))
    length_m: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    # line_ids, item_ids, relief_item_ids, isolating_item_ids, line_numbers
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class Analysis(TimestampMixin, Base):
    """A safety analysis run against a sheet: inputs derived from the index,
    assumptions, result, verdict, and the sheet hash it was computed for."""

    __tablename__ = "analyses"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    # trapped_volume | relief_scenario | single_point_failure | fault_tolerance | manual
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    sheet_id: Mapped[str | None] = mapped_column(
        ForeignKey("drawing_sheets.id", ondelete="SET NULL"), nullable=True
    )
    scope: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    assumptions: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # pass | fail | no_data | info
    verdict: Mapped[str | None] = mapped_column(String(10))
    sheet_hash: Mapped[str | None] = mapped_column(String(64))
    outdated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    run_by: Mapped[str | None] = mapped_column(String(160))
    run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DrcWaiver(TimestampMixin, Base):
    """A waived finding: survives re-runs because it is keyed by the finding key."""

    __tablename__ = "drc_waivers"
    __table_args__ = (UniqueConstraint("sheet_id", "key", name="uq_drc_waiver"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    sheet_id: Mapped[str] = mapped_column(
        ForeignKey("drawing_sheets.id", ondelete="CASCADE"), nullable=False
    )
    key: Mapped[str] = mapped_column(String(200), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    waived_by: Mapped[str | None] = mapped_column(String(160))


class DrcRequirementCheck(TimestampMixin, Base):
    """Pass/fail of one requirement constraint on one item (verification matrix rows)."""

    __tablename__ = "drc_requirement_checks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    sheet_id: Mapped[str] = mapped_column(
        ForeignKey("drawing_sheets.id", ondelete="CASCADE"), nullable=False
    )
    requirement_id: Mapped[str] = mapped_column(
        ForeignKey("requirements.id", ondelete="CASCADE"), nullable=False
    )
    item_id: Mapped[str] = mapped_column(String(80), nullable=False)
    subject: Mapped[str | None] = mapped_column(String(160))
    zone: Mapped[str | None] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="pass")
    message: Mapped[str] = mapped_column(Text, nullable=False, default="")


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
    # Machine-checkable constraint evaluated by the drawing DRC:
    # {"kind": "material_in", "values": ["316L"], "scope": {"services": ["GHe"]}}
    constraint: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Derivation: a system requirement points at the customer or site requirement it derives from.
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("requirements.id", ondelete="SET NULL"), nullable=True
    )
    rationale: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(40), nullable=False, default="functional")
    # Set when the requirement controls a severity I or II hazard.
    safety_critical: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # {"systems": [...], "operating_modes": [...], "services": [...]}
    applicability: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Rolled up from evidence, never edited directly:
    # planned | in_progress | verified | failed | waived
    verification_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="planned"
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    source_ref: Mapped[str | None] = mapped_column(String(200))

    project: Mapped[Project] = relationship(back_populates="requirements")
    parent: Mapped[Requirement | None] = relationship(
        remote_side="Requirement.id", foreign_keys=[parent_id]
    )
    evidence: Mapped[list[RequirementEvidence]] = relationship(
        back_populates="requirement", cascade="all, delete-orphan"
    )
    history: Mapped[list[RequirementHistory]] = relationship(
        back_populates="requirement", cascade="all, delete-orphan"
    )


class RequirementHistory(TimestampMixin, Base):
    """One changed field of a requirement, written on every update."""

    __tablename__ = "requirement_history"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    requirement_id: Mapped[str] = mapped_column(
        ForeignKey("requirements.id", ondelete="CASCADE"), nullable=False
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    field: Mapped[str] = mapped_column(String(40), nullable=False)
    old_value: Mapped[str | None] = mapped_column(Text)
    new_value: Mapped[str | None] = mapped_column(Text)
    actor: Mapped[str | None] = mapped_column(String(160))

    requirement: Mapped[Requirement] = relationship(back_populates="history")


class RequirementEvidence(TimestampMixin, Base):
    """One piece of proof attached to a requirement.

    ``drc`` rows are mirrored from the sheet's requirement checks on every
    save (ref_type ``sheet``); the other kinds are recorded by people.
    """

    __tablename__ = "requirement_evidence"
    __table_args__ = (
        UniqueConstraint(
            "requirement_id", "kind", "ref_type", "ref_id", name="uq_requirement_evidence_ref"
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    requirement_id: Mapped[str] = mapped_column(
        ForeignKey("requirements.id", ondelete="CASCADE"), nullable=False
    )
    # drc | analysis | document | test | inspection | waiver
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    ref_type: Mapped[str | None] = mapped_column(String(40))
    ref_id: Mapped[str | None] = mapped_column(String(200))
    # pass | fail | pending
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="pending")
    note: Mapped[str | None] = mapped_column(Text)
    recorded_by: Mapped[str | None] = mapped_column(String(160))

    requirement: Mapped[Requirement] = relationship(back_populates="evidence")


class Hazard(TimestampMixin, Base):
    """Project hazard log entry. ``status`` is the human state (open, accepted,
    closed); whether the hazard is controlled is computed from its controls."""

    __tablename__ = "hazards"
    __table_args__ = (UniqueConstraint("project_id", "key", name="uq_hazard_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    key: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    category: Mapped[str] = mapped_column(String(40), nullable=False, default="other")
    system_id: Mapped[str | None] = mapped_column(
        ForeignKey("fluid_systems.id", ondelete="SET NULL"), nullable=True
    )
    operating_modes: Mapped[list | None] = mapped_column(JSON, nullable=True)
    severity_initial: Mapped[str | None] = mapped_column(String(4))
    likelihood_initial: Mapped[str | None] = mapped_column(String(4))
    severity_residual: Mapped[str | None] = mapped_column(String(4))
    likelihood_residual: Mapped[str | None] = mapped_column(String(4))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open")
    owner: Mapped[str | None] = mapped_column(String(160))
    accepted_by: Mapped[str | None] = mapped_column(String(160))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acceptance_justification: Mapped[str | None] = mapped_column(Text)
    fault_tolerance_required: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # Isolable volume keys (from sheet_volumes) this hazard is scoped to.
    volume_keys: Mapped[list | None] = mapped_column(JSON, nullable=True)

    project: Mapped[Project] = relationship()
    system: Mapped[FluidSystem | None] = relationship()


class FailureMode(TimestampMixin, Base):
    """Organisation-wide failure-mode library entry for a symbol category or key."""

    __tablename__ = "failure_modes"
    __table_args__ = (UniqueConstraint("category", "symbol_key", "name", name="uq_failure_mode"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    symbol_key: Mapped[str | None] = mapped_column(String(120))
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    # Template with {tag}, {name}, {service} placeholders.
    default_local_effect: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Instrument tag letters that typically detect this mode, e.g. ["PT", "PDT"].
    default_detection_hint: Mapped[list | None] = mapped_column(JSON, nullable=True)
    default_severity: Mapped[int | None] = mapped_column(Integer)
    # None = every operating mode.
    applicable_modes: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Symbol-level entries add to the category's unless this is set.
    replaces_category: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class FmeaWorksheet(TimestampMixin, Base):
    __tablename__ = "fmea_worksheets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    system_id: Mapped[str | None] = mapped_column(
        ForeignKey("fluid_systems.id", ondelete="SET NULL"), nullable=True
    )
    drawing_id: Mapped[str | None] = mapped_column(
        ForeignKey("drawings.id", ondelete="SET NULL"), nullable=True
    )
    # Drawing revision the rows were generated against / released at.
    drawing_revision_label: Mapped[str | None] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False, default="fmea")
    operating_modes: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # draft | in_review | released | superseded
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    rows: Mapped[list[FmeaRow]] = relationship(
        back_populates="worksheet", cascade="all, delete-orphan", order_by="FmeaRow.position"
    )
    releases: Mapped[list[FmeaRelease]] = relationship(
        back_populates="worksheet", cascade="all, delete-orphan", order_by="FmeaRelease.revision"
    )


class FmeaRow(TimestampMixin, Base):
    """One failure mode of one drawing item. The item is referenced by
    ``(sheet_id, item_id)``; ``*_seen`` columns remember what the item looked like
    when the row was last confirmed so a save can mark the row stale."""

    __tablename__ = "fmea_rows"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    worksheet_id: Mapped[str] = mapped_column(
        ForeignKey("fmea_worksheets.id", ondelete="CASCADE"), nullable=False
    )
    sheet_id: Mapped[str | None] = mapped_column(
        ForeignKey("drawing_sheets.id", ondelete="SET NULL"), nullable=True
    )
    item_id: Mapped[str | None] = mapped_column(String(80))
    # Rows about things not on a drawing (procedures, operators).
    subject_text: Mapped[str | None] = mapped_column(String(200))
    item_tag_seen: Mapped[str | None] = mapped_column(String(80))
    part_id_seen: Mapped[str | None] = mapped_column(String(36))
    volume_key_seen: Mapped[str | None] = mapped_column(String(80))
    failure_mode_id: Mapped[str | None] = mapped_column(
        ForeignKey("failure_modes.id", ondelete="SET NULL"), nullable=True
    )
    failure_mode_text: Mapped[str | None] = mapped_column(String(160))
    operating_modes: Mapped[list | None] = mapped_column(JSON, nullable=True)
    cause: Mapped[str] = mapped_column(Text, nullable=False, default="")
    local_effect: Mapped[str] = mapped_column(Text, nullable=False, default="")
    next_effect: Mapped[str] = mapped_column(Text, nullable=False, default="")
    end_effect: Mapped[str] = mapped_column(Text, nullable=False, default="")
    detected_by_item_id: Mapped[str | None] = mapped_column(String(80))
    # instrument | procedure | inspection | none
    detection_kind: Mapped[str] = mapped_column(String(20), nullable=False, default="none")
    detection_reason: Mapped[str | None] = mapped_column(Text)
    severity: Mapped[int | None] = mapped_column(Integer)
    occurrence: Mapped[int | None] = mapped_column(Integer)
    detection: Mapped[int | None] = mapped_column(Integer)
    rpn: Mapped[int | None] = mapped_column(Integer)
    hazard_id: Mapped[str | None] = mapped_column(
        ForeignKey("hazards.id", ondelete="SET NULL"), nullable=True
    )
    recommended_action: Mapped[str | None] = mapped_column(Text)
    action_owner: Mapped[str | None] = mapped_column(String(160))
    action_due: Mapped[str | None] = mapped_column(String(32))
    # not_required | open | in_progress | done
    action_status: Mapped[str] = mapped_column(String(20), nullable=False, default="not_required")
    severity_residual: Mapped[int | None] = mapped_column(Integer)
    occurrence_residual: Mapped[int | None] = mapped_column(Integer)
    detection_residual: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)
    not_applicable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # retagged | part_changed | moved_volume | deleted | drawing_revised
    stale_reason: Mapped[str | None] = mapped_column(String(40))
    stale_detail: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    worksheet: Mapped[FmeaWorksheet] = relationship(back_populates="rows")
    failure_mode: Mapped[FailureMode | None] = relationship()
    comments: Mapped[list[FmeaRowComment]] = relationship(
        back_populates="row", cascade="all, delete-orphan", order_by="FmeaRowComment.created_at"
    )


class FmeaRelease(TimestampMixin, Base):
    """Frozen rows of a worksheet at a release, pinned to a drawing revision."""

    __tablename__ = "fmea_releases"
    __table_args__ = (UniqueConstraint("worksheet_id", "revision", name="uq_fmea_release"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    worksheet_id: Mapped[str] = mapped_column(
        ForeignKey("fmea_worksheets.id", ondelete="CASCADE"), nullable=False
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    drawing_revision_label: Mapped[str | None] = mapped_column(String(16))
    rows: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    released_by: Mapped[str | None] = mapped_column(String(160))
    note: Mapped[str | None] = mapped_column(Text)

    worksheet: Mapped[FmeaWorksheet] = relationship(back_populates="releases")


class FmeaRowComment(TimestampMixin, Base):
    __tablename__ = "fmea_row_comments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    row_id: Mapped[str] = mapped_column(
        ForeignKey("fmea_rows.id", ondelete="CASCADE"), nullable=False
    )
    author: Mapped[str | None] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    resolved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    row: Mapped[FmeaRow] = relationship(back_populates="comments")


class SafetySettings(TimestampMixin, Base):
    """Per-project safety settings (scales, risk matrix, policy, modes)."""

    __tablename__ = "safety_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    settings: Mapped[dict] = mapped_column(JSON, default=dict)


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
    # A snapshot belongs to either a legacy diagram or a controlled drawing.
    diagram_id: Mapped[str | None] = mapped_column(
        ForeignKey("diagrams.id", ondelete="CASCADE"), nullable=True
    )
    drawing_id: Mapped[str | None] = mapped_column(
        ForeignKey("drawings.id", ondelete="CASCADE"), nullable=True
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[str] = mapped_column(String(80), default="draft")
    rows: Mapped[list] = mapped_column(JSON, default=list)

    diagram: Mapped[Diagram | None] = relationship(back_populates="bom_snapshots")
    drawing: Mapped[Drawing | None] = relationship()

    @property
    def diagram_name(self) -> str:
        if self.diagram:
            return self.diagram.name
        if self.drawing:
            return self.drawing.number
        return ""

    @property
    def source_kind(self) -> str:
        return "drawing" if self.drawing_id else "diagram"


class SafetyPackage(TimestampMixin, Base):
    """A generated safety review package: the scope it covered, summary counts,
    and where its PDF and XLSX files live."""

    __tablename__ = "safety_packages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    scope: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    generated_by: Mapped[str | None] = mapped_column(String(160))
    generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    change_log_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pdf_path: Mapped[str | None] = mapped_column(String(400))
    xlsx_path: Mapped[str | None] = mapped_column(String(400))


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
