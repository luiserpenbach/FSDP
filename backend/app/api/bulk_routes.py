"""Bulk import, bulk edit and bulk delete for the parts catalog and project requirements.

Imports accept an uploaded .csv/.xlsx file (multipart field `file`), a raw CSV body
(text/csv), or JSON rows sent after a paste from Excel. Every import is planned
row by row first (see app.services.bulk_import); `dry_run=true` (the default)
returns that plan, `dry_run=false` applies it all or nothing.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.drawing_routes import import_line_classes
from app.api.routes import record_change, require_model
from app.core.security import require_writer
from app.db import get_db
from app.models import (
    CatalogDocument,
    ComponentInstance,
    Part,
    Project,
    Requirement,
    SheetItem,
    User,
)
from app.schemas import LineClassImportIn, LineClassImportRead, PartRead, RequirementRead
from app.services.bulk_import import (
    MAX_IMPORT_BYTES,
    PART_SPEC,
    REQUIREMENT_SPEC,
    EntitySpec,
    ImportFormatError,
    ImportMode,
    ImportPlan,
    Table,
    current_value,
    plan_import,
    table_from_json,
    table_from_upload,
    table_to_csv,
    template_csv,
    template_xlsx,
    validate_bulk_changes,
)
from app.services.catalog import catalog_files_root, remember_part_type
from app.services.sheet_index import mark_project_sheets_stale, mark_sheets_stale_for_part
from app.services.traceability import delete_trace_links_for

bulk_router = APIRouter()

MAX_BULK_IDS = 1000
# Multipart framing around the file; the file itself is held to MAX_IMPORT_BYTES.
_MULTIPART_OVERHEAD = 64 * 1024


# --------------------------------------------------------------------------- schemas


class ImportRowsIn(BaseModel):
    """Rows pasted from a spreadsheet.

    Either `rows` as lists of cells with `headers` (or with the header as the first
    row), or `rows` as objects keyed by column header.
    """

    headers: list[str] | None = None
    rows: list[list[Any]] | list[dict[str, Any]]
    # Cells use a decimal comma (2,5 = 2.5), as pasted from a European-locale Excel.
    decimal_comma: bool = False


class ImportCellError(BaseModel):
    field: str
    message: str


class ImportRowRead(BaseModel):
    row: int
    action: Literal["create", "update", "unchanged", "error"]
    key: str | None
    id: str | None = None
    errors: list[ImportCellError]
    changes: dict[str, list[Any]]


class ImportSummary(BaseModel):
    create: int
    update: int
    unchanged: int
    error: int


class ImportReport(BaseModel):
    entity: Literal["part", "requirement"]
    mode: ImportMode
    dry_run: bool
    committed: bool
    mapping: dict[str, str | None]
    warnings: list[str]
    rows: list[ImportRowRead]
    summary: ImportSummary


class BulkIdsIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=MAX_BULK_IDS)


class BulkUpdateIn(BulkIdsIn):
    changes: dict[str, Any]


class PartBulkUpdateRead(BaseModel):
    updated: int
    unchanged: int
    items: list[PartRead]


class RequirementBulkUpdateRead(BaseModel):
    updated: int
    unchanged: int
    items: list[RequirementRead]


class BulkDeleteResult(BaseModel):
    id: str
    deleted: bool
    reason: str | None = None


class BulkDeleteRead(BaseModel):
    deleted: int
    refused: int
    results: list[BulkDeleteResult]


_IMPORT_OPENAPI = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "properties": {"file": {"type": "string", "format": "binary"}},
                    "required": ["file"],
                }
            },
            "application/json": {"schema": ImportRowsIn.model_json_schema()},
            "text/csv": {"schema": {"type": "string"}},
        },
    }
}


# --------------------------------------------------------------------------- reading


def _too_large() -> HTTPException:
    return HTTPException(
        status_code=413,
        detail=f"Import is larger than {MAX_IMPORT_BYTES // (1024 * 1024)} MB; split it up",
    )


async def _read_body(request: Request, limit: int) -> bytes:
    """Read the request body, refusing it as soon as it passes `limit` bytes."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise _too_large()
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise _too_large()
    return bytes(body)


