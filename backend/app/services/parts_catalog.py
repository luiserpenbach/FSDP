from __future__ import annotations

import csv
import io
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    BomSnapshot,
    ComponentInstance,
    Diagram,
    FluidSystem,
    Part,
    PartFamily,
    PartRevisionHistory,
    Project,
    Requirement,
    TraceLink,
)

PART_SNAPSHOT_FIELDS = (
    "part_number",
    "revision",
    "description",
    "manufacturer",
    "part_type",
    "source_type",
    "material",
    "pressure_rating_bar",
    "temperature_min_c",
    "temperature_max_c",
    "cv",
    "mass_kg",
    "dimensions",
    "certification_status",
    "qualification_status",
    "lifecycle_status",
    "family_id",
    "replacement_part_id",
)


def part_snapshot(part: Part) -> dict[str, Any]:
    snapshot = {field: getattr(part, field) for field in PART_SNAPSHOT_FIELDS}
    snapshot["metadata"] = part.metadata_
    return snapshot


def record_revision_history(
    db: Session, part: Part, summary: str, snapshot: dict[str, Any]
) -> None:
    db.add(
        PartRevisionHistory(
            part_id=part.id,
            revision_label=part.revision,
            change_summary=summary,
            snapshot=snapshot,
        )
    )


def apply_family_template(payload: dict[str, Any], family: PartFamily | None) -> dict[str, Any]:
    if family is None:
        return payload
    merged = dict(payload)
    for key, value in family.template_properties.items():
        if merged.get(key) in (None, "", {}):
            merged[key] = value
    if not merged.get("part_type"):
        merged["part_type"] = family.part_type
    merged["family_id"] = family.id
    return merged


def get_part_where_used(db: Session, part_id: str) -> dict[str, Any]:
    part = db.get(Part, part_id)
    if part is None:
        return {
            "part_id": part_id,
            "components": [],
            "diagrams": [],
            "bom_snapshots": [],
            "requirements": [],
        }

    components = list(
        db.scalars(select(ComponentInstance).where(ComponentInstance.part_id == part_id))
    )
    diagram_rows: dict[str, dict[str, Any]] = {}
    for component in components:
        diagram = db.get(Diagram, component.diagram_id)
        if diagram is None:
            continue
        system = db.get(FluidSystem, diagram.system_id)
        project = db.get(Project, system.project_id) if system else None
        entry = diagram_rows.setdefault(
            diagram.id,
            {
                "diagram_id": diagram.id,
                "diagram_name": diagram.name,
                "system_name": system.name if system else None,
                "project_name": project.name if project else None,
                "component_tags": [],
            },
        )
        entry["component_tags"].append(component.tag)

    bom_snapshots: list[dict[str, Any]] = []
    for snapshot in db.scalars(select(BomSnapshot)):
        for row in snapshot.rows:
            if row.get("part_id") == part_id or row.get("part_number") == part.part_number:
                diagram = db.get(Diagram, snapshot.diagram_id)
                bom_snapshots.append(
                    {
                        "snapshot_id": snapshot.id,
                        "diagram_id": snapshot.diagram_id,
                        "diagram_name": diagram.name if diagram else None,
                        "revision": snapshot.revision,
                        "quantity": row.get("quantity"),
                    }
                )
                break

    requirements: list[dict[str, Any]] = []
    component_ids = [component.id for component in components]
    if component_ids:
        links = db.scalars(
            select(TraceLink).where(
                TraceLink.target_type == "component",
                TraceLink.target_id.in_(component_ids),
                TraceLink.source_type == "requirement",
            )
        )
        for link in links:
            requirement = db.get(Requirement, link.source_id)
            if requirement:
                requirements.append(
                    {
                        "requirement_id": requirement.id,
                        "key": requirement.key,
                        "title": requirement.title,
                        "link_type": link.link_type,
                    }
                )

    return {
        "part_id": part_id,
        "components": [
            {
                "component_id": component.id,
                "tag": component.tag,
                "diagram_id": component.diagram_id,
                "quantity": component.quantity,
            }
            for component in components
        ],
        "diagrams": list(diagram_rows.values()),
        "bom_snapshots": bom_snapshots,
        "requirements": requirements,
    }


def compare_parts(left: Part, right: Part) -> list[dict[str, Any]]:
    differences: list[dict[str, Any]] = []
    for field in (*PART_SNAPSHOT_FIELDS, "metadata"):
        left_value = left.metadata_ if field == "metadata" else getattr(left, field)
        right_value = right.metadata_ if field == "metadata" else getattr(right, field)
        if left_value != right_value:
            differences.append({"field": field, "left": left_value, "right": right_value})
    return differences


def bulk_update_parts(db: Session, part_ids: list[str], updates: dict[str, Any]) -> list[Part]:
    updated: list[Part] = []
    for part_id in part_ids:
        part = db.get(Part, part_id)
        if part is None:
            continue
        before = part_snapshot(part)
        for field, value in updates.items():
            if field == "metadata":
                part.metadata_ = value
            elif value is not None:
                setattr(part, field, value)
        record_revision_history(db, part, "Bulk update", before)
        updated.append(part)
    return updated


IMPORTABLE_FIELDS = {
    "part_number",
    "revision",
    "description",
    "manufacturer",
    "part_type",
    "source_type",
    "material",
    "pressure_rating_bar",
    "qualification_status",
    "certification_status",
    "lifecycle_status",
}


def import_parts_csv(
    db: Session,
    csv_text: str,
    column_mapping: dict[str, str],
    on_duplicate: str,
) -> dict[str, Any]:
    reader = csv.DictReader(io.StringIO(csv_text))
    created = 0
    updated = 0
    skipped = 0
    errors: list[str] = []

    for index, row in enumerate(reader, start=2):
        payload: dict[str, Any] = {}
        for csv_column, part_field in column_mapping.items():
            if part_field not in IMPORTABLE_FIELDS:
                continue
            raw = row.get(csv_column, "").strip()
            if not raw:
                continue
            if part_field == "pressure_rating_bar":
                payload[part_field] = float(raw)
            else:
                payload[part_field] = raw

        part_number = payload.get("part_number")
        if not part_number:
            errors.append(f"Row {index}: missing part_number")
            continue
        if not payload.get("description"):
            errors.append(f"Row {index}: missing description")
            continue
        if not payload.get("part_type"):
            payload["part_type"] = "component"

        existing = db.scalar(select(Part).where(Part.part_number == part_number))
        if existing:
            if on_duplicate == "skip":
                skipped += 1
                continue
            if on_duplicate == "error":
                errors.append(f"Row {index}: duplicate part_number {part_number}")
                continue
            before = part_snapshot(existing)
            for field, value in payload.items():
                if field != "part_number":
                    setattr(existing, field, value)
            record_revision_history(db, existing, f"Imported update for {part_number}", before)
            updated += 1
            continue

        data = {**payload, "metadata_": {}}
        db.add(Part(**data))
        created += 1

    return {"created": created, "updated": updated, "skipped": skipped, "errors": errors}
