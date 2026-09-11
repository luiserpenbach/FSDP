"""DRC results, waivers, requirement checks, and requirement constraints.

Revision ID: 0012_drc_requirement_constraints
Revises: 0011_sheet_index_bom
Create Date: 2026-09-11
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0012_drc_requirement_constraints"
down_revision: str | None = "0011_sheet_index_bom"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    ]


def upgrade() -> None:
    op.add_column("requirements", sa.Column("constraint", sa.JSON(), nullable=True))
    op.create_table(
        "drc_results",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "sheet_id",
            sa.String(length=36),
            sa.ForeignKey("drawing_sheets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.String(length=200), nullable=False),
        sa.Column("rule", sa.String(length=60), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False, server_default="warning"),
        sa.Column("item_id", sa.String(length=80), nullable=True),
        sa.Column("subject", sa.String(length=160), nullable=True),
        sa.Column("zone", sa.String(length=16), nullable=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column(
            "requirement_id",
            sa.String(length=36),
            sa.ForeignKey("requirements.id", ondelete="SET NULL"),
            nullable=True,
        ),
        *_timestamps(),
    )
    op.create_index("ix_drc_results_sheet_id", "drc_results", ["sheet_id"])
    op.create_table(
        "drc_waivers",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "sheet_id",
            sa.String(length=36),
            sa.ForeignKey("drawing_sheets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.String(length=200), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("waived_by", sa.String(length=160), nullable=True),
        *_timestamps(),
        sa.UniqueConstraint("sheet_id", "key", name="uq_drc_waiver"),
    )
    op.create_table(
        "drc_requirement_checks",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "sheet_id",
            sa.String(length=36),
            sa.ForeignKey("drawing_sheets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "requirement_id",
            sa.String(length=36),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("item_id", sa.String(length=80), nullable=False),
        sa.Column("subject", sa.String(length=160), nullable=True),
        sa.Column("zone", sa.String(length=16), nullable=True),
        sa.Column("status", sa.String(length=8), nullable=False, server_default="pass"),
        sa.Column("message", sa.Text(), nullable=False, server_default=""),
        *_timestamps(),
    )
    op.create_index(
        "ix_drc_requirement_checks_requirement_id", "drc_requirement_checks", ["requirement_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_drc_requirement_checks_requirement_id", table_name="drc_requirement_checks")
    op.drop_table("drc_requirement_checks")
    op.drop_table("drc_waivers")
    op.drop_index("ix_drc_results_sheet_id", table_name="drc_results")
    op.drop_table("drc_results")
    op.drop_column("requirements", "constraint")
