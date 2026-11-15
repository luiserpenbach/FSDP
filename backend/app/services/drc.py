"""Design rule check storage: findings and requirement checks replaced on save,
waivers kept by finding key, drawing summaries, and the verification matrix."""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Drawing,
    DrawingSheet,
    DrcRequirementCheck,
    DrcResult,
    DrcWaiver,
    Part,
    Project,
    Requirement,
    SheetItem,
    SheetLine,
    TraceLink,
)
from app.schemas import DrcIn
from app.services.sheet_index import stale_sheets

# Browser DRC defaults when a constraint omits scope.categories.
_DEFAULT_SCOPE_CATEGORIES = frozenset({"valve", "regulator", "inline", "instrument", "equipment"})
_PROCESS_LINE_TYPES = frozenset({"process", "vacuum", "capillary"})
# Kinds we can re-check from stored index rows + catalog parts (no geometry).
_INDEX_CHECKABLE_KINDS = frozenset(
    {
        "material_in",
        "material_not_in",
        "pressure_rating_min",
        "part_qualified",
        "line_class_in",
    }
)


def replace_sheet_drc(db: Session, sheet: DrawingSheet, drc: DrcIn) -> None:
    """Replace the stored findings and requirement checks of a sheet."""
    for existing in db.scalars(select(DrcResult).where(DrcResult.sheet_id == sheet.id)):
        db.delete(existing)
    for existing in db.scalars(
        select(DrcRequirementCheck).where(DrcRequirementCheck.sheet_id == sheet.id)
    ):
        db.delete(existing)
    db.flush()
    requirement_ids = {
        requirement_id
        for (requirement_id,) in db.execute(
            select(Requirement.id).where(
                Requirement.id.in_(
                    {check.requirement_id for check in drc.checks}
                    | {f.requirement_id for f in drc.findings if f.requirement_id}
                )
            )
        )
    }
    seen: set[str] = set()
    for finding in drc.findings:
        if finding.key in seen:
            continue
        seen.add(finding.key)
        data = finding.model_dump()
        if data["requirement_id"] not in requirement_ids:
            data["requirement_id"] = None
        db.add(DrcResult(sheet_id=sheet.id, **data))
    for check in drc.checks:
        if check.requirement_id not in requirement_ids:
            continue
        db.add(DrcRequirementCheck(sheet_id=sheet.id, **check.model_dump()))
    db.flush()


def _pressure_to_bar(text: str | None) -> float | None:
    """Parse a constraint pressure string to bar (subset of the browser helper)."""
    if not text:
        return None
    match = re.search(r"(-?\d+(?:[.,]\d+)*)\s*([a-zA-Z()]+)?", text.strip())
    if not match:
        return None
    raw = match.group(1).replace(",", "")
    try:
        value = float(raw)
    except ValueError:
        return None
    unit = (match.group(2) or "bar").lower().replace("(", "").replace(")", "")
    factors = {
        "bar": 1.0,
        "barg": 1.0,
        "bara": 1.0,
        "mbar": 0.001,
        "mbarg": 0.001,
        "psi": 0.0689476,
        "psig": 0.0689476,
        "psia": 0.0689476,
        "kpa": 0.01,
        "mpa": 10.0,
        "pa": 1e-5,
        "atm": 1.01325,
    }
    factor = factors.get(unit)
    return value * factor if factor is not None else None


