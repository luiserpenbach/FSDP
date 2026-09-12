"""Requirement verification: evidence roll-up, DRC evidence mirrored from saved
sheets, derivation checks, and the per-field history written on update."""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    DrawingSheet,
    DrcRequirementCheck,
    Requirement,
    RequirementEvidence,
    RequirementHistory,
)

MAX_DERIVATION_DEPTH = 32

# Fields whose changes are recorded in requirement_history.
TRACKED_FIELDS = (
    "key",
    "title",
    "text",
    "requirement_type",
    "verification_method",
    "status",
    "owner",
    "constraint",
    "parent_id",
    "rationale",
    "category",
    "applicability",
    "source_ref",
)


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict | list):
        return json.dumps(value, sort_keys=True)
    return str(value)


def rollup_status(evidence: Iterable[RequirementEvidence]) -> str:
    rows = list(evidence)
    if not rows:
        return "planned"
    if any(row.status == "fail" for row in rows):
        return "failed"
    if any(row.kind == "waiver" for row in rows):
        return "waived"
    if all(row.status == "pass" for row in rows):
        return "verified"
    return "in_progress"


def rollup_verification(db: Session, requirement: Requirement) -> str:
    """Recompute and store the requirement's verification status."""
    rows = list(
        db.scalars(
            select(RequirementEvidence).where(
                RequirementEvidence.requirement_id == requirement.id
            )
        )
    )
    requirement.verification_status = rollup_status(rows)
    return requirement.verification_status


def sync_drc_evidence(db: Session, sheet: DrawingSheet) -> set[str]:
    """Mirror the sheet's requirement checks into ``drc`` evidence rows.

    One row per (requirement, sheet): ``fail`` when any check on the sheet
    failed, else ``pass``. Requirements no longer checked on the sheet lose
    their row. Returns the ids of requirements whose status was recomputed.
    """
    checks = list(
        db.scalars(
            select(DrcRequirementCheck).where(DrcRequirementCheck.sheet_id == sheet.id)
        )
    )
    failed_by_requirement: dict[str, bool] = {}
    for check in checks:
        failed_by_requirement[check.requirement_id] = (
            failed_by_requirement.get(check.requirement_id, False) or check.status == "fail"
        )
    existing = {
        row.requirement_id: row
        for row in db.scalars(
            select(RequirementEvidence).where(
                RequirementEvidence.kind == "drc",
                RequirementEvidence.ref_type == "sheet",
                RequirementEvidence.ref_id == sheet.id,
            )
        )
    }
    touched: set[str] = set()
    for requirement_id, failed in failed_by_requirement.items():
        status = "fail" if failed else "pass"
        row = existing.pop(requirement_id, None)
        if row is None:
            db.add(
                RequirementEvidence(
                    requirement_id=requirement_id,
                    kind="drc",
                    ref_type="sheet",
                    ref_id=sheet.id,
                    status=status,
                    note=f"Design rule check on sheet {sheet.sheet_no}",
                )
            )
            touched.add(requirement_id)
        elif row.status != status:
            row.status = status
            touched.add(requirement_id)
    for requirement_id, row in existing.items():
        db.delete(row)
        touched.add(requirement_id)
    db.flush()
    for requirement in db.scalars(select(Requirement).where(Requirement.id.in_(touched))):
        rollup_verification(db, requirement)
    db.flush()
    return touched


def validate_parent(db: Session, requirement: Requirement | None, parent_id: str | None,
                    project_id: str) -> Requirement | None:
    """The parent must exist in the same project and must not create a cycle."""
    if parent_id is None:
        return None
    parent = db.get(Requirement, parent_id)
    if parent is None or parent.project_id != project_id:
        raise ValueError("parent_id must reference a requirement in the same project")
    if requirement is not None:
        if parent.id == requirement.id:
            raise ValueError("a requirement cannot derive from itself")
        cursor: Requirement | None = parent
        for _ in range(MAX_DERIVATION_DEPTH):
            if cursor is None:
                break
            if cursor.id == requirement.id:
                raise ValueError("parent_id would create a derivation cycle")
            cursor = db.get(Requirement, cursor.parent_id) if cursor.parent_id else None
    return parent


def apply_requirement_update(
    db: Session, requirement: Requirement, changes: dict[str, Any], actor: str | None
) -> list[str]:
    """Apply changed fields, write history rows, bump the revision. Returns changed fields."""
    changed: list[str] = []
    for field, value in changes.items():
        if field not in TRACKED_FIELDS:
            continue
        old = getattr(requirement, field)
        if _as_text(old) == _as_text(value):
            continue
        changed.append(field)
    if not changed:
        return []
    requirement.revision = (requirement.revision or 1) + 1
    for field in changed:
        old = getattr(requirement, field)
        value = changes[field]
        db.add(
            RequirementHistory(
                requirement_id=requirement.id,
                revision=requirement.revision,
                field=field,
                old_value=_as_text(old),
                new_value=_as_text(value),
                actor=actor,
            )
        )
        setattr(requirement, field, value)
    return changed
