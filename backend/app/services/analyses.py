"""Engine-derived safety analyses over the stored sheet index: trapped
volumes, relief scenarios, single-point failures, fault tolerance, and
manual (attached) analyses. Every run stores its inputs, assumptions, and
the sheet hash it ran against so a later save can flag it outdated."""

from __future__ import annotations

import math
from collections import defaultdict, deque
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Analysis,
    Drawing,
    DrawingSheet,
    Hazard,
    Part,
    RequirementEvidence,
    SheetItem,
    SheetLine,
    SheetVolume,
)
from app.services.hazards import resolve_controls

# First-order liquid properties for trapped-volume heating: bulk modulus (bar)
# and volumetric thermal expansion (1/K). Values are representative and
# stored as assumptions with every run so a reviewer can override them.
FLUIDS: dict[str, dict[str, float]] = {
    "LOX": {"bulk_modulus_bar": 9000.0, "expansion_per_k": 0.0045, "liquid": 1},
    "LN2": {"bulk_modulus_bar": 5500.0, "expansion_per_k": 0.0060, "liquid": 1},
    "LCH4": {"bulk_modulus_bar": 6000.0, "expansion_per_k": 0.0035, "liquid": 1},
    "LH2": {"bulk_modulus_bar": 1000.0, "expansion_per_k": 0.0200, "liquid": 1},
    "RP-1": {"bulk_modulus_bar": 13000.0, "expansion_per_k": 0.00095, "liquid": 1},
    "WATER": {"bulk_modulus_bar": 22000.0, "expansion_per_k": 0.00021, "liquid": 1},
    "HYDRAULIC": {"bulk_modulus_bar": 15000.0, "expansion_per_k": 0.0007, "liquid": 1},
    "GHE": {"liquid": 0},
    "GN2": {"liquid": 0},
    "AIR": {"liquid": 0},
}

DEFAULT_ASSUMPTIONS: dict[str, dict[str, Any]] = {
    "trapped_volume": {
        "ambient_temperature_k": 293.15,
        "fill_temperature_k": 90.0,
        "fluids": FLUIDS,
    },
    "relief_scenario": {
        "scenario": "thermal_expansion",
        "heat_input_w_per_m": 20.0,
        "discharge_coefficient": 0.975,
        "overpressure_percent": 10.0,
    },
    "single_point_failure": {
        "source_categories": ["equipment"],
        "boundary_keys": ["quick_disconnect", "off_page_connector", "vent_atmosphere"],
    },
    "fault_tolerance": {},
    "manual": {},
}


def _parse_bar(value: str | None) -> float | None:
    if not value:
        return None
    text = str(value).lower().replace(",", ".")
    number = ""
    for char in text:
        if char.isdigit() or char in ".-":
            number += char
        elif number:
            break
    try:
        magnitude = float(number)
    except ValueError:
        return None
    if "psi" in text:
        return magnitude * 0.0689476
    if "kpa" in text:
        return magnitude / 100.0
    if "mpa" in text:
        return magnitude * 10.0
    return magnitude


def _sheet_context(db: Session, sheet: DrawingSheet) -> dict[str, Any]:
    items = list(db.scalars(select(SheetItem).where(SheetItem.sheet_id == sheet.id)))
    lines = list(db.scalars(select(SheetLine).where(SheetLine.sheet_id == sheet.id)))
    volumes = list(db.scalars(select(SheetVolume).where(SheetVolume.sheet_id == sheet.id)))
    parts = {}
    part_ids = {item.part_id for item in items if item.part_id}
    if part_ids:
        parts = {part.id: part for part in db.scalars(select(Part).where(Part.id.in_(part_ids)))}
    return {
        "items": {item.item_id: item for item in items},
        "lines": {line.line_id: line for line in lines},
        "volumes": volumes,
        "parts": parts,
    }


def _tags(context: dict[str, Any], item_ids: list[str]) -> list[str]:
    return [
        (context["items"][item_id].tag or item_id) if item_id in context["items"] else item_id
        for item_id in item_ids
    ]


# ---- runners ----