async def _read_upload(request: Request, body: bytes) -> tuple[str, bytes]:
    sent = False

    async def receive() -> dict[str, Any]:
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    form = await Request(request.scope, receive).form(max_files=1, max_fields=10)
    try:
        upload = form.get("file")
        if upload is None or isinstance(upload, str):
            raise HTTPException(status_code=422, detail="Send the table as the 'file' form field")
        return upload.filename or "", await upload.read()
    finally:
        await form.close()


async def _read_table(request: Request, key_aliases: set[str]) -> tuple[Table, str]:
    """The table to import and a label for the change log (file name or 'pasted rows')."""
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    try:
        if content_type == "multipart/form-data":
            body = await _read_body(request, MAX_IMPORT_BYTES + _MULTIPART_OVERHEAD)
            filename, content = await _read_upload(request, body)
            if len(content) > MAX_IMPORT_BYTES:
                raise _too_large()
            if not content.strip():
                raise HTTPException(status_code=422, detail="File is empty")
            return table_from_upload(content, filename, key_aliases), filename or "upload"
        if content_type in {"text/csv", "text/plain", "text/tab-separated-values"}:
            content = await _read_body(request, MAX_IMPORT_BYTES)
            return table_from_upload(content, "upload.csv", key_aliases), "CSV text"
        if content_type in {"application/json", ""}:
            body = await _read_body(request, MAX_IMPORT_BYTES)
            try:
                payload = ImportRowsIn.model_validate_json(body or b"{}")
            except ValidationError as exc:
                errors = exc.errors(include_url=False, include_context=False, include_input=False)
                raise HTTPException(status_code=422, detail=jsonable_encoder(errors)) from exc
            table = table_from_json(payload.headers, payload.rows, payload.decimal_comma)
            return table, "pasted rows"
    except ImportFormatError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    raise HTTPException(
        status_code=415,
        detail="Send a multipart upload (field 'file'), text/csv, or JSON rows",
    )


# --------------------------------------------------------------------------- import


def _run_import(
    db: Session,
    spec: EntitySpec,
    table: Table,
    mode: ImportMode,
    dry_run: bool,
    actor: str,
    source: str,
    project_id: str | None = None,
) -> dict | JSONResponse:
    try:
        plan = plan_import(db, spec, table, mode, project_id=project_id)
    except ImportFormatError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if dry_run:
        return jsonable_encoder(plan.report(dry_run=True, committed=False))
    if plan.has_errors:
        # All or nothing: one bad row and nothing is written.
        report = plan.report(dry_run=False, committed=False)
        return JSONResponse(status_code=422, content=jsonable_encoder(report))
    _commit_plan(db, plan, actor, source)
    return jsonable_encoder(plan.report(dry_run=False, committed=True))


