"""Safety phase D: stored safety review packages.

Revision ID: 0016_safety_packages
Revises: 0015_safety_analyses
Create Date: 2026-09-12
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0016_safety_packages"
down_revision: str | None = "0015_safety_analyses"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    ]


def upgrade() -> None:
    op.create_table(
        "safety_packages",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("scope", sa.JSON(), nullable=True),
        sa.Column("summary", sa.JSON(), nullable=True),
        sa.Column("generated_by", sa.String(length=160), nullable=True),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("change_log_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pdf_path", sa.String(length=400), nullable=True),
        sa.Column("xlsx_path", sa.String(length=400), nullable=True),
        *_timestamps(),
    )
    op.create_index("ix_safety_packages_project", "safety_packages", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_safety_packages_project", table_name="safety_packages")
    op.drop_table("safety_packages")
