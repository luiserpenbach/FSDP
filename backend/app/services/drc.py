"""Design rule check storage: findings and requirement checks replaced on save,
waivers kept by finding key, drawing summaries, and the verification matrix."""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Drawing,
    DrawingSheet,
    DrcRequirementCheck,
    DrcResult,
    DrcWaiver,
    Project,
    Requirement,
    SheetItem,
    SheetLine,
    TraceLink,
)
from app.schemas import DrcIn
from app.services.sheet_index import stale_sheets

# Mirrors frontend/src/engine/drc.ts isolableVolumes classification.
_PROCESS_LINE_TYPES = frozenset({"process", "vacuum", "capillary"})
_ISOLATING_CATEGORIES = frozenset({"valve", "regulator"})
_RELIEF_KEYS = frozenset({"relief_valve", "safety_valve", "rupture_disc"})
_OPEN_KEYS = frozenset({"vent_atmosphere", "drain"})


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


class _UnionFind:
    def __init__(self) -> None:
        self._parent: dict[str, str] = {}

    def find(self, key: str) -> str:
        root = key
        while self._parent.get(root, root) != root:
            root = self._parent[root]
        self._parent[key] = root
        return root

    def union(self, left: str, right: str) -> None:
        a = self.find(left)
        b = self.find(right)
        if a != b:
            self._parent[a] = b


def _item_role(item: SheetItem) -> str:
    """Classify an index item the way the browser DRC classifies symbols."""
    key = item.symbol_key or ""
    if key in _RELIEF_KEYS:
        return "relief"
    if key in _OPEN_KEYS:
        return "open"
    if (item.category or "") in _ISOLATING_CATEGORIES:
        return "isolating"
    return "pass"


def _unrelieved_isolable_line_ids(
    items: list[SheetItem], lines: list[SheetLine]
) -> list[str]:
    """Representative line_id per unrelieved isolable volume approximated from the index.

    Uses sheet_lines.from_item/to_item and sheet_items.category/symbol_key to mirror
    `isolableVolumes` well enough that a Save which omits live `relief_required`
    failures cannot clear `index_stale`. Returns the first line_id of each failing
    volume (sorted), matching the browser finding subject.
    """
    by_id = {item.item_id: item for item in items}
    process_lines = [line for line in lines if line.line_type in _PROCESS_LINE_TYPES]
    if not process_lines:
        return []

    line_ids = {line.line_id for line in process_lines}
    lines_by_item: dict[str, list[str]] = defaultdict(list)
    union = _UnionFind()
    for line in process_lines:
        union.find(line.line_id)
        for endpoint in (line.from_item, line.to_item):
            if not endpoint:
                continue
            if endpoint in line_ids:
                union.union(line.line_id, endpoint)
            else:
                lines_by_item[endpoint].append(line.line_id)

    for item_id, touched in lines_by_item.items():
        item = by_id.get(item_id)
        if item is None or _item_role(item) != "pass":
            continue
        for other in touched[1:]:
            union.union(touched[0], other)

    groups: dict[str, dict[str, set[str]]] = {}
    for line in process_lines:
        root = union.find(line.line_id)
        group = groups.setdefault(root, {"lines": set(), "items": set()})
        group["lines"].add(line.line_id)
        for endpoint in (line.from_item, line.to_item):
            if endpoint and endpoint not in line_ids:
                group["items"].add(endpoint)

    failing: list[str] = []
    for group in groups.values():
        roles = [_item_role(by_id[item_id]) for item_id in group["items"] if item_id in by_id]
        isolable = any(role == "isolating" for role in roles) and not any(
            role == "open" for role in roles
        )
        relieved = any(role == "relief" for role in roles)
        if isolable and not relieved:
            failing.append(sorted(group["lines"])[0])
    return failing


def sheets_missing_relief_requirement_findings(
    db: Session, sheet_ids: Iterable[str]
) -> set[str]:
    """Sheet ids whose stored DRC omits a live `relief_required` failure.

    `PUT /sheets` trusts the client index+DRC pair and clears `index_stale`.
    Creating or rewriting a `relief_required` constraint marks sheets stale, but a
    Save derived against a stale requirements catalog (or one that raced the
    write) can omit the new geometry-backed `requirement` errors, leave the sheet
    looking fresh, and let Release freeze an unrelieved isolable volume into the
    immutable revision snapshot. Open #81 re-checks index-evaluable kinds only and
    explicitly skips `relief_required`; this closes that residual.
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
    relief_by_project: dict[str, list[str]] = defaultdict(list)
    for requirement in db.scalars(
        select(Requirement).where(
            Requirement.project_id.in_(project_ids),
            Requirement.constraint.is_not(None),
        )
    ):
        constraint = requirement.constraint
        if not isinstance(constraint, dict) or constraint.get("kind") != "relief_required":
            continue
        relief_by_project[requirement.project_id].append(requirement.id)
    if not any(relief_by_project.values()):
        return set()

    items = list(db.scalars(select(SheetItem).where(SheetItem.sheet_id.in_(ids))))
    lines = list(db.scalars(select(SheetLine).where(SheetLine.sheet_id.in_(ids))))
    items_by_sheet: dict[str, list[SheetItem]] = defaultdict(list)
    lines_by_sheet: dict[str, list[SheetLine]] = defaultdict(list)
    for item in items:
        items_by_sheet[item.sheet_id].append(item)
    for line in lines:
        lines_by_sheet[line.sheet_id].append(line)

    covered = {
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
    covered_keys = {
        (sheet_id, key)
        for sheet_id, key in db.execute(
            select(DrcResult.sheet_id, DrcResult.key).where(
                DrcResult.sheet_id.in_(ids),
                DrcResult.rule == "requirement",
                DrcResult.severity == "error",
            )
        )
    }

    missing: set[str] = set()
    for sheet_id, project_id in sheet_project.items():
        req_ids = relief_by_project.get(project_id) or []
        if not req_ids:
            continue
        failing_lines = _unrelieved_isolable_line_ids(
            items_by_sheet.get(sheet_id, []), lines_by_sheet.get(sheet_id, [])
        )
        if not failing_lines:
            continue
        for requirement_id in req_ids:
            for line_id in failing_lines:
                if (sheet_id, requirement_id, line_id) in covered:
                    continue
                prefix = f"requirement:{requirement_id}:{line_id}"
                # Tip keys are `requirement:{id}:{line}`; #71 may append a
                # constraint fingerprint after another colon.
                if any(
                    key == prefix or key.startswith(prefix + ":")
                    for sid, key in covered_keys
                    if sid == sheet_id
                ):
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