def _constraint_dict(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    kind = raw.get("kind")
    if kind not in _INDEX_CHECKABLE_KINDS:
        return None
    values = [str(entry).strip() for entry in (raw.get("values") or []) if str(entry).strip()]
    scope_in = raw.get("scope") if isinstance(raw.get("scope"), dict) else {}
    scope: dict[str, list[str]] = {}
    for field in ("categories", "services"):
        entries = scope_in.get(field) if scope_in else None
        if entries:
            scope[field] = [str(entry).strip() for entry in entries if str(entry).strip()]
    return {"kind": kind, "values": values, "scope": scope}


def _item_in_scope(
    item: SheetItem,
    scope: dict[str, list[str]],
    services_by_item: dict[str, set[str]],
) -> bool:
    categories = scope.get("categories") or list(_DEFAULT_SCOPE_CATEGORIES)
    category = item.category or ("equipment" if item.kind == "equipment" else None)
    if category not in categories:
        return False
    wanted = scope.get("services") or []
    if wanted:
        lower = {service.lower() for service in wanted}
        have = {service.lower() for service in services_by_item.get(item.item_id, set()) if service}
        if not have.intersection(lower):
            return False
    return True


def _part_constraint_fails(kind: str, values: list[str], part: Part) -> bool:
    material = (part.material or "").lower()
    lower = [value.lower() for value in values]
    if kind == "material_in":
        return not any(value in material for value in lower)
    if kind == "material_not_in":
        return bool(material) and any(value in material for value in lower)
    if kind == "pressure_rating_min":
        minimum = _pressure_to_bar(values[0] if values else None)
        if minimum is None and values:
            try:
                minimum = float(values[0])
            except ValueError:
                minimum = None
        rating = part.pressure_rating_bar
        return rating is None or minimum is None or rating < minimum
    if kind == "part_qualified":
        ok = bool(part.preferred or part.qualification_status == "qualified") and part.lifecycle_status not in {
            "obsolete",
            "restricted",
        }
        return not ok
    return False


def sheets_missing_requirement_findings(db: Session, sheet_ids: Iterable[str]) -> set[str]:
    """Sheet ids whose stored DRC omits a live index-checkable requirement failure.

    `PUT /sheets` trusts the client index+DRC pair and clears `index_stale`. After
    `update_requirement` marks sheets stale, a Save derived against a stale
    requirements catalog (or one that raced the constraint rewrite) can omit the
    new `requirement` errors, leave the sheet looking fresh, and let Release freeze
    a baseline that would fail the live constraint. Callers re-assert stale / block
    release when this set is non-empty.

    Geometry-only kinds (`relief_required`) are not re-checked here.
    """
    ids = list(sheet_ids)
    if not ids:
        return set()

    sheet_project = {
        sheet_id: project_id
        for sheet_id, project_id in db.execute(
            select(DrawingSheet.id, Drawing.project_id)
            .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
            .where(DrawingSheet.id.in_(ids))
        )
    }
    if not sheet_project:
        return set()

    project_ids = set(sheet_project.values())
    requirements_by_project: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    for requirement in db.scalars(
        select(Requirement).where(
            Requirement.project_id.in_(project_ids),
            Requirement.constraint.is_not(None),
        )
    ):
        constraint = _constraint_dict(requirement.constraint)
        if constraint is None:
            continue
        requirements_by_project[requirement.project_id].append((requirement.id, constraint))
    if not any(requirements_by_project.values()):
        return set()

    items = list(db.scalars(select(SheetItem).where(SheetItem.sheet_id.in_(ids))))
    lines = list(db.scalars(select(SheetLine).where(SheetLine.sheet_id.in_(ids))))
    part_ids = {item.part_id for item in items if item.part_id}
    parts = {
        part.id: part for part in db.scalars(select(Part).where(Part.id.in_(part_ids)))
    } if part_ids else {}

    services_by_sheet_item: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    lines_by_sheet: dict[str, list[SheetLine]] = defaultdict(list)
    for line in lines:
        lines_by_sheet[line.sheet_id].append(line)
        if line.service:
            if line.from_item:
                services_by_sheet_item[line.sheet_id][line.from_item].add(line.service)
            if line.to_item:
                services_by_sheet_item[line.sheet_id][line.to_item].add(line.service)

    covered_by_req_item = {
        (sheet_id, requirement_id, item_id)
        for sheet_id, requirement_id, item_id in db.execute(
            select(DrcResult.sheet_id, DrcResult.requirement_id, DrcResult.item_id).where(
                DrcResult.sheet_id.in_(ids),
                DrcResult.rule == "requirement",
                DrcResult.severity == "error",
                DrcResult.requirement_id.is_not(None),
                DrcResult.item_id.is_not(None),
            )
        )
    }
    covered_by_key = {
        (sheet_id, key)
        for sheet_id, key in db.execute(
            select(DrcResult.sheet_id, DrcResult.key).where(
                DrcResult.sheet_id.in_(ids),
                DrcResult.rule == "requirement",
                DrcResult.severity == "error",
            )
        )
    }

    items_by_sheet: dict[str, list[SheetItem]] = defaultdict(list)
    for item in items:
        items_by_sheet[item.sheet_id].append(item)

    missing: set[str] = set()
    for sheet_id, project_id in sheet_project.items():
        reqs = requirements_by_project.get(project_id) or []
        if not reqs:
            continue
        services_of = services_by_sheet_item.get(sheet_id, {})
        for requirement_id, constraint in reqs:
            kind = constraint["kind"]
            values = constraint["values"]
            scope = constraint["scope"]
            if kind == "line_class_in":
                lower = [value.lower() for value in values]
                wanted_services = [service.lower() for service in scope.get("services") or []]
                for line in lines_by_sheet.get(sheet_id, []):
                    if line.line_type not in _PROCESS_LINE_TYPES or not line.line_number:
                        continue
                    if wanted_services and (line.service or "").lower() not in wanted_services:
                        continue
                    cls = (line.line_class or line.spec or "").lower()
                    if cls and cls in lower:
                        continue
                    key = f"requirement:{requirement_id}:{line.line_id}"
                    if (sheet_id, requirement_id, line.line_id) in covered_by_req_item:
                        continue
                    if (sheet_id, key) in covered_by_key:
                        continue
                    missing.add(sheet_id)
                    break
                if sheet_id in missing:
                    break
                continue

            for item in items_by_sheet.get(sheet_id, []):
                if item.kind not in {"symbol", "equipment"}:
                    continue
                if not _item_in_scope(item, scope, services_of):
                    continue
                if not item.part_id:
                    continue
                part = parts.get(item.part_id)
                if part is None:
                    continue
                if not _part_constraint_fails(kind, values, part):
                    continue
                key = f"requirement:{requirement_id}:{item.item_id}"
                if (sheet_id, requirement_id, item.item_id) in covered_by_req_item:
                    continue
                if (sheet_id, key) in covered_by_key:
                    continue
                missing.add(sheet_id)
                break
            if sheet_id in missing:
                break
    return missing


def sheet_drc(db: Session, sheet: DrawingSheet) -> dict:
    findings = list(
        db.scalars(
            select(DrcResult)
            .where(DrcResult.sheet_id == sheet.id)
            .order_by(DrcResult.severity, DrcResult.rule, DrcResult.subject)
        )
    )
    waivers = list(db.scalars(select(DrcWaiver).where(DrcWaiver.sheet_id == sheet.id)))
    checks = list(
        db.scalars(select(DrcRequirementCheck).where(DrcRequirementCheck.sheet_id == sheet.id))
    )
    waived_keys = {waiver.key for waiver in waivers}
    open_findings = [finding for finding in findings if finding.key not in waived_keys]
    counts = Counter(finding.severity for finding in open_findings)
    return {
        "sheet_id": sheet.id,
        "sheet_no": sheet.sheet_no,
        "index_stale": sheet.index_stale,
        "counts": {
            "error": counts.get("error", 0),
            "warning": counts.get("warning", 0),
            "info": counts.get("info", 0),
            "waived": len(findings) - len(open_findings),
        },
        "findings": findings,
        "waivers": waivers,
        "checks": checks,
    }


def drawing_drc(db: Session, drawing: Drawing) -> dict:
    sheets = [sheet_drc(db, sheet) for sheet in drawing.sheets]
    totals: Counter[str] = Counter()
    for entry in sheets:
        totals.update(entry["counts"])
    return {
        "drawing_id": drawing.id,
        "counts": {key: totals.get(key, 0) for key in ("error", "warning", "info", "waived")},
        "sheets": sheets,
    }


def verification_matrix(db: Session, project: Project) -> dict:
    """One row per requirement: constraint checks across the project's drawings and trace links."""
    requirements = list(
        db.scalars(
            select(Requirement)
            .where(Requirement.project_id == project.id)
            .order_by(Requirement.key)
        )
    )
    rows = []
    for requirement in requirements:
        checks = db.execute(
            select(DrcRequirementCheck, DrawingSheet, Drawing)
            .join(DrawingSheet, DrcRequirementCheck.sheet_id == DrawingSheet.id)
            .join(Drawing, DrawingSheet.drawing_id == Drawing.id)
            .where(
                DrcRequirementCheck.requirement_id == requirement.id,
                Drawing.project_id == project.id,
            )
            .order_by(Drawing.number, DrawingSheet.sheet_no)
        ).all()
        by_drawing: dict[str, dict] = {}
        for check, sheet, drawing in checks:
            entry = by_drawing.setdefault(
                drawing.id,
                {
                    "drawing_id": drawing.id,
                    "drawing_number": drawing.number,
                    "checked": 0,
                    "failed": 0,
                    "sheets": [],
                },
            )
            entry["checked"] += 1
            entry["failed"] += check.status == "fail"
            if sheet.sheet_no not in entry["sheets"]:
                entry["sheets"].append(sheet.sheet_no)
        links = list(
            db.scalars(
                select(TraceLink).where(
                    TraceLink.source_type == "requirement",
                    TraceLink.source_id == requirement.id,
                )
            )
        )
        checked = len(checks)
        failed = sum(1 for check, _, _ in checks if check.status == "fail")
        if requirement.constraint is None:
            verdict = "manual"
        elif checked == 0:
            verdict = "no_data"
        elif failed:
            verdict = "fail"
        else:
            verdict = "pass"
        rows.append(
            {
                "requirement_id": requirement.id,
                "key": requirement.key,
                "title": requirement.title,
                "status": requirement.status,
                "constraint": requirement.constraint,
                "checked": checked,
                "passed": checked - failed,
                "failed": failed,
                "verdict": verdict,
                "drawings": list(by_drawing.values()),
                "linked_components": sum(1 for link in links if link.target_type == "component"),
                "linked_drawings": sum(
                    1
                    for link in links
                    if link.target_type in {"drawing", "sheet_item", "sheet_line"}
                ),
                "failures": [check for check, _, _ in checks if check.status == "fail"],
            }
        )
    drawing_ids = db.scalars(select(Drawing.id).where(Drawing.project_id == project.id))
    return {"project_id": project.id, "rows": rows, "stale_sheets": stale_sheets(db, drawing_ids)}
