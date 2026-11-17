"""Server-side sheet index and DRC: the browser's engine, run under Node.

The index rows and DRC results of a sheet are computed by the TypeScript engine
(`frontend/src/engine`). The browser sends them with every save; this module lets
the server refresh a stale sheet itself by running the same engine, bundled as a
single-file CLI (`npm run build:engine`, `FSDP_ENGINE_CLI`). It gathers what the
browser would hold (the drawing's sheet documents, the project's tag scheme and
requirements, the assigned parts, the custom symbols used, the sheet's waivers),
pipes one JSON request to the CLI, validates the result through the same schemas
as `PUT /sheets/{id}`, and stores it with the same functions.

Nothing here runs unless `settings.engine_cli` is set; without it sheets are
refreshed by the Drafting page only, as before.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db as app_db
from app.core.config import settings
from app.models import (
    ChangeEvent,
    Drawing,
    DrawingSheet,
    DrcWaiver,
    Part,
    PidSymbolDef,
    Requirement,
    TagScheme,
)
from app.schemas import DrcIn, SheetIndexIn
from app.services.drc import replace_sheet_drc
from app.services.sheet_index import replace_sheet_index

logger = logging.getLogger(__name__)

# Protocol version of frontend/src/engine/engineRequest.ts this module speaks.
ENGINE_PROTOCOL = 1
# Largest request piped to the CLI. A drawing's documents are a few hundred kB each.
MAX_REQUEST_BYTES = 32 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
# Drawings re-indexed by one background task (part or requirement changes can flag many).
MAX_BACKGROUND_DRAWINGS = 50
_STDERR_TAIL = 2000

# One Node process at a time per API process: requests and background tasks queue here.
_engine_lock = threading.Lock()


class EngineNotConfigured(RuntimeError):
    """`FSDP_ENGINE_CLI` is empty: the server cannot index sheets."""


class EngineError(RuntimeError):
    """The engine run failed as a whole (missing bundle, timeout, crash, bad output)."""


def engine_enabled() -> bool:
    return bool(settings.engine_cli.strip())


def engine_status() -> dict:
    """Whether the server can re-index sheets, for the UI and for operators."""
    enabled = engine_enabled()
    return {
        "enabled": enabled,
        "available": enabled and Path(settings.engine_cli.strip()).is_file(),
    }


def _tail(raw: bytes | None) -> str:
    return (raw or b"").decode("utf-8", errors="replace").strip()[-_STDERR_TAIL:]


def run_engine(request: dict) -> dict[str, dict]:
    """Run the engine CLI on one request; returns its per-sheet results by sheet id.

    The CLI is started directly (argument list, no shell) with the request on stdin,
    a minimal environment (it needs none of the API's secrets), and a timeout. Any
    failure of the run as a whole raises `EngineError` with stderr in the message.
    """
    if not engine_enabled():
        raise EngineNotConfigured("The sheet engine is not configured (FSDP_ENGINE_CLI).")
    cli = Path(settings.engine_cli.strip())
    if not cli.is_file():
        raise EngineError(f"Engine bundle not found at {cli}")
    payload = json.dumps(request, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_REQUEST_BYTES:
        raise EngineError(
            f"Engine request is {len(payload)} bytes; the limit is {MAX_REQUEST_BYTES}"
        )
    command = [settings.engine_node, str(cli)]
    try:
        with _engine_lock:
            completed = subprocess.run(
                command,
                input=payload,
                capture_output=True,
                timeout=settings.engine_timeout_seconds,
                check=False,
                env={"PATH": os.environ.get("PATH", ""), "NODE_OPTIONS": ""},
            )
    except subprocess.TimeoutExpired as exc:
        logger.warning("Engine timed out after %ss: %s", exc.timeout, _tail(exc.stderr))
        raise EngineError(f"Engine timed out after {settings.engine_timeout_seconds:g} s") from exc
    except OSError as exc:
        logger.warning("Engine could not be started (%s): %s", command[0], exc)
        raise EngineError(f"Engine could not be started ({command[0]}): {exc}") from exc
    stderr = _tail(completed.stderr)
    if completed.returncode != 0:
        logger.warning("Engine exited with %s: %s", completed.returncode, stderr)
        detail = f": {stderr}" if stderr else ""
        raise EngineError(f"Engine exited with code {completed.returncode}{detail}")
    if stderr:
        logger.info("Engine stderr: %s", stderr)
    if len(completed.stdout) > MAX_RESPONSE_BYTES:
        raise EngineError("Engine output is too large")
    try:
        response = json.loads(completed.stdout)
    except ValueError as exc:
        logger.warning("Engine output is not JSON: %r", completed.stdout[:200])
        raise EngineError("Engine output is not valid JSON") from exc
    results = response.get("results") if isinstance(response, dict) else None
    if not isinstance(results, list) or response.get("protocol") != ENGINE_PROTOCOL:
        raise EngineError("Engine output has an unexpected shape (bundle out of date?)")
    by_sheet: dict[str, dict] = {}
    for result in results:
        if isinstance(result, dict) and isinstance(result.get("sheetId"), str):
            by_sheet[result["sheetId"]] = result
    return by_sheet


# --- Gathering the inputs -----------------------------------------------------------


def _referenced(documents: list[dict]) -> tuple[set[str], set[str]]:
    """Part ids assigned and custom symbol ids used by the items of the documents."""
    part_ids: set[str] = set()
    symbol_ids: set[str] = set()
    for document in documents:
        items = document.get("items") if isinstance(document, dict) else None
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("partId"), str):
                part_ids.add(item["partId"])
            for ref in (item.get("symbol"), item.get("actuator")):
                if (
                    isinstance(ref, dict)
                    and ref.get("library") == "custom"
                    and isinstance(ref.get("key"), str)
                ):
                    symbol_ids.add(ref["key"])
    return part_ids, symbol_ids


def _context(db: Session, project_id: str, documents: list[dict]) -> dict:
    """The project context of an engine request, as the browser holds it."""
    part_ids, symbol_ids = _referenced(documents)
    symbols = (
        db.scalars(select(PidSymbolDef).where(PidSymbolDef.id.in_(symbol_ids)))
        if symbol_ids
        else []
    )
    parts = db.scalars(select(Part).where(Part.id.in_(part_ids))) if part_ids else []
    scheme = db.scalar(select(TagScheme).where(TagScheme.project_id == project_id))
    requirements = db.scalars(select(Requirement).where(Requirement.project_id == project_id))
    return {
        "customSymbols": [
            {
                "id": symbol.id,
                "name": symbol.name,
                "view_box": symbol.view_box,
                # The markup is only painted; the index and DRC read ports and metadata.
                "svg": "",
                "ports": symbol.ports or [],
                "category": symbol.category,
                "legend": symbol.legend,
                "tag_prefix": symbol.tag_prefix,
            }
            for symbol in symbols
        ],
        "tagScheme": scheme.scheme if scheme else None,
        "parts": [
            {
                "id": part.id,
                "part_number": part.part_number,
                "description": part.description,
                "part_type": part.part_type,
                "material": part.material,
                "pressure_rating_bar": part.pressure_rating_bar,
                "lifecycle_status": part.lifecycle_status,
                "qualification_status": part.qualification_status,
                "preferred": part.preferred,
            }
            for part in parts
        ],
        "requirements": [
            {
                "id": requirement.id,
                "key": requirement.key,
                "title": requirement.title,
                "constraint": requirement.constraint,
            }
            for requirement in requirements
        ],
    }


# --- Re-indexing ----------------------------------------------------------------------


@dataclass
class ReindexReport:
    """What a re-index run did, sheet by sheet."""

    drawings: int = 0
    stale: int = 0
    indexed: int = 0
    skipped: int = 0
    failed: int = 0
    errors: list[dict] = field(default_factory=list)

    def add_error(self, drawing: Drawing, sheet: DrawingSheet, message: str) -> None:
        self.failed += 1
        self.errors.append(
            {
                "sheet_id": sheet.id,
                "sheet_no": sheet.sheet_no,
                "drawing_id": drawing.id,
                "drawing_number": drawing.number,
                "message": message,
            }
        )

    def as_dict(self) -> dict:
        return {
            "drawings": self.drawings,
            "stale": self.stale,
            "indexed": self.indexed,
            "skipped": self.skipped,
            "failed": self.failed,
            "errors": self.errors,
        }


def _validation_message(exc: ValidationError) -> str:
    first = exc.errors()[0]
    where = ".".join(str(part) for part in first.get("loc", ()))
    return f"Engine result failed validation at {where}: {first.get('msg', '')}"


def reindex_drawing(
    db: Session,
    drawing_id: str,
    *,
    actor: str | None = None,
    report: ReindexReport | None = None,
) -> ReindexReport:
    """Re-index every stale sheet of an unreleased drawing with the engine.

    Commits its own work. A sheet is written only if, at write time, it is still
    stale and it, its document, and the documents of its sibling sheets are what
    the engine was given; otherwise something else (a browser save, a part or
    requirement change) got there first and the sheet is left to that writer or to
    the next run. Released drawings are frozen baselines and are never touched.
    """
    report = report if report is not None else ReindexReport()
    drawing = db.get(Drawing, drawing_id)
    if drawing is None or drawing.status == "released":
        return report
    sheets = list(
        db.scalars(
            select(DrawingSheet)
            .where(DrawingSheet.drawing_id == drawing_id)
            .order_by(DrawingSheet.sheet_no)
        )
    )
    targets = [sheet for sheet in sheets if sheet.index_stale]
    if not targets:
        return report
    report.drawings += 1
    report.stale += len(targets)

    # What the engine is given, to compare against at write time.
    given_documents = {sheet.id: sheet.document or {} for sheet in sheets}
    given_stamps = {sheet.id: sheet.updated_at for sheet in targets}
    waivers: dict[str, list[dict]] = {sheet.id: [] for sheet in targets}
    for waiver in db.scalars(select(DrcWaiver).where(DrcWaiver.sheet_id.in_(list(waivers)))):
        waivers[waiver.sheet_id].append({"key": waiver.key, "reason": waiver.reason})
    request = {
        "context": _context(db, drawing.project_id, list(given_documents.values())),
        "drawings": [
            {
                "frameTemplate": drawing.frame_template,
                "sheets": [
                    {
                        "sheetId": sheet.id,
                        "sheetNo": sheet.sheet_no,
                        "document": given_documents[sheet.id],
                        "waivers": waivers.get(sheet.id, []),
                        "compute": sheet.id in waivers,
                    }
                    for sheet in sheets
                ],
            }
        ],
    }
    target_ids = list(given_stamps)
    number = drawing.number
    # Do not hold a transaction (or row locks) open while Node runs.
    db.rollback()

    try:
        results = run_engine(request)
    except EngineNotConfigured:
        raise
    except EngineError as exc:
        for sheet in db.scalars(select(DrawingSheet).where(DrawingSheet.id.in_(target_ids))):
            report.add_error(drawing, sheet, str(exc))
        db.rollback()
        return report

    # Write under row locks so a concurrent save or release is either seen here or waits.
    drawing = db.scalar(
        select(Drawing)
        .where(Drawing.id == drawing_id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    if drawing is None or drawing.status == "released":
        report.skipped += len(target_ids)
        db.rollback()
        return report
    current = {
        sheet.id: sheet
        for sheet in db.scalars(
            select(DrawingSheet)
            .where(DrawingSheet.drawing_id == drawing_id)
            .order_by(DrawingSheet.sheet_no)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
    }
    siblings_unchanged = set(current) == set(given_documents) and all(
        (sheet.document or {}) == given_documents[sheet_id] for sheet_id, sheet in current.items()
    )
    written: list[int] = []
    for sheet_id in target_ids:
        sheet = current.get(sheet_id)
        if sheet is None:
            report.skipped += 1
            continue
        if (
            not sheet.index_stale
            or sheet.updated_at != given_stamps[sheet_id]
            or not siblings_unchanged
        ):
            # Saved, re-flagged, or the drawing changed while the engine ran.
            report.skipped += 1
            continue
        result = results.get(sheet_id)
        if result is None or not result.get("ok"):
            message = (result or {}).get("error") or "Engine returned no result for the sheet"
            report.add_error(drawing, sheet, str(message))
            continue
        try:
            index = SheetIndexIn.model_validate(result.get("index"))
            drc = DrcIn.model_validate(result.get("drc"))
        except ValidationError as exc:
            report.add_error(drawing, sheet, _validation_message(exc))
            continue
        replace_sheet_index(db, sheet, index)
        replace_sheet_drc(db, sheet, drc)
        # As update_sheet: the engine indexed and checked exactly this document.
        sheet.index_stale = False
        sheet.indexed_at = datetime.now(UTC)
        written.append(sheet.sheet_no)
        report.indexed += 1
    if written:
        names = ", ".join(str(sheet_no) for sheet_no in written)
        db.add(
            ChangeEvent(
                object_type="drawing",
                object_id=drawing_id,
                action="updated",
                summary=f"Re-indexed sheet {names} of {number} on the server",
                actor=actor,
                # Background runs have no request to take the project from.
                project_id=db.scalar(select(Drawing.project_id).where(Drawing.id == drawing_id)),
            )
        )
    db.commit()
    return report


def stale_drawing_ids(
    db: Session, *, project_id: str | None = None, drawing_ids: list[str] | None = None
) -> list[str]:
    """Unreleased drawings (of a project, or among the given ones) with a stale sheet."""
    query = (
        select(Drawing.id)
        .join(DrawingSheet, DrawingSheet.drawing_id == Drawing.id)
        .where(Drawing.status != "released", DrawingSheet.index_stale.is_(True))
        .group_by(Drawing.id, Drawing.number)
        .order_by(Drawing.number)
    )
    if project_id is not None:
        query = query.where(Drawing.project_id == project_id)
    if drawing_ids is not None:
        query = query.where(Drawing.id.in_(drawing_ids))
    return list(db.scalars(query))


def reindex_drawings(
    db: Session, drawing_ids: list[str], *, actor: str | None = None
) -> ReindexReport:
    """Re-index the stale sheets of the given drawings, one engine run per drawing."""
    if not engine_enabled():
        raise EngineNotConfigured("The sheet engine is not configured (FSDP_ENGINE_CLI).")
    report = ReindexReport()
    for drawing_id in drawing_ids:
        reindex_drawing(db, drawing_id, actor=actor, report=report)
    return report


def reindex_project(db: Session, project_id: str, *, actor: str | None = None) -> ReindexReport:
    """Re-index every stale sheet of the project's unreleased drawings."""
    return reindex_drawings(db, stale_drawing_ids(db, project_id=project_id), actor=actor)


# --- Background -----------------------------------------------------------------------


def reindex_in_background(drawing_ids: list[str], actor: str | None = None) -> None:
    """Background task: re-index the given drawings in a session of its own.

    Best effort: any failure is logged and leaves the sheets stale, to be picked up
    by the Drafting page or `POST /projects/{id}/reindex` as before.
    """
    if not engine_enabled() or not drawing_ids:
        return
    try:
        with app_db.SessionLocal() as db:
            ids = stale_drawing_ids(db, drawing_ids=drawing_ids)[:MAX_BACKGROUND_DRAWINGS]
            report = reindex_drawings(db, ids, actor=actor)
        if report.failed:
            logger.warning("Background re-index left sheets stale: %s", report.errors)
    except Exception:  # a background task must never raise
        logger.exception("Background re-index failed for drawings %s", drawing_ids)


def schedule_reindex(
    background_tasks: Any, drawing_ids: list[str], actor: str | None = None
) -> None:
    """Queue a re-index of the drawings after the response, when the engine is configured."""
    if engine_enabled() and drawing_ids:
        background_tasks.add_task(reindex_in_background, list(drawing_ids), actor)