def run_trapped_volume(db: Session, sheet: DrawingSheet, scope: dict, assumptions: dict) -> dict:
    context = _sheet_context(db, sheet)
    fluids = {key.upper(): value for key, value in (assumptions.get("fluids") or FLUIDS).items()}
    ambient = float(assumptions.get("ambient_temperature_k", 293.15))
    fill = float(assumptions.get("fill_temperature_k", 90.0))
    rows = []
    unrelieved = 0
    for volume in context["volumes"]:
        if not volume.isolable:
            continue
        payload = volume.payload or {}
        service = (volume.service or "").upper()
        fluid = fluids.get(service, {})
        design_bar = _parse_bar(volume.design_pressure)
        temperature_rise_to_design = None
        liquid = bool(fluid.get("liquid"))
        if liquid and design_bar and fluid.get("bulk_modulus_bar") and fluid.get("expansion_per_k"):
            # dP = K * beta * dT for a liquid-full rigid volume: dT to reach design pressure.
            temperature_rise_to_design = round(
                design_bar / (fluid["bulk_modulus_bar"] * fluid["expansion_per_k"]), 1
            )
        available_rise = max(0.0, ambient - fill) if liquid else None
        exceeds = (
            temperature_rise_to_design is not None
            and available_rise is not None
            and available_rise > temperature_rise_to_design
        )
        if not volume.relieved:
            unrelieved += 1
        rows.append(
            {
                "volume_key": volume.key,
                "line_numbers": payload.get("line_numbers", []),
                "service": volume.service,
                "liquid": liquid,
                "isolating_tags": _tags(context, payload.get("isolating_item_ids", [])),
                "relief_tags": _tags(context, payload.get("relief_item_ids", [])),
                "relieved": volume.relieved,
                "length_m": volume.length_m,
                "design_pressure": volume.design_pressure,
                "design_pressure_bar": design_bar,
                "temperature_rise_to_design_k": temperature_rise_to_design,
                "available_temperature_rise_k": available_rise,
                "reaches_design_pressure_on_warm_up": exceeds,
                "verdict": "fail"
                if (not volume.relieved and (exceeds or liquid))
                else ("warn" if not volume.relieved else "pass"),
            }
        )
    verdict = (
        "fail"
        if any(row["verdict"] == "fail" for row in rows)
        else ("no_data" if not rows else "pass")
    )
    return {
        "verdict": verdict,
        "result": {
            "volumes": rows,
            "isolable_count": len(rows),
            "unrelieved_count": unrelieved,
            "method": (
                "Liquid-full rigid volume: dP = K * beta * dT. Temperature rise to reach design "
                "pressure compared with warm-up from fill temperature to ambient."
            ),
        },
    }


def run_relief_scenario(db: Session, sheet: DrawingSheet, scope: dict, assumptions: dict) -> dict:
    context = _sheet_context(db, sheet)
    volume_key = scope.get("volume_key")
    volume = next((v for v in context["volumes"] if v.key == volume_key), None)
    if volume is None:
        return {
            "verdict": "no_data",
            "result": {"message": "Pick an isolable volume in the scope."},
        }
    payload = volume.payload or {}
    scenario = assumptions.get("scenario", "thermal_expansion")
    design_bar = _parse_bar(volume.design_pressure)
    fluids = {key.upper(): value for key, value in (assumptions.get("fluids") or FLUIDS).items()}
    fluid = fluids.get((volume.service or "").upper(), {})
    length = float(volume.length_m or 0.0)
    heat = float(assumptions.get("heat_input_w_per_m", 20.0))
    required_kw = None
    required_kg_s = None
    notes = []
    if scenario == "thermal_expansion":
        # Heat leak drives boil-off / expansion; required relief in kg/s for a
        # cryogen uses a representative latent heat when the fluid is liquid.
        latent = {"LOX": 213.0, "LN2": 199.0, "LCH4": 511.0, "LH2": 446.0}.get(
            (volume.service or "").upper()
        )
        required_kw = round(heat * length / 1000.0, 3)
        if latent:
            required_kg_s = round(required_kw / latent, 5)
        else:
            notes.append("No latent heat for this service; capacity reported as heat input only.")
    elif scenario == "blocked_outlet":
        notes.append(
            "Blocked outlet: required capacity equals the maximum inflow; "
            "enter it in assumptions.inflow_kg_s."
        )
        required_kg_s = assumptions.get("inflow_kg_s")
    elif scenario == "regulator_failure":
        notes.append(
            "Regulator failure: required capacity is the wide-open regulator flow; "
            "enter assumptions.regulator_flow_kg_s."
        )
        required_kg_s = assumptions.get("regulator_flow_kg_s")
    elif scenario == "external_heat":
        fire_w_per_m = float(assumptions.get("fire_heat_w_per_m", 5000.0))
        required_kw = round(fire_w_per_m * length / 1000.0, 3)
        latent = {"LOX": 213.0, "LN2": 199.0, "LCH4": 511.0, "LH2": 446.0}.get(
            (volume.service or "").upper()
        )
        required_kg_s = round(required_kw / latent, 5) if latent else None
    installed = []
    for item_id in payload.get("relief_item_ids", []):
        item = context["items"].get(item_id)
        if item is None:
            continue
        part = context["parts"].get(item.part_id) if item.part_id else None
        metadata = (part.metadata_ if part is not None else None) or {}
        capacity = metadata.get("relief_capacity_kg_s") or (item.fields or {}).get(
            "relief_capacity_kg_s"
        )
        set_pressure = metadata.get("set_pressure_bar") or (item.fields or {}).get("set_pressure")
        installed.append(
            {
                "tag": item.tag or item_id,
                "part_number": part.part_number if part else None,
                "capacity_kg_s": float(capacity) if capacity not in (None, "") else None,
                "set_pressure": set_pressure,
            }
        )
    installed_total = sum(entry["capacity_kg_s"] or 0.0 for entry in installed)
    capacity_known = any(entry["capacity_kg_s"] is not None for entry in installed)
    if not installed:
        verdict = "fail"
        notes.append("No relief device on this volume.")
    elif required_kg_s is None:
        verdict = "no_data"
    elif not capacity_known:
        verdict = "no_data"
        notes.append("Relief capacity is not on the assigned part (metadata.relief_capacity_kg_s).")
    else:
        verdict = "pass" if installed_total >= float(required_kg_s) else "fail"
    return {
        "verdict": verdict,
        "result": {
            "volume_key": volume.key,
            "line_numbers": payload.get("line_numbers", []),
            "service": volume.service,
            "scenario": scenario,
            "design_pressure": volume.design_pressure,
            "design_pressure_bar": design_bar,
            "length_m": length,
            "required_kw": required_kw,
            "required_kg_s": required_kg_s,
            "installed": installed,
            "installed_total_kg_s": installed_total if capacity_known else None,
            "fluid": fluid,
            "notes": notes,
        },
    }


