from __future__ import annotations

import csv
import io
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    ComponentInstance,
    Diagram,
    FluidSystem,
    Part,
    Project,
    Requirement,
    RequirementAttachment,
    RequirementRevisionHistory,
    RequirementSet,
    TraceLink,
)
from app.services.traceability import get_trace_links

REQUIREMENT_SNAPSHOT_FIELDS = (
    "key",
    "title",
    "text",
    "requirement_type",
    "verification_method",
    "status",
    "owner",
    "lifecycle_status",
    "verification_status",
    "set_id",
    "superseded_by_requirement_id",
)

IMPORTABLE_FIELDS = {
    "key",
    "title",
    "text",
    "requirement_type",
    "verification_method",
    "status",
    "owner",
    "lifecycle_status",
    "verification_status",
}


def requirement_snapshot(requirement: Requirement) -> dict[str, Any]:
    return {field: getattr(requirement, field) for field in REQUIREMENT_SNAPSHOT_FIELDS}


def record_revision_history(
    db: Session, requirement: Requirement, summary: str, snapshot: dict[str, Any]
) -> None:
    db.add(
        RequirementRevisionHistory(
            requirement_id=requirement.id,
            revision_label=requirement.status,
            change_summary=summary,
            snapshot=snapshot,
        )
    )


def apply_set_template(payload: dict[str, Any], requirement_set: RequirementSet | None) -> dict[str, Any]:
    if requirement_set is None:
        return payload
    merged = dict(payload)
    if not merged.get("requirement_type"):
        merged["requirement_type"] = requirement_set.requirement_type
    if not merged.get("verification_method") and requirement_set.default_verification_method:
        merged["verification_method"] = requirement_set.default_verification_method
    if not merged.get("text") and requirement_set.template_text:
        merged["text"] = requirement_set.template_text
    for key, value in requirement_set.template_properties.items():
        if merged.get(key) in (None, "", {}):
            merged[key] = value
    merged["set_id"] = requirement_set.id
    return merged


def derive_verification_display(
    requirement: Requirement, linked: bool, evidence_count: int
) -> str:
    if requirement.verification_status == "failed":
        return "failed"
    if requirement.status == "verified" or requirement.verification_status == "passed":
        return "passed"
    if (
        linked
        or evidence_count > 0
        or requirement.status in ("ready_for_verification", "in_progress")
        or requirement.verification_status == "in_progress"
    ):
        return "in_progress"
    return "not_started"


def _component_id_from_link(link: TraceLink, requirement_id: str) -> str | None:
    if (
        link.source_type == "requirement"
        and link.source_id == requirement_id
        and link.target_type == "component"
    ):
        return link.target_id
    if (
        link.target_type == "requirement"
        and link.target_id == requirement_id
        and link.source_type == "component"
    ):
        return link.source_id
    return None


def _evidence_count(db: Session, requirement_id: str) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(RequirementAttachment)
            .where(RequirementAttachment.requirement_id == requirement_id)
        )
        or 0
    )


def get_requirement_traceability(db: Session, requirement_id: str) -> dict[str, Any]:
    requirement = db.get(Requirement, requirement_id)
    if requirement is None:
        return {
            "requirement_id": requirement_id,
            "links": [],
            "components": [],
            "diagrams": [],
            "parts": [],
        }

    links = get_trace_links(db, "requirement", requirement_id)
    component_rows: dict[str, dict[str, Any]] = {}
    part_rows: dict[str, dict[str, Any]] = {}
    diagram_rows: dict[str, dict[str, Any]] = {}

    serialized_links: list[dict[str, Any]] = []
    for link in links:
        serialized_links.append(
            {
                "id": link.id,
                "source_type": link.source_type,
                "source_id": link.source_id,
                "target_type": link.target_type,
                "target_id": link.target_id,
                "link_type": link.link_type,
                "rationale": link.rationale,
            }
        )
        component_id = _component_id_from_link(link, requirement_id)
        if not component_id:
            continue

        component = db.get(ComponentInstance, component_id)
        if component is None:
            continue

        diagram = db.get(Diagram, component.diagram_id)
        system = db.get(FluidSystem, diagram.system_id) if diagram else None
        project = db.get(Project, system.project_id) if system else None
        part = db.get(Part, component.part_id) if component.part_id else None

        component_rows[component.id] = {
            "component_id": component.id,
            "tag": component.tag,
            "diagram_id": component.diagram_id,
            "quantity": component.quantity,
        }
        if diagram:
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
        if part:
            part_rows[part.id] = {
                "part_id": part.id,
                "part_number": part.part_number,
                "description": part.description,
            }

    return {
        "requirement_id": requirement_id,
        "links": serialized_links,
        "components": list(component_rows.values()),
        "diagrams": list(diagram_rows.values()),
        "parts": list(part_rows.values()),
    }


