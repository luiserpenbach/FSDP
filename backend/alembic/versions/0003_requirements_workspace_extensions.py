"""Requirements workspace extensions.

Revision ID: 0003_requirements_workspace
Revises: 0002_parts_catalog_extensions
Create Date: 2026-06-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0003_requirements_workspace"
down_revision: str | None = "0002_parts_catalog_extensions"
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
        "requirement_sets",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("requirement_type", sa.String(length=80), nullable=False),
        sa.Column("default_verification_method", sa.String(length=80)),
        sa.Column("template_text", sa.Text()),
        sa.Column("template_properties", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        *timestamp_columns(),
        sa.UniqueConstraint("project_id", "name", name="uq_requirement_set_name"),
    )
    op.add_column(
        "requirements",
        sa.Column(
            "lifecycle_status", sa.String(length=40), nullable=False, server_default="active"
        ),
    )
    op.add_column(
        "requirements",
        sa.Column(
            "verification_status",
            sa.String(length=40),
            nullable=False,
            server_default="not_started",
        ),
    )
    op.add_column(
        "requirements",
        sa.Column(
            "set_id",
            sa.String(length=36),
            sa.ForeignKey("requirement_sets.id", ondelete="SET NULL"),
        ),
    )
    op.add_column(
        "requirements",
        sa.Column(
            "superseded_by_requirement_id",
            sa.String(length=36),
            sa.ForeignKey("requirements.id", ondelete="SET NULL"),
        ),
    )
    op.create_table(
        "requirement_revision_history",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "requirement_id",
            sa.String(length=36),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("revision_label", sa.String(length=40)),
        sa.Column("change_summary", sa.Text(), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        *timestamp_columns(),
    )
    op.create_table(
        "requirement_attachments",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "requirement_id",
            sa.String(length=36),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
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
    op.drop_table("requirement_attachments")
    op.drop_table("requirement_revision_history")
    op.drop_column("requirements", "superseded_by_requirement_id")
    op.drop_column("requirements", "set_id")
    op.drop_column("requirements", "verification_status")
    op.drop_column("requirements", "lifecycle_status")
    op.drop_table("requirement_sets")
