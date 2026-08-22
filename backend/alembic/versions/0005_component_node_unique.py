"""Enforce one component instance per diagram node.

Revision ID: 0005_component_node_unique
Revises: 0004_pid_symbols
Create Date: 2026-08-15
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005_component_node_unique"
down_revision: str | None = "0004_pid_symbols"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Keep the oldest binding when duplicates already exist; clear the rest.
    # Multiple NULLs remain valid after the unique constraint is added.
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            """
            SELECT id, node_id
            FROM component_instances
            WHERE node_id IS NOT NULL
            ORDER BY created_at ASC, id ASC
            """
        )
    ).fetchall()
    seen: set[str] = set()
    for row in rows:
        node_id = row.node_id if hasattr(row, "node_id") else row[1]
        row_id = row.id if hasattr(row, "id") else row[0]
        if node_id in seen:
            conn.execute(
                sa.text("UPDATE component_instances SET node_id = NULL WHERE id = :id"),
                {"id": row_id},
            )
        else:
            seen.add(node_id)

    op.create_unique_constraint("uq_component_node", "component_instances", ["node_id"])


def downgrade() -> None:
    op.drop_constraint("uq_component_node", "component_instances", type_="unique")
