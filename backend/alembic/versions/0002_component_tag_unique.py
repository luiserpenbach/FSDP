"""Add per-diagram component tag uniqueness.

Revision ID: 0002_component_tag_unique
Revises: 0001_initial_mvp_schema
Create Date: 2026-08-03
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002_component_tag_unique"
down_revision: str | None = "0001_initial_mvp_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_unique_constraint("uq_component_tag", "component_instances", ["diagram_id", "tag"])


def downgrade() -> None:
    op.drop_constraint("uq_component_tag", "component_instances", type_="unique")
