"""Project line classes (pipe/tube specs).

Revision ID: 0010_line_classes
Revises: 0009_tag_schemes_symbol_meta
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0010_line_classes"
down_revision: str | None = "0009_tag_schemes_symbol_meta"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "line_classes",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("material", sa.String(length=120), nullable=True),
        sa.Column("rating", sa.String(length=80), nullable=True),
        sa.Column("wall", sa.String(length=80), nullable=True),
        sa.Column("sizes", sa.JSON(), nullable=True),
        sa.Column("insulation", sa.String(length=120), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("project_id", "name", name="uq_line_class_name"),
    )


def downgrade() -> None:
    op.drop_table("line_classes")