def get_project_requirement_coverage(db: Session, project_id: str) -> dict[str, dict[str, Any]]:
    requirements = list(db.scalars(select(Requirement).where(Requirement.project_id == project_id)))
    coverage: dict[str, dict[str, Any]] = {}
    for requirement in requirements:
        links = get_trace_links(db, "requirement", requirement.id)
        component_link_count = sum(
            1 for link in links if _component_id_from_link(link, requirement.id) is not None
        )
        evidence_count = _evidence_count(db, requirement.id)
        linked = component_link_count > 0
        coverage[requirement.id] = {
            "link_count": component_link_count,
            "linked": linked,
            "evidence_count": evidence_count,
            "verification_display": derive_verification_display(
                requirement, linked, evidence_count
            ),
        }
    return coverage


def list_project_traceable_components(db: Session, project_id: str) -> list[dict[str, Any]]:
    systems = list(db.scalars(select(FluidSystem).where(FluidSystem.project_id == project_id)))
    rows: list[dict[str, Any]] = []
    for system in systems:
        diagrams = list(db.scalars(select(Diagram).where(Diagram.system_id == system.id)))
        for diagram in diagrams:
            components = list(
                db.scalars(select(ComponentInstance).where(ComponentInstance.diagram_id == diagram.id))
            )
            for component in components:
                part = db.get(Part, component.part_id) if component.part_id else None
                rows.append(
                    {
                        "component_id": component.id,
                        "tag": component.tag,
                        "diagram_id": diagram.id,
                        "diagram_name": diagram.name,
                        "system_name": system.name,
                        "part_number": part.part_number if part else None,
                    }
                )
    return rows


def compare_requirements(left: Requirement, right: Requirement) -> list[dict[str, Any]]:
    differences: list[dict[str, Any]] = []
    for field in REQUIREMENT_SNAPSHOT_FIELDS:
        left_value = getattr(left, field)
        right_value = getattr(right, field)
        if left_value != right_value:
            differences.append({"field": field, "left": left_value, "right": right_value})
    return differences


def bulk_update_requirements(
    db: Session, requirement_ids: list[str], updates: dict[str, Any]
) -> list[Requirement]:
    updated: list[Requirement] = []
    for requirement_id in requirement_ids:
        requirement = db.get(Requirement, requirement_id)
        if requirement is None:
            continue
        before = requirement_snapshot(requirement)
        for field, value in updates.items():
            if value is not None:
                setattr(requirement, field, value)
        record_revision_history(db, requirement, "Bulk update", before)
        updated.append(requirement)
    return updated


def import_requirements_csv(
    db: Session,
    project_id: str,
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
        payload: dict[str, Any] = {"project_id": project_id}
        for csv_column, requirement_field in column_mapping.items():
            if requirement_field not in IMPORTABLE_FIELDS:
                continue
            raw = row.get(csv_column, "").strip()
            if not raw:
                continue
            payload[requirement_field] = raw

        key = payload.get("key")
        if not key:
            errors.append(f"Row {index}: missing key")
            continue
        if not payload.get("title"):
            errors.append(f"Row {index}: missing title")
            continue
        if not payload.get("text"):
            errors.append(f"Row {index}: missing text")
            continue
        if not payload.get("requirement_type"):
            payload["requirement_type"] = "functional"
        if not payload.get("status"):
            payload["status"] = "draft"

        existing = db.scalar(
            select(Requirement).where(
                Requirement.project_id == project_id,
                Requirement.key == key,
            )
        )
        if existing:
            if on_duplicate == "skip":
                skipped += 1
                continue
            if on_duplicate == "error":
                errors.append(f"Row {index}: duplicate key {key}")
                continue
            before = requirement_snapshot(existing)
            for field, value in payload.items():
                if field not in ("project_id", "key"):
                    setattr(existing, field, value)
            record_revision_history(db, existing, f"Imported update for {key}", before)
            updated += 1
            continue

        db.add(Requirement(**payload))
        created += 1

    return {"created": created, "updated": updated, "skipped": skipped, "errors": errors}


def get_project_verification_matrix(db: Session, project_id: str) -> list[dict[str, Any]]:
    requirements = list(db.scalars(select(Requirement).where(Requirement.project_id == project_id)))
    coverage = get_project_requirement_coverage(db, project_id)
    matrix: list[dict[str, Any]] = []

    for requirement in requirements:
        entry = coverage.get(requirement.id, {})
        links = get_trace_links(db, "requirement", requirement.id)
        component_tags: list[str] = []
        for link in links:
            component_id = _component_id_from_link(link, requirement.id)
            if not component_id:
                continue
            component = db.get(ComponentInstance, component_id)
            if component:
                component_tags.append(component.tag)

        matrix.append(
            {
                "requirement_id": requirement.id,
                "key": requirement.key,
                "title": requirement.title,
                "requirement_type": requirement.requirement_type,
                "verification_method": requirement.verification_method,
                "status": requirement.status,
                "verification_status": requirement.verification_status,
                "verification_display": entry.get("verification_display", "not_started"),
                "link_count": entry.get("link_count", 0),
                "evidence_count": entry.get("evidence_count", 0),
                "linked_components": component_tags,
                "lifecycle_status": requirement.lifecycle_status,
            }
        )

    return matrix
