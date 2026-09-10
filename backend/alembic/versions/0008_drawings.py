"""Drawings, sheets, and revisions for the drafting editor.

Revision ID: 0008_drawings
Revises: 0007_diagram_schematic
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0008_drawings"
down_revision: str | None = "0007_diagram_schematic"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "drawings",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "system_id",
            sa.String(length=36),
            sa.ForeignKey("fluid_systems.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("number", sa.String(length=80), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("size", sa.String(length=16), nullable=False, server_default="A3"),
        sa.Column("units", sa.String(length=16), nullable=False, server_default="mm"),
        sa.Column("discipline", sa.String(length=40), nullable=False, server_default="P&ID"),
        sa.Column("status", sa.String(length=40), nullable=False, server_default="working"),
        sa.Column(
            "frame_template",
            sa.String(length=40),
            nullable=False,
            server_default="fsdp-standard",
        ),
        sa.Column("fields", sa.JSON(), nullable=True),
        sa.Column("notes", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("project_id", "number", name="uq_drawing_number"),
    )
    op.create_table(
        "drawing_sheets",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "drawing_id",
            sa.String(length=36),
            sa.ForeignKey("drawings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sheet_no", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("title", sa.String(length=160), nullable=True),
        sa.Column(
            "source_diagram_id",
            sa.String(length=36),
            sa.ForeignKey("diagrams.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("document", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("drawing_id", "sheet_no", name="uq_drawing_sheet_no"),
    )
    op.create_table(
        "drawing_revisions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "drawing_id",
            sa.String(length=36),
            sa.ForeignKey("drawings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sequence", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("label", sa.String(length=16), nullable=False, server_default="-"),
        sa.Column("description", sa.Text(), nullable=False, server_default="Initial issue"),
        sa.Column("status", sa.String(length=40), nullable=False, server_default="working"),
        sa.Column("drawn_by", sa.String(length=160), nullable=True),
        sa.Column("drawn_date", sa.String(length=32), nullable=True),
        sa.Column("checked_by", sa.String(length=160), nullable=True),
        sa.Column("checked_date", sa.String(length=32), nullable=True),
        sa.Column("approved_by", sa.String(length=160), nullable=True),
        sa.Column("approved_date", sa.String(length=32), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("drawing_id", "sequence", name="uq_drawing_revision_seq"),
    )


def downgrade() -> None:
    op.drop_table("drawing_revisions")
    op.drop_table("drawing_sheets")
    op.drop_table("drawings")
