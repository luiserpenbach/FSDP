"""Initial MVP schema.

Revision ID: 0001_initial_mvp_schema
Revises:
Create Date: 2026-06-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0001_initial_mvp_schema"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def timestamp_columns() -> list[sa.Column]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("owner", sa.String(length=160)),
        *timestamp_columns(),
    )
    op.create_table(
        "parts",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("part_number", sa.String(length=120), nullable=False, unique=True),
        sa.Column("revision", sa.String(length=40)),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("manufacturer", sa.String(length=160)),
        sa.Column("part_type", sa.String(length=80), nullable=False),
        sa.Column("source_type", sa.String(length=40), nullable=False),
        sa.Column("material", sa.String(length=120)),
        sa.Column("pressure_rating_bar", sa.Float()),
        sa.Column("temperature_min_c", sa.Float()),
        sa.Column("temperature_max_c", sa.Float()),
        sa.Column("cv", sa.Float()),
        sa.Column("mass_kg", sa.Float()),
        sa.Column("dimensions", postgresql.JSONB(), nullable=False),
        sa.Column("certification_status", sa.String(length=80), nullable=False),
        sa.Column("qualification_status", sa.String(length=80), nullable=False),
        sa.Column("metadata", postgresql.JSONB(), nullable=False),
        *timestamp_columns(),
    )
    op.create_table(
        "fluid_systems",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id", sa.String(length=36), sa.ForeignKey("projects.id", ondelete="CASCADE")
        ),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("fluid", sa.String(length=80)),
        sa.Column("description", sa.Text()),
        *timestamp_columns(),
    )
    op.create_table(
        "requirements",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id", sa.String(length=36), sa.ForeignKey("projects.id", ondelete="CASCADE")
        ),
        sa.Column("key", sa.String(length=80), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("requirement_type", sa.String(length=80), nullable=False),
        sa.Column("verification_method", sa.String(length=80)),
        sa.Column("status", sa.String(length=80), nullable=False),
        sa.Column("owner", sa.String(length=160)),
        *timestamp_columns(),
    )
    op.create_table(
        "diagrams",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "system_id", sa.String(length=36), sa.ForeignKey("fluid_systems.id", ondelete="CASCADE")
        ),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("diagram_type", sa.String(length=40), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("graph", postgresql.JSONB(), nullable=False),
        *timestamp_columns(),
    )
    op.create_table(
        "trace_links",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("source_type", sa.String(length=80), nullable=False),
        sa.Column("source_id", sa.String(length=36), nullable=False),
        sa.Column("target_type", sa.String(length=80), nullable=False),
        sa.Column("target_id", sa.String(length=36), nullable=False),
        sa.Column("link_type", sa.String(length=80), nullable=False),
        sa.Column("rationale", sa.Text()),
        *timestamp_columns(),
    )
    op.create_table(
        "change_events",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("object_type", sa.String(length=80), nullable=False),
        sa.Column("object_id", sa.String(length=36), nullable=False),
        sa.Column("action", sa.String(length=80), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("actor", sa.String(length=160)),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        *timestamp_columns(),
    )
    op.create_table(
        "diagram_nodes",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "diagram_id", sa.String(length=36), sa.ForeignKey("diagrams.id", ondelete="CASCADE")
        ),
        sa.Column("external_id", sa.String(length=120), nullable=False),
        sa.Column("node_type", sa.String(length=80), nullable=False),
        sa.Column("label", sa.String(length=160), nullable=False),
        sa.Column("position", postgresql.JSONB(), nullable=False),
        sa.Column("properties", postgresql.JSONB(), nullable=False),
        *timestamp_columns(),
        sa.UniqueConstraint("diagram_id", "external_id", name="uq_node_external_id"),
    )
    op.create_table(
        "diagram_edges",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "diagram_id", sa.String(length=36), sa.ForeignKey("diagrams.id", ondelete="CASCADE")
        ),
        sa.Column("external_id", sa.String(length=120), nullable=False),
        sa.Column("source_node_id", sa.String(length=120), nullable=False),
        sa.Column("target_node_id", sa.String(length=120), nullable=False),
        sa.Column("fluid", sa.String(length=80)),
        sa.Column("pressure_bar", sa.Float()),
        sa.Column("temperature_c", sa.Float()),
        sa.Column("diameter_mm", sa.Float()),
        sa.Column("material", sa.String(length=120)),
        sa.Column("flow_direction", sa.String(length=40), nullable=False),
        sa.Column("properties", postgresql.JSONB(), nullable=False),
        *timestamp_columns(),
        sa.UniqueConstraint("diagram_id", "external_id", name="uq_edge_external_id"),
    )
    op.create_table(
        "component_instances",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "diagram_id", sa.String(length=36), sa.ForeignKey("diagrams.id", ondelete="CASCADE")
        ),
        sa.Column(
            "node_id", sa.String(length=36), sa.ForeignKey("diagram_nodes.id", ondelete="SET NULL")
        ),
        sa.Column("part_id", sa.String(length=36), sa.ForeignKey("parts.id", ondelete="SET NULL")),
        sa.Column("tag", sa.String(length=80), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("properties", postgresql.JSONB(), nullable=False),
        *timestamp_columns(),
    )
    op.create_table(
        "bom_snapshots",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "diagram_id", sa.String(length=36), sa.ForeignKey("diagrams.id", ondelete="CASCADE")
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=80), nullable=False),
        sa.Column("rows", postgresql.JSONB(), nullable=False),
        *timestamp_columns(),
    )


def downgrade() -> None:
    op.drop_table("bom_snapshots")
    op.drop_table("component_instances")
    op.drop_table("diagram_edges")
    op.drop_table("diagram_nodes")
    op.drop_table("change_events")
    op.drop_table("trace_links")
    op.drop_table("diagrams")
    op.drop_table("requirements")
    op.drop_table("fluid_systems")
    op.drop_table("parts")
    op.drop_table("projects")
