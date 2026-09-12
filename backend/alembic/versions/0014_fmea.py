"""Safety phase B: failure-mode library, FMEA worksheets, rows, releases, comments.

Revision ID: 0014_fmea
Revises: 0013_safety_phase_a
Create Date: 2026-09-12
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0014_fmea"
down_revision: str | None = "0013_safety_phase_a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    ]


def upgrade() -> None:
    op.create_table(
        "failure_modes",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("category", sa.String(length=40), nullable=False),
        sa.Column("symbol_key", sa.String(length=120), nullable=True),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("default_local_effect", sa.Text(), nullable=False, server_default=""),
        sa.Column("default_detection_hint", sa.JSON(), nullable=True),
        sa.Column("default_severity", sa.Integer(), nullable=True),
        sa.Column("applicable_modes", sa.JSON(), nullable=True),
        sa.Column(
            "replaces_category", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        *_timestamps(),
        sa.UniqueConstraint("category", "symbol_key", "name", name="uq_failure_mode"),
    )
    op.create_table(
        "fmea_worksheets",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "system_id",
            sa.String(length=36),
            sa.ForeignKey("fluid_systems.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "drawing_id",
            sa.String(length=36),
            sa.ForeignKey("drawings.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("drawing_revision_label", sa.String(length=16), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("method", sa.String(length=10), nullable=False, server_default="fmea"),
        sa.Column("operating_modes", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="draft"),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        *_timestamps(),
    )
    op.create_index("ix_fmea_worksheets_project_id", "fmea_worksheets", ["project_id"])
    op.create_table(
        "fmea_rows",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "worksheet_id",
            sa.String(length=36),
            sa.ForeignKey("fmea_worksheets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "sheet_id",
            sa.String(length=36),
            sa.ForeignKey("drawing_sheets.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("item_id", sa.String(length=80), nullable=True),
        sa.Column("subject_text", sa.String(length=200), nullable=True),
        sa.Column("item_tag_seen", sa.String(length=80), nullable=True),
        sa.Column("part_id_seen", sa.String(length=36), nullable=True),
        sa.Column("volume_key_seen", sa.String(length=80), nullable=True),
        sa.Column(
            "failure_mode_id",
            sa.String(length=36),
            sa.ForeignKey("failure_modes.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("failure_mode_text", sa.String(length=160), nullable=True),
        sa.Column("operating_modes", sa.JSON(), nullable=True),
        sa.Column("cause", sa.Text(), nullable=False, server_default=""),
        sa.Column("local_effect", sa.Text(), nullable=False, server_default=""),
        sa.Column("next_effect", sa.Text(), nullable=False, server_default=""),
        sa.Column("end_effect", sa.Text(), nullable=False, server_default=""),
        sa.Column("detected_by_item_id", sa.String(length=80), nullable=True),
        sa.Column(
            "detection_kind", sa.String(length=20), nullable=False, server_default="none"
        ),
        sa.Column("detection_reason", sa.Text(), nullable=True),
        sa.Column("severity", sa.Integer(), nullable=True),
        sa.Column("occurrence", sa.Integer(), nullable=True),
        sa.Column("detection", sa.Integer(), nullable=True),
        sa.Column("rpn", sa.Integer(), nullable=True),
        sa.Column(
            "hazard_id",
            sa.String(length=36),
            sa.ForeignKey("hazards.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("recommended_action", sa.Text(), nullable=True),
        sa.Column("action_owner", sa.String(length=160), nullable=True),
        sa.Column("action_due", sa.String(length=32), nullable=True),
        sa.Column(
            "action_status", sa.String(length=20), nullable=False, server_default="not_required"
        ),
        sa.Column("severity_residual", sa.Integer(), nullable=True),
        sa.Column("occurrence_residual", sa.Integer(), nullable=True),
        sa.Column("detection_residual", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("not_applicable", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("stale_reason", sa.String(length=40), nullable=True),
        sa.Column("stale_detail", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        *_timestamps(),
    )
    op.create_index("ix_fmea_rows_worksheet", "fmea_rows", ["worksheet_id", "position"])
    op.create_index("ix_fmea_rows_item", "fmea_rows", ["sheet_id", "item_id"])
    op.create_index("ix_fmea_rows_hazard", "fmea_rows", ["hazard_id"])
    op.create_table(
        "fmea_releases",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "worksheet_id",
            sa.String(length=36),
            sa.ForeignKey("fmea_worksheets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("drawing_revision_label", sa.String(length=16), nullable=True),
        sa.Column("rows", sa.JSON(), nullable=False),
        sa.Column("released_by", sa.String(length=160), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        *_timestamps(),
        sa.UniqueConstraint("worksheet_id", "revision", name="uq_fmea_release"),
    )
    op.create_table(
        "fmea_row_comments",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "row_id",
            sa.String(length=36),
            sa.ForeignKey("fmea_rows.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("author", sa.String(length=160), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("resolved", sa.Boolean(), nullable=False, server_default=sa.false()),
        *_timestamps(),
    )
    op.create_index("ix_fmea_row_comments_row", "fmea_row_comments", ["row_id"])


def downgrade() -> None:
    op.drop_index("ix_fmea_row_comments_row", table_name="fmea_row_comments")
    op.drop_table("fmea_row_comments")
    op.drop_table("fmea_releases")
    op.drop_index("ix_fmea_rows_hazard", table_name="fmea_rows")
    op.drop_index("ix_fmea_rows_item", table_name="fmea_rows")
    op.drop_index("ix_fmea_rows_worksheet", table_name="fmea_rows")
    op.drop_table("fmea_rows")
    op.drop_index("ix_fmea_worksheets_project_id", table_name="fmea_worksheets")
    op.drop_table("fmea_worksheets")
    op.drop_table("failure_modes")
