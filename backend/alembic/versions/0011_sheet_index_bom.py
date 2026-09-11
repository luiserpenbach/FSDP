"""Sheet index tables and drawing-level BoM snapshots.

Revision ID: 0011_sheet_index_bom
Revises: 0010_line_classes
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0011_sheet_index_bom"
down_revision: str | None = "0010_line_classes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sheet_items",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "sheet_id",
            sa.String(length=36),
            sa.ForeignKey("drawing_sheets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("item_id", sa.String(length=80), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("category", sa.String(length=40), nullable=True),
        sa.Column("symbol_key", sa.String(length=120), nullable=True),
        sa.Column("symbol_name", sa.String(length=160), nullable=True),
        sa.Column("tag", sa.String(length=80), nullable=True),
        sa.Column("label", sa.String(length=200), nullable=True),
        sa.Column("zone", sa.String(length=16), nullable=True),
        sa.Column("x", sa.Float(), nullable=True),
        sa.Column("y", sa.Float(), nullable=True),
        sa.Column(
            "part_id",
            sa.String(length=36),
            sa.ForeignKey("parts.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("dnp", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("spare", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("fields", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("sheet_id", "item_id", name="uq_sheet_item"),
    )
    op.create_index("ix_sheet_items_tag", "sheet_items", ["tag"])
    op.create_index("ix_sheet_items_part_id", "sheet_items", ["part_id"])
    op.create_table(
        "sheet_lines",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "sheet_id",
            sa.String(length=36),
            sa.ForeignKey("drawing_sheets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("line_id", sa.String(length=80), nullable=False),
        sa.Column("line_number", sa.String(length=80), nullable=True),
        sa.Column("line_type", sa.String(length=40), nullable=False, server_default="process"),
        sa.Column("service", sa.String(length=80), nullable=True),
        sa.Column("size", sa.String(length=40), nullable=True),
        sa.Column("spec", sa.String(length=160), nullable=True),
        sa.Column("line_class", sa.String(length=80), nullable=True),
        sa.Column("from_item", sa.String(length=80), nullable=True),
        sa.Column("from_tag", sa.String(length=160), nullable=True),
        sa.Column("to_item", sa.String(length=80), nullable=True),
        sa.Column("to_tag", sa.String(length=160), nullable=True),
        sa.Column("zone", sa.String(length=16), nullable=True),
        sa.Column("length_mm", sa.Float(), nullable=False, server_default="0"),
        sa.Column("length_m", sa.Float(), nullable=True),
        sa.Column("connection_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tee_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("design_pressure", sa.String(length=80), nullable=True),
        sa.Column("design_temperature", sa.String(length=80), nullable=True),
        sa.Column("operating_pressure", sa.String(length=80), nullable=True),
        sa.Column("operating_temperature", sa.String(length=80), nullable=True),
        sa.Column("insulation", sa.String(length=120), nullable=True),
        sa.Column("tracing", sa.String(length=120), nullable=True),
        sa.Column("fields", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("sheet_id", "line_id", name="uq_sheet_line"),
    )
    op.create_index("ix_sheet_lines_line_number", "sheet_lines", ["line_number"])
    with op.batch_alter_table("bom_snapshots") as batch:
        batch.alter_column("diagram_id", existing_type=sa.String(length=36), nullable=True)
        batch.add_column(
            sa.Column(
                "drawing_id",
                sa.String(length=36),
                sa.ForeignKey("drawings.id", ondelete="CASCADE"),
                nullable=True,
            )
        )


def downgrade() -> None:
    op.execute("DELETE FROM bom_snapshots WHERE diagram_id IS NULL")
    with op.batch_alter_table("bom_snapshots") as batch:
        batch.drop_column("drawing_id")
        batch.alter_column("diagram_id", existing_type=sa.String(length=36), nullable=False)
    op.drop_index("ix_sheet_lines_line_number", table_name="sheet_lines")
    op.drop_table("sheet_lines")
    op.drop_index("ix_sheet_items_part_id", table_name="sheet_items")
    op.drop_index("ix_sheet_items_tag", table_name="sheet_items")
    op.drop_table("sheet_items")
