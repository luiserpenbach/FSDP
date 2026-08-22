"""Catalog Phase A: lifecycle, numbering settings, and documents.

Revision ID: 0005_catalog_phase_a
Revises: 0004_pid_symbols
Create Date: 2026-08-22
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005_catalog_phase_a"
down_revision: str | None = "0004_pid_symbols"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("part_name_prefix", sa.String(length=40)))
    op.add_column(
        "projects",
        sa.Column("part_name_next_sequence", sa.Integer(), nullable=False, server_default="1"),
    )

    op.add_column(
        "parts",
        sa.Column("lifecycle_status", sa.String(length=40), nullable=False, server_default="draft"),
    )
    op.add_column(
        "parts",
        sa.Column("preferred", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("parts", sa.Column("notes", sa.Text()))

    op.execute(
        sa.text(
            """
            UPDATE parts SET
              preferred = CASE WHEN qualification_status = 'preferred' THEN TRUE ELSE FALSE END,
              lifecycle_status = CASE
                WHEN qualification_status = 'legacy' THEN 'legacy'
                WHEN qualification_status = 'restricted' THEN 'restricted'
                WHEN qualification_status = 'unqualified' THEN 'draft'
                ELSE 'active'
              END,
              qualification_status = CASE
                WHEN qualification_status IN ('preferred', 'qualified') THEN 'qualified'
                ELSE 'unqualified'
              END
            """
        )
    )

    op.create_table(
        "catalog_settings",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("prefix", sa.String(length=40), nullable=False, server_default="AMPH"),
        sa.Column("sequence_padding", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("next_sequence", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("part_types", sa.JSON(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_table(
        "catalog_documents",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "part_id",
            sa.String(length=36),
            sa.ForeignKey("parts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False, server_default="other"),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column(
            "content_type",
            sa.String(length=120),
            nullable=False,
            server_default="application/octet-stream",
        ),
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("storage_path", sa.String(length=500), nullable=False),
        sa.Column("source_url", sa.String(length=500)),
        sa.Column("uploaded_by", sa.String(length=160)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_table("catalog_documents")
    op.drop_table("catalog_settings")
    op.drop_column("parts", "notes")
    op.drop_column("parts", "preferred")
    op.drop_column("parts", "lifecycle_status")
    op.drop_column("projects", "part_name_next_sequence")
    op.drop_column("projects", "part_name_prefix")
