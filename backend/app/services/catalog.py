from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import (
    CATALOG_SETTINGS_ID,
    DEFAULT_PART_TYPES,
    CatalogSettings,
    Part,
    Project,
)

LIFECYCLE_STATUSES = {"draft", "active", "legacy", "restricted", "obsolete"}
QUALIFICATION_STATUSES = {"unqualified", "in_qualification", "qualified", "disqualified"}
CERTIFICATION_STATUSES = {"unreviewed", "in_review", "certified", "rejected", "expired"}
SOURCE_TYPES = {"internal", "vendor", "custom"}
DOCUMENT_KINDS = {
    "datasheet",
    "drawing",
    "cad",
    "coc",
    "test_report",
    "memo",
    "photo",
    "other",
}
ALLOWED_DOCUMENT_SUFFIXES = {
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".step",
    ".stp",
    ".zip",
    ".xlsx",
    ".docx",
    ".txt",
    ".csv",
}
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024


def qualification_warnings(part: Part) -> list[str]:
    warnings: list[str] = []
    if part.lifecycle_status == "obsolete":
        warnings.append("Part is obsolete.")
    if part.lifecycle_status == "restricted":
        warnings.append("Part is restricted.")
    if part.lifecycle_status == "draft":
        warnings.append("Part is still a draft.")
    qualified = part.preferred or part.qualification_status in {"qualified", "preferred"}
    if not qualified:
        warnings.append("Part is not qualified or preferred.")
    if part.pressure_rating_bar is None:
        warnings.append("Pressure rating is missing.")
    if part.material is None:
        warnings.append("Material is missing.")
    return warnings


def ensure_catalog_settings(db: Session) -> CatalogSettings:
    row = db.get(CatalogSettings, CATALOG_SETTINGS_ID)
    if row is not None:
        if not row.part_types:
            row.part_types = list(DEFAULT_PART_TYPES)
        return row
    row = CatalogSettings(
        id=CATALOG_SETTINGS_ID,
        prefix="AMPH",
        sequence_padding=3,
        next_sequence=1,
        part_types=list(DEFAULT_PART_TYPES),
    )
    db.add(row)
    db.flush()
    return row


def remember_part_type(db: Session, part_type: str) -> None:
    cleaned = part_type.strip()
    if not cleaned:
        return
    row = ensure_catalog_settings(db)
    types = list(row.part_types or [])
    existing = {item.casefold() for item in types}
    if cleaned.casefold() not in existing:
        types.append(cleaned)
        row.part_types = types


def _format_part_name(prefix: str, sequence: int, padding: int) -> str:
    width = max(1, min(padding, 8))
    return f"{prefix}-{sequence:0{width}d}"


def generate_part_name(db: Session, project_id: str | None = None) -> str:
    """Allocate the next `{prefix}-{seq}` name. Caller must commit."""
    catalog = ensure_catalog_settings(db)
    padding = catalog.sequence_padding
    prefix = catalog.prefix.strip() or "AMPH"
    sequence_holder: CatalogSettings | Project = catalog
    next_value = catalog.next_sequence

    if project_id:
        project = db.get(Project, project_id)
        if project is not None and project.part_name_prefix and project.part_name_prefix.strip():
            prefix = project.part_name_prefix.strip()
            sequence_holder = project
            next_value = project.part_name_next_sequence

    sequence = max(1, next_value)
    name = _format_part_name(prefix, sequence, padding)
    while db.scalar(select(Part.id).where(Part.part_number == name)):
        sequence += 1
        name = _format_part_name(prefix, sequence, padding)

    if isinstance(sequence_holder, Project):
        sequence_holder.part_name_next_sequence = sequence + 1
    else:
        sequence_holder.next_sequence = sequence + 1
    return name


def catalog_files_root() -> Path:
    path = Path(settings.catalog_files_dir)
    if not path.is_absolute():
        path = Path.cwd() / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def sanitize_upload_filename(filename: str) -> str:
    name = Path(filename or "upload").name
    name = re.sub(r"[^\w.\-]+", "_", name).strip("._") or "upload"
    return name[:200]


def document_suffix_allowed(filename: str) -> bool:
    return Path(filename).suffix.lower() in ALLOWED_DOCUMENT_SUFFIXES
