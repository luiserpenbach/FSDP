"""Per-project safety settings: rating scales, the risk matrix, the
fault-tolerance policy, operating modes, hazard categories, and flags.

Stored as one JSON row per project (``safety_settings``); missing keys fall
back to the defaults so older rows keep working when new keys are added."""

from __future__ import annotations

import copy
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Project, SafetySettings

SEVERITY_SCALE = [
    {"code": "I", "name": "Catastrophic", "description": "Death, loss of vehicle or facility."},
    {"code": "II", "name": "Critical", "description": "Severe injury, major damage."},
    {"code": "III", "name": "Marginal", "description": "Minor injury, minor damage."},
    {"code": "IV", "name": "Negligible", "description": "Less than minor injury or damage."},
]

LIKELIHOOD_SCALE = [
    {"code": "A", "name": "Frequent", "description": "Likely to occur often."},
    {"code": "B", "name": "Probable", "description": "Will occur several times."},
    {"code": "C", "name": "Occasional", "description": "Likely to occur sometime."},
    {"code": "D", "name": "Remote", "description": "Unlikely but possible."},
    {
        "code": "E",
        "name": "Improbable",
        "description": "So unlikely it can be assumed not to occur.",
    },
]

RISK_CLASSES = [
    {"code": "high", "name": "High"},
    {"code": "serious", "name": "Serious"},
    {"code": "medium", "name": "Medium"},
    {"code": "low", "name": "Low"},
]

# MIL-STD-882E style assignment: severity row, likelihood column.
RISK_MATRIX = {
    "I": {"A": "high", "B": "high", "C": "high", "D": "serious", "E": "medium"},
    "II": {"A": "high", "B": "high", "C": "serious", "D": "medium", "E": "low"},
    "III": {"A": "serious", "B": "serious", "C": "medium", "D": "medium", "E": "low"},
    "IV": {"A": "medium", "B": "medium", "C": "medium", "D": "low", "E": "low"},
}

HAZARD_CATEGORIES = [
    "overpressure",
    "backflow",
    "ignition",
    "contamination",
    "trapped_fluid",
    "cryogenic_exposure",
    "asphyxiation_toxic",
    "structural",
    "loss_of_isolation",
    "single_point_failure",
    "other",
]

OPERATING_MODES = [
    "standby",
    "chilldown",
    "slow_fill",
    "fast_fill",
    "topping",
    "hold",
    "drainback",
    "purge",
    "abort_safe",
]

DEFAULT_SAFETY_SETTINGS: dict[str, Any] = {
    "severity_scale": SEVERITY_SCALE,
    "likelihood_scale": LIKELIHOOD_SCALE,
    "risk_classes": RISK_CLASSES,
    "risk_matrix": RISK_MATRIX,
    # Independent controls required before a hazard counts as controlled.
    "fault_tolerance": {"I": 2, "II": 2, "III": 1, "IV": 1},
    "rpn_threshold": 100,
    "operating_modes": OPERATING_MODES,
    "hazard_categories": HAZARD_CATEGORIES,
    "auto_hazard": False,
    "default_hazard_severity": "I",
    "default_hazard_likelihood": "C",
    "approvers": [],
}


def normalize_settings(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Defaults merged with the stored row; unknown keys are dropped."""
    merged = copy.deepcopy(DEFAULT_SAFETY_SETTINGS)
    for key, value in (raw or {}).items():
        if key in merged and value is not None:
            merged[key] = value
    return merged


def get_settings(db: Session, project: Project) -> dict[str, Any]:
    row = db.scalar(select(SafetySettings).where(SafetySettings.project_id == project.id))
    return normalize_settings(row.settings if row else None)


def save_settings(db: Session, project: Project, settings: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_settings(settings)
    row = db.scalar(select(SafetySettings).where(SafetySettings.project_id == project.id))
    if row is None:
        row = SafetySettings(project_id=project.id, settings=normalized)
        db.add(row)
    else:
        row.settings = normalized
    db.flush()
    return normalized


def risk_class(
    settings: dict[str, Any], severity: str | None, likelihood: str | None
) -> str | None:
    if not severity or not likelihood:
        return None
    return settings.get("risk_matrix", {}).get(severity, {}).get(likelihood)


def fault_tolerance_for(settings: dict[str, Any], severity: str | None) -> int:
    policy = settings.get("fault_tolerance", {})
    try:
        return int(policy.get(severity or "", 1))
    except (TypeError, ValueError):
        return 1
