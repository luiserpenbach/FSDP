"""Drawing release workflow, stale sheet index tracking, BoM release stamps, indexes.

Revision ID: 0013_release_workflow
Revises: 0012_drc_requirement_constraints
Create Date: 2026-10-04

Existing data is mapped as follows:

* drawings.status: "released" stays released, "in_review"/"for_review" become
  "in_review", anything else (the old "working" default, free text) becomes "draft".
* drawing_revisions.status: "draft", except the current (highest sequence) revision
  of a released drawing, which becomes "released" and gets a snapshot of its sheet
  documents (flagged "migrated", without index rows) so the release stays immutable.
* drawing_sheets.index_stale: false when the sheet has stored index rows or an empty
  document, true otherwise (a converted or never-saved sheet).
"""

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa

from alembic import op

revision: str = "0013_release_workflow"
down_revision: str | None = "0012_drc_requirement_constraints"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEXES = [
    ("ix_trace_links_source", "trace_links", ["source_type", "source_id"]),
    ("ix_trace_links_target", "trace_links", ["target_type", "target_id"]),
    ("ix_change_events_created_at", "change_events", ["created_at"]),
    ("ix_component_instances_part_id", "component_instances", ["part_id"]),
    ("ix_bom_snapshots_drawing_id", "bom_snapshots", ["drawing_id"]),
    ("ix_requirements_project_id", "requirements", ["project_id"]),
]

drawings = sa.table(
    "drawings",
    sa.column("id", sa.String),
    sa.column("project_id", sa.String),
    sa.column("system_id", sa.String),
    sa.column("number", sa.String),
    sa.column("title", sa.Text),
    sa.column("size", sa.String),
    sa.column("units", sa.String),
    sa.column("discipline", sa.String),
    sa.column("status", sa.String),
    sa.column("frame_template", sa.String),
    sa.column("fields", sa.JSON),
    sa.column("notes", sa.JSON),
)
revisions = sa.table(
    "drawing_revisions",
    sa.column("id", sa.String),
    sa.column("drawing_id", sa.String),
    sa.column("sequence", sa.Integer),
    sa.column("label", sa.String),
    sa.column("description", sa.Text),
    sa.column("status", sa.String),
    sa.column("drawn_by", sa.String),
    sa.column("drawn_date", sa.String),
    sa.column("approved_by", sa.String),
    sa.column("approved_date", sa.String),
    sa.column("snapshot", sa.JSON),
)
sheets = sa.table(
    "drawing_sheets",
    sa.column("id", sa.String),
    sa.column("drawing_id", sa.String),
    sa.column("sheet_no", sa.Integer),
    sa.column("title", sa.String),
    sa.column("document", sa.JSON),
    sa.column("index_stale", sa.Boolean),
    sa.column("indexed_at", sa.DateTime(timezone=True)),
    sa.column("updated_at", sa.DateTime(timezone=True)),
)
sheet_items = sa.table("sheet_items", sa.column("sheet_id", sa.String))
sheet_lines = sa.table("sheet_lines", sa.column("sheet_id", sa.String))


def _map_drawing_statuses(bind) -> None:
    bind.execute(
        drawings.update().values(
            status=sa.case(
                (drawings.c.status == "released", "released"),
                (drawings.c.status.in_(["in_review", "for_review"]), "in_review"),
                else_="draft",
            )
        )
    )
    bind.execute(revisions.update().values(status="draft"))


def _snapshot_released_drawings(bind) -> None:
    released = bind.execute(sa.select(drawings).where(drawings.c.status == "released")).all()
    now = datetime.now(UTC).isoformat()
    for drawing in released:
        current = bind.execute(
            sa.select(revisions)
            .where(revisions.c.drawing_id == drawing.id)
            .order_by(revisions.c.sequence.desc())
            .limit(1)
        ).first()
        if current is None:
            continue
        drawing_sheets = bind.execute(
            sa.select(sheets.c.id, sheets.c.sheet_no, sheets.c.title, sheets.c.document)
            .where(sheets.c.drawing_id == drawing.id)
            .order_by(sheets.c.sheet_no)
        ).all()
        snapshot = {
            "schema_version": 1,
            "migrated": True,
            "released_at": now,
            "released_by": current.approved_by,
            "drawing": {
                "id": drawing.id,
                "project_id": drawing.project_id,
                "system_id": drawing.system_id,
                "number": drawing.number,
                "title": drawing.title,
                "size": drawing.size,
                "units": drawing.units,
                "discipline": drawing.discipline,
                "frame_template": drawing.frame_template,
                "fields": drawing.fields or {},
                "notes": drawing.notes or [],
            },
            "revision": {
                "id": current.id,
                "sequence": current.sequence,
                "label": current.label,
                "description": current.description,
                "drawn_by": current.drawn_by,
                "drawn_date": current.drawn_date,
                "submitted_by": None,
                "approved_by": current.approved_by,
                "approved_date": current.approved_date,
            },
            "sheets": [
                {
                    "id": sheet.id,
                    "sheet_no": sheet.sheet_no,
                    "title": sheet.title,
                    "document": sheet.document or {},
                    "items": [],
                    "lines": [],
                    "drc": {"findings": [], "waivers": []},
                }
                for sheet in drawing_sheets
            ],
        }
        bind.execute(
            revisions.update()
            .where(revisions.c.id == current.id)
            .values(status="released", snapshot=snapshot)
        )


