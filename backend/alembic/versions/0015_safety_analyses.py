"""Safety phase C: sheet volumes, sheet document hash, analyses, and the
hazard link on relief-coverage findings.

Revision ID: 0015_safety_analyses
Revises: 0014_fmea
Create Date: 2026-09-12
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0015_safety_analyses"
down_revision: str | None = "0014_fmea"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    ]


def upgrade() -> None:
    with op.batch_alter_table("drawing_sheets") as batch:
        batch.add_column(sa.Column("document_hash", sa.String(length=64), nullable=True))
    with op.batch_alter_table("hazards") as batch:
        batch.add_column(sa.Column("volume_keys", sa.JSON(), nullable=True))
    with op.batch_alter_table("drc_results") as batch:
        batch.add_column(sa.Column("hazard_id", sa.String(length=36), nullable=True))
        batch.create_foreign_key(
            "fk_drc_results_hazard", "hazards", ["hazard_id"], ["id"], ondelete="SET NULL"
        )
    op.create_table(
        "sheet_volumes",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "sheet_id",
            sa.String(length=36),
            sa.ForeignKey("drawing_sheets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.String(length=80), nullable=False),
        sa.Column("isolable", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("relieved", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("service", sa.String(length=80), nullable=True),
        sa.Column("design_pressure", sa.String(length=80), nullable=True),
        sa.Column("design_temperature", sa.String(length=80), nullable=True),
        sa.Column("length_m", sa.Float(), nullable=False, server_default="0"),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.UniqueConstraint("sheet_id", "key", name="uq_sheet_volume"),
    )
    op.create_index("ix_sheet_volumes_sheet_id", "sheet_volumes", ["sheet_id"])
    op.create_table(
        "analyses",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=30), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column(
            "sheet_id",
            sa.String(length=36),
            sa.ForeignKey("drawing_sheets.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("scope", sa.JSON(), nullable=True),
        sa.Column("assumptions", sa.JSON(), nullable=True),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("verdict", sa.String(length=10), nullable=True),
        sa.Column("sheet_hash", sa.String(length=64), nullable=True),
        sa.Column("outdated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("run_by", sa.String(length=160), nullable=True),
        sa.Column("run_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
    )
    op.create_index("ix_analyses_project_id", "analyses", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_analyses_project_id", table_name="analyses")
    op.drop_table("analyses")
    op.drop_index("ix_sheet_volumes_sheet_id", table_name="sheet_volumes")
    op.drop_table("sheet_volumes")
    with op.batch_alter_table("drc_results") as batch:
        batch.drop_constraint("fk_drc_results_hazard", type_="foreignkey")
        batch.drop_column("hazard_id")
    with op.batch_alter_table("hazards") as batch:
        batch.drop_column("volume_keys")
    with op.batch_alter_table("drawing_sheets") as batch:
        batch.drop_column("document_hash")