def run_single_point_failure(
    db: Session, sheet: DrawingSheet, scope: dict, assumptions: dict
) -> dict:
    """Items whose single failure removes every isolation between a pressure
    source and a boundary (quick disconnect, off-page connector, vent)."""
    context = _sheet_context(db, sheet)
    items = context["items"]
    lines = context["lines"]
    source_categories = set(assumptions.get("source_categories") or ["equipment"])
    boundary_keys = set(
        assumptions.get("boundary_keys")
        or ["quick_disconnect", "off_page_connector", "vent_atmosphere"]
    )
    source_ids = set(scope.get("source_item_ids") or []) | {
        item_id for item_id, item in items.items() if item.category in source_categories
    }
    boundary_ids = set(scope.get("boundary_item_ids") or []) | {
        item_id
        for item_id, item in items.items()
        if (item.symbol_key or "") in boundary_keys or (item.category == "connector")
    }
    isolating = {
        item_id for item_id, item in items.items() if item.category in {"valve", "regulator"}
    }
    graph: dict[str, set[str]] = defaultdict(set)
    for line in lines.values():
        if line.from_item and line.to_item:
            graph[line.from_item].add(line.to_item)
            graph[line.to_item].add(line.from_item)

    def reachable(blocked: set[str]) -> bool:
        seen: set[str] = set()
        queue: deque[str] = deque(source for source in source_ids if source not in blocked)
        while queue:
            node = queue.popleft()
            if node in seen:
                continue
            seen.add(node)
            if node in boundary_ids:
                return True
            for neighbour in graph[node]:
                if neighbour in blocked or neighbour in seen:
                    continue
                queue.append(neighbour)
        return False

    if not source_ids or not boundary_ids:
        return {
            "verdict": "no_data",
            "result": {
                "message": (
                    "No pressure source or boundary found on this sheet; "
                    "set scope.source_item_ids / boundary_item_ids."
                )
            },
        }
    # Baseline: every isolating item closed. Then reopen each one alone.
    baseline_isolated = not reachable(isolating)
    single_points = []
    for item_id in sorted(isolating):
        others = isolating - {item_id}
        if reachable(others):
            item = items[item_id]
            single_points.append(
                {"item_id": item_id, "tag": item.tag or item_id, "symbol": item.symbol_name}
            )
    verdict = "no_data" if not baseline_isolated else ("fail" if single_points else "pass")
    return {
        "verdict": verdict,
        "result": {
            "sources": _tags(context, sorted(source_ids)),
            "boundaries": _tags(context, sorted(boundary_ids)),
            "isolating": _tags(context, sorted(isolating)),
            "baseline_isolated": baseline_isolated,
            "single_points": single_points,
            "method": (
                "Graph of index lines between items; an isolating item is a single point "
                "when its failure alone reopens a path from a source to a boundary."
            ),
        },
    }


