"""Drawing lineage: the source a drawing was copied from.

Revision ID: 0016_drawing_lineage
Revises: 0015_project_access
Create Date: 2026-11-17
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0016_drawing_lineage"
down_revision: str | None = "0015_project_access"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("drawings", sa.Column("copied_from_id", sa.String(length=36), nullable=True))
    op.add_column("drawings", sa.Column("copied_from_number", sa.String(length=80), nullable=True))
    op.add_column(
        "drawings", sa.Column("copied_from_revision", sa.String(length=16), nullable=True)
    )
    op.create_foreign_key(
        "fk_drawings_copied_from",
        "drawings",
        "drawings",
        ["copied_from_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_drawings_copied_from_id", "drawings", ["copied_from_id"])


def downgrade() -> None:
    op.drop_index("ix_drawings_copied_from_id", table_name="drawings")
    op.drop_constraint("fk_drawings_copied_from", "drawings", type_="foreignkey")
    op.drop_column("drawings", "copied_from_revision")
    op.drop_column("drawings", "copied_from_number")
    op.drop_column("drawings", "copied_from_id")
