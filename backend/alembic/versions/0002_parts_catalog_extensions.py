"""Parts catalog extensions.

Revision ID: 0002_parts_catalog_extensions
Revises: 0001_initial_mvp_schema
Create Date: 2026-06-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0002_parts_catalog_extensions"
down_revision: str | None = "0001_initial_mvp_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def timestamp_columns() -> list[sa.Column]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def upgrade() -> None:
    op.create_table(
        "part_families",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=160), nullable=False, unique=True),
        sa.Column("description", sa.Text()),
        sa.Column("part_type", sa.String(length=80), nullable=False),
        sa.Column("template_properties", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        *timestamp_columns(),
    )
    op.add_column(
        "parts",
        sa.Column(
            "lifecycle_status", sa.String(length=40), nullable=False, server_default="active"
        ),
    )
    op.add_column(
        "parts",
        sa.Column(
            "family_id",
            sa.String(length=36),
            sa.ForeignKey("part_families.id", ondelete="SET NULL"),
        ),
    )
    op.add_column(
        "parts",
        sa.Column(
            "replacement_part_id",
            sa.String(length=36),
            sa.ForeignKey("parts.id", ondelete="SET NULL"),
        ),
    )
    op.create_table(
        "part_revision_history",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "part_id",
            sa.String(length=36),
            sa.ForeignKey("parts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("revision_label", sa.String(length=40)),
        sa.Column("change_summary", sa.Text(), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        *timestamp_columns(),
    )
    op.create_table(
        "part_attachments",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "part_id",
            sa.String(length=36),
            sa.ForeignKey("parts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("attachment_type", sa.String(length=80), nullable=False),
        sa.Column("mime_type", sa.String(length=120)),
        sa.Column("size_bytes", sa.Integer()),
        sa.Column("content_base64", sa.Text()),
        *timestamp_columns(),
    )


def downgrade() -> None:
    op.drop_table("part_attachments")
    op.drop_table("part_revision_history")
    op.drop_column("parts", "replacement_part_id")
    op.drop_column("parts", "family_id")
    op.drop_column("parts", "lifecycle_status")
    op.drop_table("part_families")
