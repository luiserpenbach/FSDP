"""Add the schematic document column to diagrams.

Revision ID: 0007_diagram_schematic
Revises: 0006_component_node_unique
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0007_diagram_schematic"
down_revision: str | None = "0006_component_node_unique"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("diagrams", sa.Column("schematic", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("diagrams", "schematic")
