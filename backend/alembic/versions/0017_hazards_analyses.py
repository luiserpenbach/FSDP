"""Hazards (safety register) and stored analyses.

Revision ID: 0017_hazards_analyses
Revises: 0016_drawing_lineage
Create Date: 2026-11-17
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0017_hazards_analyses"
down_revision: str | None = "0016_drawing_lineage"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "hazards",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.String(length=80), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("category", sa.String(length=40), nullable=False, server_default="other"),
        sa.Column("severity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("likelihood", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("mitigation", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=40), nullable=False, server_default="open"),
        sa.Column("owner", sa.String(length=160), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("project_id", "key", name="uq_hazards_project_key"),
    )
    op.create_index("ix_hazards_project_id", "hazards", ["project_id"])
    op.create_table(
        "analyses",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "drawing_id",
            sa.String(length=36),
            sa.ForeignKey("drawings.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("inputs", sa.JSON(), nullable=False),
        sa.Column("results", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False, server_default="draft"),
        sa.Column("created_by", sa.String(length=160), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_analyses_project_id", "analyses", ["project_id"])
    op.create_index("ix_analyses_drawing_id", "analyses", ["drawing_id"])


def downgrade() -> None:
    # Hazard trace links have no foreign key; remove them with the table they point to.
    op.execute("DELETE FROM trace_links WHERE source_type = 'hazard' OR target_type = 'hazard'")
    op.drop_index("ix_analyses_drawing_id", table_name="analyses")
    op.drop_index("ix_analyses_project_id", table_name="analyses")
    op.drop_table("analyses")
    op.drop_index("ix_hazards_project_id", table_name="hazards")
    op.drop_table("hazards")