def _commit_plan(db: Session, plan: ImportPlan, actor: str, source: str) -> None:
    spec = plan.spec
    is_part = spec is PART_SPEC
    project_stale = False
    for row in plan.rows:
        if row.action == "create":
            data = dict(row.create_data or {})
            if is_part:
                data["metadata_"] = data.pop("metadata")
            obj = spec.model(**data)
            db.add(obj)
            row.target = obj
            if is_part:
                remember_part_type(db, obj.part_type)
            elif obj.constraint is not None:
                # Requirement checks run inside the drawing DRC (as single create).
                project_stale = True
        elif row.action == "update":
            obj = row.target
            had_constraint = not is_part and obj.constraint is not None
            for name, (_old, new) in row.changes.items():
                setattr(obj, "metadata_" if name == "metadata" else name, new)
            if is_part:
                if "part_type" in row.changes:
                    remember_part_type(db, obj.part_type)
                # Ratings, material and lifecycle feed the DRC of sheets using the part.
                mark_sheets_stale_for_part(db, obj.id)
            elif had_constraint or obj.constraint is not None:
                project_stale = True
    db.flush()

    counts = plan.summary()
    for row in plan.rows:
        if row.action not in {"create", "update"}:
            continue
        verb = "created" if row.action == "create" else "updated"
        key = getattr(row.target, spec.key_field)
        record_change(
            db,
            spec.entity,
            row.target.id,
            verb,
            f"{verb.capitalize()} {spec.entity} {key} (import from {source})",
            actor=actor,
        )
    if project_stale and plan.project_id is not None:
        mark_project_sheets_stale(db, plan.project_id)
    if counts["create"] or counts["update"]:
        summary = (
            f"Imported {spec.label} from {source}: {counts['create']} created, "
            f"{counts['update']} updated, {counts['unchanged']} unchanged"
        )
        if is_part:
            record_change(db, "catalog", "parts", "imported", summary, actor=actor)
        else:
            record_change(db, "project", plan.project_id, "updated", summary, actor=actor)
    db.commit()