def _map_index_stale(bind) -> None:
    indexed = sa.union(sa.select(sheet_items.c.sheet_id), sa.select(sheet_lines.c.sheet_id))
    bind.execute(
        sheets.update()
        .where(sheets.c.id.in_(indexed))
        .values(index_stale=False, indexed_at=sheets.c.updated_at)
    )
    # Empty sheets have nothing to index; documents are JSON, so check them here.
    for sheet in bind.execute(
        sa.select(sheets.c.id, sheets.c.document).where(sheets.c.index_stale.is_(True))
    ):
        if not (sheet.document or {}).get("items"):
            bind.execute(sheets.update().where(sheets.c.id == sheet.id).values(index_stale=False))


def upgrade() -> None:
    bind = op.get_bind()
    with op.batch_alter_table("drawing_revisions") as batch:
        batch.add_column(sa.Column("submitted_by", sa.String(length=160), nullable=True))
        batch.add_column(sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("snapshot", sa.JSON(), nullable=True))
        batch.alter_column(
            "status",
            existing_type=sa.String(length=40),
            existing_nullable=False,
            server_default="draft",
        )
    with op.batch_alter_table("drawings") as batch:
        batch.alter_column(
            "status",
            existing_type=sa.String(length=40),
            existing_nullable=False,
            server_default="draft",
        )
    with op.batch_alter_table("drawing_sheets") as batch:
        batch.add_column(
            sa.Column("index_stale", sa.Boolean(), nullable=False, server_default=sa.true())
        )
        batch.add_column(sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=True))
    with op.batch_alter_table("bom_snapshots") as batch:
        batch.add_column(sa.Column("drawing_revision", sa.String(length=16), nullable=True))
        batch.add_column(sa.Column("stale_sheets", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("released_by", sa.String(length=160), nullable=True))
        batch.add_column(sa.Column("released_at", sa.DateTime(timezone=True), nullable=True))

    _map_drawing_statuses(bind)
    _snapshot_released_drawings(bind)
    _map_index_stale(bind)

    for name, table, columns in INDEXES:
        op.create_index(name, table, columns)


def downgrade() -> None:
    for name, table, _ in reversed(INDEXES):
        op.drop_index(name, table_name=table)
    bind = op.get_bind()
    bind.execute(
        drawings.update().values(
            status=sa.case(
                (drawings.c.status == "in_review", "for_review"),
                (drawings.c.status == "draft", "working"),
                else_=drawings.c.status,
            )
        )
    )
    bind.execute(
        revisions.update().where(revisions.c.status != "released").values(status="working")
    )
    with op.batch_alter_table("bom_snapshots") as batch:
        batch.drop_column("released_at")
        batch.drop_column("released_by")
        batch.drop_column("stale_sheets")
        batch.drop_column("drawing_revision")
    with op.batch_alter_table("drawing_sheets") as batch:
        batch.drop_column("indexed_at")
        batch.drop_column("index_stale")
    with op.batch_alter_table("drawings") as batch:
        batch.alter_column(
            "status",
            existing_type=sa.String(length=40),
            existing_nullable=False,
            server_default="working",
        )
    with op.batch_alter_table("drawing_revisions") as batch:
        batch.alter_column(
            "status",
            existing_type=sa.String(length=40),
            existing_nullable=False,
            server_default="working",
        )
        batch.drop_column("snapshot")
        batch.drop_column("approved_at")
        batch.drop_column("submitted_at")
        batch.drop_column("submitted_by")