def run_fault_tolerance(
    db: Session, sheet: DrawingSheet | None, scope: dict, assumptions: dict, project_id: str
) -> dict:
    hazard_id = scope.get("hazard_id")
    hazard = db.get(Hazard, hazard_id) if hazard_id else None
    if hazard is None or hazard.project_id != project_id:
        return {"verdict": "no_data", "result": {"message": "Pick a hazard in the scope."}}
    controls = resolve_controls(db, hazard)
    volume_keys = set(hazard.volume_keys or [])
    groups: dict[str, list[dict]] = defaultdict(list)
    for control in controls:
        if control["type"] == "sheet_item":
            item = db.get(SheetItem, control["id"])
            key = (item.fields or {}).get("volume_key") if item else None
            groups[
                f"volume:{key}" if key and key in volume_keys else f"item:{control['id']}"
            ].append(control)
        else:
            groups[f"requirement:{control['id']}"].append(control)
    independent = len(groups)
    verified = sum(1 for control in controls if control["verification_status"] == "verified")
    required = hazard.fault_tolerance_required or 1
    return {
        "verdict": "pass"
        if independent >= required and verified == len(controls) and controls
        else "fail",
        "result": {
            "hazard_key": hazard.key,
            "required": required,
            "independent": independent,
            "controls": controls,
            "verified": verified,
            "groups": {key: [c["label"] for c in members] for key, members in groups.items()},
            "method": (
                "Controls on the same isolable volume count once; "
                "requirements count individually."
            ),
        },
    }


def run(db: Session, analysis: Analysis, actor: str | None) -> Analysis:
    sheet = db.get(DrawingSheet, analysis.sheet_id) if analysis.sheet_id else None
    scope = analysis.scope or {}
    assumptions = {**DEFAULT_ASSUMPTIONS.get(analysis.kind, {}), **(analysis.assumptions or {})}
    if analysis.kind == "manual":
        outcome = {"verdict": analysis.verdict or "info", "result": analysis.result or {}}
    elif analysis.kind == "fault_tolerance":
        outcome = run_fault_tolerance(db, sheet, scope, assumptions, analysis.project_id)
    elif sheet is None:
        outcome = {"verdict": "no_data", "result": {"message": "This analysis needs a sheet."}}
    elif analysis.kind == "trapped_volume":
        outcome = run_trapped_volume(db, sheet, scope, assumptions)
    elif analysis.kind == "relief_scenario":
        outcome = run_relief_scenario(db, sheet, scope, assumptions)
    elif analysis.kind == "single_point_failure":
        outcome = run_single_point_failure(db, sheet, scope, assumptions)
    else:
        outcome = {"verdict": "no_data", "result": {"message": f"Unknown kind {analysis.kind}"}}
    analysis.assumptions = assumptions
    analysis.result = outcome["result"]
    analysis.verdict = outcome["verdict"]
    analysis.sheet_hash = sheet.document_hash if sheet else None
    analysis.outdated = False
    analysis.run_by = actor
    analysis.run_at = datetime.now(UTC)
    db.flush()
    # Evidence attached to this analysis follows the verdict.
    for evidence in db.scalars(
        select(RequirementEvidence).where(
            RequirementEvidence.kind == "analysis", RequirementEvidence.ref_id == analysis.id
        )
    ):
        evidence.status = {"pass": "pass", "fail": "fail"}.get(analysis.verdict or "", "pending")
    db.flush()
    return analysis


def analysis_view(db: Session, analysis: Analysis) -> dict[str, Any]:
    view = {column.name: getattr(analysis, column.name) for column in Analysis.__table__.columns}
    sheet = db.get(DrawingSheet, analysis.sheet_id) if analysis.sheet_id else None
    drawing = db.get(Drawing, sheet.drawing_id) if sheet else None
    view.update(
        {
            "sheet_no": sheet.sheet_no if sheet else None,
            "drawing_id": drawing.id if drawing else None,
            "drawing_number": drawing.number if drawing else None,
            "evidence_for": [
                key
                for (key,) in db.execute(
                    select(RequirementEvidence.requirement_id).where(
                        RequirementEvidence.kind == "analysis",
                        RequirementEvidence.ref_id == analysis.id,
                    )
                )
            ],
        }
    )
    return view


def default_title(kind: str, sheet: DrawingSheet | None, drawing: Drawing | None) -> str:
    base = {
        "trapped_volume": "Trapped volumes",
        "relief_scenario": "Relief scenario",
        "single_point_failure": "Single-point failures",
        "fault_tolerance": "Fault tolerance",
        "manual": "Analysis",
    }.get(kind, kind)
    if drawing and sheet:
        return f"{base} · {drawing.number} sheet {sheet.sheet_no}"
    return base


def is_finite(value: Any) -> bool:
    return isinstance(value, int | float) and math.isfinite(value)
