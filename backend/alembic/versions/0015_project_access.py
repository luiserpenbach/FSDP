"""Project access control: restricted projects, members, and project-stamped changes.

Revision ID: 0015_project_access
Revises: 0014_api_tokens_login_lock
Create Date: 2026-11-17

Existing projects stay open to every user. Change events recorded before this
revision carry no project and are attributed where the object still exists.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0015_project_access"
down_revision: str | None = "0014_api_tokens_login_lock"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Attribute old change events to their project, per object type.
BACKFILL = [
    "UPDATE change_events SET project_id = object_id WHERE object_type = 'project'",
    """UPDATE change_events SET project_id = (
           SELECT d.project_id FROM drawings d WHERE d.id = change_events.object_id)
       WHERE object_type = 'drawing' AND project_id IS NULL""",
    """UPDATE change_events SET project_id = (
           SELECT r.project_id FROM requirements r WHERE r.id = change_events.object_id)
       WHERE object_type = 'requirement' AND project_id IS NULL""",
    """UPDATE change_events SET project_id = (
           SELECT d.project_id FROM bom_snapshots b JOIN drawings d ON d.id = b.drawing_id
           WHERE b.id = change_events.object_id)
       WHERE object_type = 'bom_snapshot' AND project_id IS NULL""",
]


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("restricted", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "project_members",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(length=40), nullable=False, server_default="engineer"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("project_id", "user_id", name="uq_project_member"),
    )
    op.create_index("ix_project_members_project_id", "project_members", ["project_id"])
    op.create_index("ix_project_members_user_id", "project_members", ["user_id"])
    op.add_column("change_events", sa.Column("project_id", sa.String(length=36), nullable=True))
    op.create_index("ix_change_events_project_id", "change_events", ["project_id"])
    for statement in BACKFILL:
        op.execute(statement)


def downgrade() -> None:
    op.drop_index("ix_change_events_project_id", table_name="change_events")
    op.drop_column("change_events", "project_id")
    op.drop_index("ix_project_members_user_id", table_name="project_members")
    op.drop_index("ix_project_members_project_id", table_name="project_members")
    op.drop_table("project_members")
    op.drop_column("projects", "restricted")
