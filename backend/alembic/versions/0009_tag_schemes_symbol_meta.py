"""Per-project tag schemes and library metadata on custom symbols.

Revision ID: 0009_tag_schemes_symbol_meta
Revises: 0008_drawings
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0009_tag_schemes_symbol_meta"
down_revision: str | None = "0008_drawings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("pid_symbols", sa.Column("category", sa.String(length=40), nullable=True))
    op.add_column("pid_symbols", sa.Column("legend", sa.String(length=200), nullable=True))
    op.add_column("pid_symbols", sa.Column("tag_prefix", sa.String(length=16), nullable=True))
    op.create_table(
        "tag_schemes",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("scheme", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("tag_schemes")
    op.drop_column("pid_symbols", "tag_prefix")
    op.drop_column("pid_symbols", "legend")
    op.drop_column("pid_symbols", "category")
