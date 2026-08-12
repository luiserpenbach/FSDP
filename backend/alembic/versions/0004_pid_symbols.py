"""Add pid_symbols table for user-defined P&ID symbols.

Revision ID: 0004_pid_symbols
Revises: 0003_users
Create Date: 2026-08-12
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0004_pid_symbols"
down_revision: str | None = "0003_users"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "pid_symbols",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False, unique=True),
        sa.Column(
            "view_box", sa.String(length=80), nullable=False, server_default="0 0 64 40"
        ),
        sa.Column("svg", sa.Text(), nullable=False),
        sa.Column("ports", sa.JSON(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_table("pid_symbols")
