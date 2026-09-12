"""Safety phase A: hazards, requirement evidence and history, requirement
derivation and verification fields, per-project safety settings.

Revision ID: 0013_safety_phase_a
Revises: 0012_drc_requirement_constraints
Create Date: 2026-09-12
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0013_safety_phase_a"
down_revision: str | None = "0012_drc_requirement_constraints"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KNOWN_CATEGORIES = (
    "functional",
    "performance",
    "safety",
    "interface",
    "environmental",
    "manufacturing",
    "verification",
)


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    ]


def upgrade() -> None:
    with op.batch_alter_table("requirements") as batch:
        batch.add_column(sa.Column("parent_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("rationale", sa.Text(), nullable=True))
        batch.add_column(
            sa.Column(
                "category", sa.String(length=40), nullable=False, server_default="functional"
            )
        )
        batch.add_column(
            sa.Column(
                "safety_critical", sa.Boolean(), nullable=False, server_default=sa.false()
            )
        )
        batch.add_column(sa.Column("applicability", sa.JSON(), nullable=True))
        batch.add_column(
            sa.Column(
                "verification_status",
                sa.String(length=20),
                nullable=False,
                server_default="planned",
            )
        )
        batch.add_column(
            sa.Column("revision", sa.Integer(), nullable=False, server_default="1")
        )
        batch.add_column(sa.Column("source_ref", sa.String(length=200), nullable=True))
        batch.create_foreign_key(
            "fk_requirements_parent",
            "requirements",
            ["parent_id"],
            ["id"],
            ondelete="SET NULL",
        )
    # Requirements typed with a known category name keep it as their category.
    requirements = sa.table(
        "requirements",
        sa.column("requirement_type", sa.String),
        sa.column("category", sa.String),
    )
    op.execute(
        requirements.update()
        .where(sa.func.lower(requirements.c.requirement_type).in_(KNOWN_CATEGORIES))
        .values(category=sa.func.lower(requirements.c.requirement_type))
    )

    op.create_table(
        "requirement_history",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "requirement_id",
            sa.String(length=36),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("field", sa.String(length=40), nullable=False),
        sa.Column("old_value", sa.Text(), nullable=True),
        sa.Column("new_value", sa.Text(), nullable=True),
        sa.Column("actor", sa.String(length=160), nullable=True),
        *_timestamps(),
    )
    op.create_index(
        "ix_requirement_history_requirement_id", "requirement_history", ["requirement_id"]
    )

    op.create_table(
        "requirement_evidence",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "requirement_id",
            sa.String(length=36),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("ref_type", sa.String(length=40), nullable=True),
        sa.Column("ref_id", sa.String(length=200), nullable=True),
        sa.Column("status", sa.String(length=10), nullable=False, server_default="pending"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("recorded_by", sa.String(length=160), nullable=True),
        *_timestamps(),
        sa.UniqueConstraint(
            "requirement_id", "kind", "ref_type", "ref_id", name="uq_requirement_evidence_ref"
        ),
    )
    op.create_index(
        "ix_requirement_evidence_requirement_id", "requirement_evidence", ["requirement_id"]
    )

    op.create_table(
        "hazards",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("category", sa.String(length=40), nullable=False, server_default="other"),
        sa.Column(
            "system_id",
            sa.String(length=36),
            sa.ForeignKey("fluid_systems.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("operating_modes", sa.JSON(), nullable=True),
        sa.Column("severity_initial", sa.String(length=4), nullable=True),
        sa.Column("likelihood_initial", sa.String(length=4), nullable=True),
        sa.Column("severity_residual", sa.String(length=4), nullable=True),
        sa.Column("likelihood_residual", sa.String(length=4), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="open"),
        sa.Column("owner", sa.String(length=160), nullable=True),
        sa.Column("accepted_by", sa.String(length=160), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acceptance_justification", sa.Text(), nullable=True),
        sa.Column(
            "fault_tolerance_required", sa.Integer(), nullable=False, server_default="1"
        ),
        *_timestamps(),
        sa.UniqueConstraint("project_id", "key", name="uq_hazard_key"),
    )
    op.create_index("ix_hazards_project_id", "hazards", ["project_id"])

    op.create_table(
        "safety_settings",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(length=36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("settings", sa.JSON(), nullable=False),
        *_timestamps(),
    )


def downgrade() -> None:
    op.drop_table("safety_settings")
    op.drop_index("ix_hazards_project_id", table_name="hazards")
    op.drop_table("hazards")
    op.drop_index("ix_requirement_evidence_requirement_id", table_name="requirement_evidence")
    op.drop_table("requirement_evidence")
    op.drop_index("ix_requirement_history_requirement_id", table_name="requirement_history")
    op.drop_table("requirement_history")
    with op.batch_alter_table("requirements") as batch:
        batch.drop_constraint("fk_requirements_parent", type_="foreignkey")
        for column in (
            "source_ref",
            "revision",
            "verification_status",
            "applicability",
            "safety_critical",
            "category",
            "rationale",
            "parent_id",
        ):
            batch.drop_column(column)