@bulk_router.post(
    "/parts/import",
    response_model=ImportReport,
    responses={
        413: {"description": "Upload larger than 5 MB"},
        422: {"model": ImportReport, "description": "Rows have errors; nothing was written"},
    },
    openapi_extra=_IMPORT_OPENAPI,
)
async def import_parts(
    request: Request,
    dry_run: bool = True,
    mode: ImportMode = "create_only",
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Any:
    """Import catalog parts, matched by part_number (case-insensitive) when upserting."""
    table, source = await _read_table(request, PART_SPEC.key_aliases)
    return await run_in_threadpool(
        _run_import, db, PART_SPEC, table, mode, dry_run, user.email, source
    )


@bulk_router.post(
    "/projects/{project_id}/requirements/import",
    response_model=ImportReport,
    responses={
        413: {"description": "Upload larger than 5 MB"},
        422: {"model": ImportReport, "description": "Rows have errors; nothing was written"},
    },
    openapi_extra=_IMPORT_OPENAPI,
)
async def import_requirements(
    project_id: str,
    request: Request,
    dry_run: bool = True,
    mode: ImportMode = "create_only",
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Any:
    """Import project requirements, matched by key within the project when upserting."""
    await run_in_threadpool(require_model, db, Project, project_id)
    table, source = await _read_table(request, REQUIREMENT_SPEC.key_aliases)
    return await run_in_threadpool(
        _run_import, db, REQUIREMENT_SPEC, table, mode, dry_run, user.email, source, project_id
    )


def _template_response(spec: EntitySpec, file_format: str) -> Response:
    name = f"{spec.label}-import-template.{file_format}"
    if file_format == "xlsx":
        content = template_xlsx(spec)
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        content = template_csv(spec)
        media_type = "text/csv; charset=utf-8"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@bulk_router.get("/parts/import-template")
def parts_import_template(
    file_format: Literal["csv", "xlsx"] = Query("csv", alias="format"),
) -> Response:
    return _template_response(PART_SPEC, file_format)


@bulk_router.get("/projects/{project_id}/requirements/import-template")
def requirements_import_template(
    project_id: str,
    file_format: Literal["csv", "xlsx"] = Query("csv", alias="format"),
    db: Session = Depends(get_db),
) -> Response:
    require_model(db, Project, project_id)
    return _template_response(REQUIREMENT_SPEC, file_format)


@bulk_router.post(
    "/projects/{project_id}/line-classes/import-file",
    response_model=LineClassImportRead,
    openapi_extra=_IMPORT_OPENAPI,
)
async def import_line_classes_file(
    project_id: str,
    request: Request,
    replace: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Any:
    """The line class CSV import, fed from an uploaded .csv or .xlsx file."""
    await run_in_threadpool(require_model, db, Project, project_id)
    table, _source = await _read_table(request, {"name"})
    payload = LineClassImportIn(csv=table_to_csv(table), replace=replace)
    return await run_in_threadpool(import_line_classes, project_id, payload, db, user)


# --------------------------------------------------------------------------- bulk edit


def _validated_changes(spec: EntitySpec, changes: dict[str, Any]) -> dict[str, Any]:
    try:
        return validate_bulk_changes(spec, changes)
    except ValidationError as exc:
        errors = exc.errors(include_url=False, include_context=False)
        raise HTTPException(status_code=422, detail=jsonable_encoder(errors)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _apply_changes(obj: Any, changes: dict[str, Any]) -> list[str]:
    changed = [name for name, value in changes.items() if current_value(obj, name) != value]
    for name in changed:
        setattr(obj, name, changes[name])
    return changed


@bulk_router.patch("/parts/bulk", response_model=PartBulkUpdateRead)
def bulk_update_parts(
    payload: BulkUpdateIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    """Set the same field values on many parts; all or none (404 if any id is unknown)."""
    changes = _validated_changes(PART_SPEC, payload.changes)
    ids = list(dict.fromkeys(payload.ids))
    parts = {part.id: part for part in db.scalars(select(Part).where(Part.id.in_(ids)))}
    missing = [part_id for part_id in ids if part_id not in parts]
    if missing:
        raise HTTPException(status_code=404, detail=f"Part(s) not found: {', '.join(missing)}")

    updated = 0
    for part_id in ids:
        part = parts[part_id]
        changed = _apply_changes(part, changes)
        if not changed:
            continue
        updated += 1
        if "part_type" in changed:
            remember_part_type(db, part.part_type)
        # Same rule as a single part update: sheets using the part need a new DRC.
        mark_sheets_stale_for_part(db, part.id)
        record_change(
            db,
            "part",
            part.id,
            "updated",
            f"Updated part {part.part_number} (bulk edit: {', '.join(changed)})",
            actor=user.email,
        )
    if updated:
        record_change(
            db,
            "catalog",
            "parts",
            "updated",
            f"Bulk edited {updated} part(s): {', '.join(sorted(changes))}",
            actor=user.email,
        )
    db.commit()
    for part in parts.values():
        db.refresh(part)
    return {
        "updated": updated,
        "unchanged": len(ids) - updated,
        "items": [parts[part_id] for part_id in ids],
    }


@bulk_router.patch(
    "/projects/{project_id}/requirements/bulk", response_model=RequirementBulkUpdateRead
)
def bulk_update_requirements(
    project_id: str,
    payload: BulkUpdateIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    """Set the same field values on many requirements of one project; all or none."""
    require_model(db, Project, project_id)
    changes = _validated_changes(REQUIREMENT_SPEC, payload.changes)
    ids = list(dict.fromkeys(payload.ids))
    requirements = {
        requirement.id: requirement
        for requirement in db.scalars(
            select(Requirement).where(Requirement.id.in_(ids), Requirement.project_id == project_id)
        )
    }
    missing = [requirement_id for requirement_id in ids if requirement_id not in requirements]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Requirement(s) not found in this project: {', '.join(missing)}",
        )

    updated = 0
    project_stale = False
    for requirement_id in ids:
        requirement = requirements[requirement_id]
        had_constraint = requirement.constraint is not None
        changed = _apply_changes(requirement, changes)
        if not changed:
            continue
        updated += 1
        if had_constraint or requirement.constraint is not None:
            project_stale = True
        record_change(
            db,
            "requirement",
            requirement.id,
            "updated",
            f"Updated requirement {requirement.key} (bulk edit: {', '.join(changed)})",
            actor=user.email,
        )
    if project_stale:
        mark_project_sheets_stale(db, project_id)
    if updated:
        record_change(
            db,
            "project",
            project_id,
            "updated",
            f"Bulk edited {updated} requirement(s): {', '.join(sorted(changes))}",
            actor=user.email,
        )
    db.commit()
    for requirement in requirements.values():
        db.refresh(requirement)
    return {
        "updated": updated,
        "unchanged": len(ids) - updated,
        "items": [requirements[requirement_id] for requirement_id in ids],
    }


# --------------------------------------------------------------------------- bulk delete


def _part_delete_blocker(db: Session, part: Part) -> str | None:
    """Why a part cannot be deleted; mirrors the single DELETE /parts/{id} rule."""
    usage_count = (
        db.scalar(
            select(func.count())
            .select_from(ComponentInstance)
            .where(ComponentInstance.part_id == part.id)
        )
        or 0
    )
    usage_count += (
        db.scalar(select(func.count()).select_from(SheetItem).where(SheetItem.part_id == part.id))
        or 0
    )
    if usage_count:
        return (
            f"Part {part.part_number} is placed on {usage_count} component instance(s). "
            "Remove those components first or mark the part obsolete instead of deleting it."
        )
    return None


def _delete_summary(results: list[dict]) -> dict:
    deleted = sum(1 for result in results if result["deleted"])
    return {"deleted": deleted, "refused": len(results) - deleted, "results": results}


@bulk_router.post("/parts/bulk-delete", response_model=BulkDeleteRead)
def bulk_delete_parts(
    payload: BulkIdsIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    """Delete the parts that can be deleted; report why the others were refused."""
    results: list[dict] = []
    stored_files = []
    for part_id in dict.fromkeys(payload.ids):
        part = db.get(Part, part_id)
        if part is None:
            results.append({"id": part_id, "deleted": False, "reason": "Part not found"})
            continue
        reason = _part_delete_blocker(db, part)
        if reason:
            results.append({"id": part_id, "deleted": False, "reason": reason})
            continue
        stored_files.extend(
            document.storage_path
            for document in db.scalars(
                select(CatalogDocument).where(CatalogDocument.part_id == part.id)
            )
        )
        delete_trace_links_for(db, "part", part.id)
        record_change(
            db,
            "part",
            part.id,
            "deleted",
            f"Deleted part {part.part_number} (bulk delete)",
            actor=user.email,
        )
        db.delete(part)
        results.append({"id": part_id, "deleted": True, "reason": None})
    summary = _delete_summary(results)
    if summary["deleted"]:
        record_change(
            db,
            "catalog",
            "parts",
            "deleted",
            f"Bulk deleted {summary['deleted']} part(s); {summary['refused']} refused",
            actor=user.email,
        )
    db.commit()
    # Files go only after the rows are gone, so a failed commit leaves both intact.
    for storage_path in stored_files:
        stored = catalog_files_root() / storage_path
        if stored.is_file():
            stored.unlink()
    return summary


@bulk_router.post("/projects/{project_id}/requirements/bulk-delete", response_model=BulkDeleteRead)
def bulk_delete_requirements(
    project_id: str,
    payload: BulkIdsIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    """Delete requirements of one project; ids outside the project are reported, not deleted."""
    require_model(db, Project, project_id)
    results: list[dict] = []
    project_stale = False
    for requirement_id in dict.fromkeys(payload.ids):
        requirement = db.get(Requirement, requirement_id)
        if requirement is None or requirement.project_id != project_id:
            results.append(
                {
                    "id": requirement_id,
                    "deleted": False,
                    "reason": "Requirement not found in this project",
                }
            )
            continue
        delete_trace_links_for(db, "requirement", requirement.id)
        if requirement.constraint is not None:
            project_stale = True
        record_change(
            db,
            "requirement",
            requirement.id,
            "deleted",
            f"Deleted requirement {requirement.key} (bulk delete)",
            actor=user.email,
        )
        db.delete(requirement)
        results.append({"id": requirement_id, "deleted": True, "reason": None})
    if project_stale:
        mark_project_sheets_stale(db, project_id)
    summary = _delete_summary(results)
    if summary["deleted"]:
        record_change(
            db,
            "project",
            project_id,
            "updated",
            f"Bulk deleted {summary['deleted']} requirement(s)",
            actor=user.email,
        )
    db.commit()
    return summary
