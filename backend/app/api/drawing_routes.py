"""Drawings, sheets, revisions, and sheet export."""

from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.routes import record_change, require_model
from app.core.security import require_writer
from app.db import get_db
from app.models import (
    BomSnapshot,
    Diagram,
    Drawing,
    DrawingRevision,
    DrawingSheet,
    DrcWaiver,
    FluidSystem,
    LineClass,
    Project,
    SheetItem,
    SheetLine,
    TagScheme,
    User,
)
from app.schemas import (
    BomSnapshotRead,
    DrawingCreate,
    DrawingDrcRead,
    DrawingRead,
    DrawingRevisionCreate,
    DrawingRevisionRead,
    DrawingRevisionUpdate,
    DrawingSheetCreate,
    DrawingSheetRead,
    DrawingSheetUpdate,
    DrawingUpdate,
    DrcWaiverIn,
    DrcWaiverRead,
    LineClassCreate,
    LineClassImportIn,
    LineClassImportRead,
    LineClassRead,
    LineClassUpdate,
    ListRead,
    SheetDrcRead,
    SheetExportIn,
    SheetIndexRead,
    TagSchemeIn,
    TagSchemeRead,
    VerificationMatrixRead,
)
from app.services.bom import generate_drawing_bom_snapshot
from app.services.drc import drawing_drc, replace_sheet_drc, sheet_drc, verification_matrix
from app.services.export import export_filename, svg_to_pdf, svg_to_png
from app.services.lists import (
    LIST_KINDS,
    list_columns,
    list_filename,
    list_header,
    list_rows,
    rows_to_csv,
    rows_to_xlsx,
)
from app.services.sheet_index import replace_sheet_index

drawing_router = APIRouter()

EMPTY_DOCUMENT = {
    "schemaVersion": 1,
    "sheet": {
        "size": "A3",
        "orientation": "landscape",
        "frame": {"kind": "basic", "columns": 4, "rows": 3, "margin": 10},
    },
    "layers": [],
    "items": [],
    "meta": {"grid": 2.5},
}

MEDIA_TYPES = {"pdf": "application/pdf", "png": "image/png", "svg": "image/svg+xml"}


def _load_drawing(db: Session, drawing_id: str) -> Drawing:
    drawing = db.scalar(
        select(Drawing)
        .where(Drawing.id == drawing_id)
        .options(selectinload(Drawing.sheets), selectinload(Drawing.revisions))
    )
    if drawing is None:
        raise HTTPException(status_code=404, detail="Drawing not found")
    return drawing


def _next_drawing_number(db: Session, project: Project) -> str:
    prefix = (project.part_name_prefix or "DWG").strip() or "DWG"
    count = db.scalar(
        select(func.count()).select_from(Drawing).where(Drawing.project_id == project.id)
    )
    candidate = count or 0
    while True:
        candidate += 1
        number = f"{prefix}-{candidate:04d}"
        exists = db.scalar(
            select(Drawing.id).where(Drawing.project_id == project.id, Drawing.number == number)
        )
        if not exists:
            return number


def _document_for_size(document: dict | None, size: str) -> dict:
    if document is not None:
        return document
    sheet = {**EMPTY_DOCUMENT["sheet"], "size": size}
    return {**EMPTY_DOCUMENT, "sheet": sheet}


def _sheet_source_document(
    db: Session, sheet_in: DrawingSheetCreate | None, size: str
) -> tuple[dict, str | None]:
    if sheet_in is None:
        return _document_for_size(None, size), None
    if sheet_in.document is not None:
        return sheet_in.document, sheet_in.source_diagram_id
    if sheet_in.source_diagram_id:
        diagram = require_model(db, Diagram, sheet_in.source_diagram_id)
        if diagram.schematic:
            return diagram.schematic, diagram.id
        raise HTTPException(
            status_code=422,
            detail="Diagram has no schematic document yet; convert it in the browser first",
        )
    return _document_for_size(None, size), None


@drawing_router.post("/projects/{project_id}/drawings", response_model=DrawingRead, status_code=201)
def create_drawing(
    project_id: str,
    payload: DrawingCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Drawing:
    project = require_model(db, Project, project_id)
    if payload.system_id:
        system = require_model(db, FluidSystem, payload.system_id)
        if system.project_id != project_id:
            raise HTTPException(status_code=422, detail="System belongs to another project")
    number = payload.number or _next_drawing_number(db, project)
    duplicate = db.scalar(
        select(Drawing.id).where(Drawing.project_id == project_id, Drawing.number == number)
    )
    if duplicate:
        raise HTTPException(status_code=409, detail="Drawing number already exists in project")

    document, source_diagram_id = _sheet_source_document(db, payload.first_sheet, payload.size)
    drawing = Drawing(
        project_id=project_id,
        system_id=payload.system_id,
        number=number,
        title=payload.title,
        size=payload.size,
        units=payload.units,
        discipline=payload.discipline,
        frame_template=payload.frame_template,
        fields=payload.fields,
        notes=payload.notes,
    )
    drawing.sheets.append(
        DrawingSheet(
            sheet_no=1,
            title=payload.first_sheet.title if payload.first_sheet else None,
            source_diagram_id=source_diagram_id,
            document=document,
        )
    )
    revision = payload.revision or DrawingRevisionCreate()
    drawing.revisions.append(
        DrawingRevision(
            sequence=1,
            **{**revision.model_dump(), "drawn_by": revision.drawn_by or user.name},
        )
    )
    db.add(drawing)
    db.flush()
    record_change(
        db, "drawing", drawing.id, "created", f"Created drawing {number}", actor=user.email
    )
    db.commit()
    return _load_drawing(db, drawing.id)


@drawing_router.get("/projects/{project_id}/drawings", response_model=list[DrawingRead])
def list_drawings(project_id: str, db: Session = Depends(get_db)) -> list[Drawing]:
    require_model(db, Project, project_id)
    return list(
        db.scalars(
            select(Drawing)
            .where(Drawing.project_id == project_id)
            .options(selectinload(Drawing.sheets), selectinload(Drawing.revisions))
            .order_by(Drawing.number)
        )
    )


@drawing_router.get("/drawings/{drawing_id}", response_model=DrawingRead)
def get_drawing(drawing_id: str, db: Session = Depends(get_db)) -> Drawing:
    return _load_drawing(db, drawing_id)


@drawing_router.put("/drawings/{drawing_id}", response_model=DrawingRead)
def update_drawing(
    drawing_id: str,
    payload: DrawingUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Drawing:
    drawing = _load_drawing(db, drawing_id)
    data = payload.model_dump(exclude_unset=True)
    if "number" in data and data["number"] and data["number"] != drawing.number:
        duplicate = db.scalar(
            select(Drawing.id).where(
                Drawing.project_id == drawing.project_id,
                Drawing.number == data["number"],
                Drawing.id != drawing.id,
            )
        )
        if duplicate:
            raise HTTPException(status_code=409, detail="Drawing number already exists in project")
    if "system_id" in data and data["system_id"]:
        system = require_model(db, FluidSystem, data["system_id"])
        if system.project_id != drawing.project_id:
            raise HTTPException(status_code=422, detail="System belongs to another project")
    for field, value in data.items():
        if value is None and field in {"title", "number"}:
            continue
        setattr(drawing, field, value)
    record_change(
        db, "drawing", drawing.id, "updated", f"Updated drawing {drawing.number}", actor=user.email
    )
    db.commit()
    return _load_drawing(db, drawing.id)


@drawing_router.delete("/drawings/{drawing_id}", status_code=204)
def delete_drawing(
    drawing_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    drawing = _load_drawing(db, drawing_id)
    record_change(
        db, "drawing", drawing.id, "deleted", f"Deleted drawing {drawing.number}", actor=user.email
    )
    db.delete(drawing)
    db.commit()
    return Response(status_code=204)


@drawing_router.post(
    "/drawings/{drawing_id}/sheets", response_model=DrawingSheetRead, status_code=201
)
def create_sheet(
    drawing_id: str,
    payload: DrawingSheetCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> DrawingSheet:
    drawing = _load_drawing(db, drawing_id)
    document, source_diagram_id = _sheet_source_document(db, payload, drawing.size)
    sheet_no = max((sheet.sheet_no for sheet in drawing.sheets), default=0) + 1
    sheet = DrawingSheet(
        drawing_id=drawing.id,
        sheet_no=sheet_no,
        title=payload.title,
        source_diagram_id=source_diagram_id,
        document=document,
    )
    db.add(sheet)
    record_change(
        db,
        "drawing",
        drawing.id,
        "updated",
        f"Added sheet {sheet_no} to {drawing.number}",
        actor=user.email,
    )
    db.commit()
    db.refresh(sheet)
    return sheet


@drawing_router.get("/sheets/{sheet_id}", response_model=DrawingSheetRead)
def get_sheet(sheet_id: str, db: Session = Depends(get_db)) -> DrawingSheet:
    return require_model(db, DrawingSheet, sheet_id)


@drawing_router.put("/sheets/{sheet_id}", response_model=DrawingSheetRead)
def update_sheet(
    sheet_id: str,
    payload: DrawingSheetUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> DrawingSheet:
    sheet = require_model(db, DrawingSheet, sheet_id)
    data = payload.model_dump(exclude_unset=True)
    if "title" in data:
        sheet.title = data["title"]
    if data.get("document") is not None:
        sheet.document = data["document"]
    if payload.index is not None:
        replace_sheet_index(db, sheet, payload.index)
    if payload.drc is not None:
        replace_sheet_drc(db, sheet, payload.drc)
    drawing = require_model(db, Drawing, sheet.drawing_id)
    item_count = len((sheet.document or {}).get("items", []))
    record_change(
        db,
        "drawing",
        drawing.id,
        "updated",
        f"Saved sheet {sheet.sheet_no} of {drawing.number} ({item_count} items)",
        actor=user.email,
    )
    db.commit()
    db.refresh(sheet)
    return sheet


@drawing_router.delete("/sheets/{sheet_id}", status_code=204)
def delete_sheet(
    sheet_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    sheet = require_model(db, DrawingSheet, sheet_id)
    drawing = _load_drawing(db, sheet.drawing_id)
    if len(drawing.sheets) <= 1:
        raise HTTPException(status_code=409, detail="A drawing must keep at least one sheet")
    removed_no = sheet.sheet_no
    db.delete(sheet)
    db.flush()
    # Renumber so sheets stay contiguous ("2 OF 3").
    remaining = sorted((s for s in drawing.sheets if s.id != sheet_id), key=lambda s: s.sheet_no)
    for index, entry in enumerate(remaining, start=1):
        entry.sheet_no = index
    record_change(
        db,
        "drawing",
        drawing.id,
        "updated",
        f"Removed sheet {removed_no} from {drawing.number}",
        actor=user.email,
    )
    db.commit()
    return Response(status_code=204)


@drawing_router.post(
    "/drawings/{drawing_id}/revisions", response_model=DrawingRevisionRead, status_code=201
)
def create_revision(
    drawing_id: str,
    payload: DrawingRevisionCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> DrawingRevision:
    drawing = _load_drawing(db, drawing_id)
    sequence = max((rev.sequence for rev in drawing.revisions), default=0) + 1
    revision = DrawingRevision(
        drawing_id=drawing.id,
        sequence=sequence,
        **{**payload.model_dump(), "drawn_by": payload.drawn_by or user.name},
    )
    db.add(revision)
    record_change(
        db,
        "drawing",
        drawing.id,
        "updated",
        f"Added revision {payload.label} to {drawing.number}",
        actor=user.email,
    )
    db.commit()
    db.refresh(revision)
    return revision


@drawing_router.put("/revisions/{revision_id}", response_model=DrawingRevisionRead)
def update_revision(
    revision_id: str,
    payload: DrawingRevisionUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> DrawingRevision:
    revision = require_model(db, DrawingRevision, revision_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if field in {"label", "description"} and (value is None or not str(value).strip()):
            continue
        setattr(revision, field, value)
    record_change(
        db,
        "drawing",
        revision.drawing_id,
        "updated",
        f"Updated revision {revision.label}",
        actor=user.email,
    )
    db.commit()
    db.refresh(revision)
    return revision


@drawing_router.post("/sheets/{sheet_id}/export")
def export_sheet(
    sheet_id: str,
    payload: SheetExportIn,
    db: Session = Depends(get_db),
) -> Response:
    sheet = require_model(db, DrawingSheet, sheet_id)
    drawing = _load_drawing(db, sheet.drawing_id)
    revision_label = drawing.revisions[-1].label if drawing.revisions else "0"
    filename = export_filename(drawing.number, sheet.sheet_no, revision_label, payload.format)
    try:
        if payload.format == "pdf":
            body = svg_to_pdf(payload.svg, payload.pages)
        elif payload.format == "png":
            body = svg_to_png(payload.svg, dpi=payload.dpi)
        else:
            body = payload.svg.encode("utf-8")
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:  # Cairo parse failures surface as generic exceptions.
        raise HTTPException(status_code=422, detail=f"Could not render sheet: {error}") from error
    return Response(
        content=body,
        media_type=MEDIA_TYPES[payload.format],
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@drawing_router.get("/sheets/{sheet_id}/drc", response_model=SheetDrcRead)
def get_sheet_drc(sheet_id: str, db: Session = Depends(get_db)) -> dict:
    """Stored findings (from the last save), waivers, and requirement checks of a sheet."""
    return sheet_drc(db, require_model(db, DrawingSheet, sheet_id))


@drawing_router.put("/sheets/{sheet_id}/drc/waivers", response_model=DrcWaiverRead, status_code=201)
def waive_finding(
    sheet_id: str,
    payload: DrcWaiverIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> DrcWaiver:
    """Waive a finding by key with a reason; re-runs keep the waiver."""
    sheet = require_model(db, DrawingSheet, sheet_id)
    waiver = db.scalar(
        select(DrcWaiver).where(DrcWaiver.sheet_id == sheet.id, DrcWaiver.key == payload.key)
    )
    if waiver is None:
        waiver = DrcWaiver(sheet_id=sheet.id, key=payload.key)
        db.add(waiver)
    waiver.reason = payload.reason
    waiver.waived_by = user.email
    drawing = require_model(db, Drawing, sheet.drawing_id)
    record_change(
        db,
        "drawing",
        drawing.id,
        "updated",
        f"Waived DRC finding {payload.key} on {drawing.number} sheet {sheet.sheet_no}: "
        f"{payload.reason}",
        actor=user.email,
    )
    db.commit()
    db.refresh(waiver)
    return waiver


@drawing_router.delete("/sheets/{sheet_id}/drc/waivers/{key:path}", status_code=204)
def unwaive_finding(
    sheet_id: str,
    key: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    sheet = require_model(db, DrawingSheet, sheet_id)
    waiver = db.scalar(
        select(DrcWaiver).where(DrcWaiver.sheet_id == sheet.id, DrcWaiver.key == key)
    )
    if waiver is None:
        raise HTTPException(status_code=404, detail="Waiver not found")
    drawing = require_model(db, Drawing, sheet.drawing_id)
    db.delete(waiver)
    record_change(
        db,
        "drawing",
        drawing.id,
        "updated",
        f"Removed DRC waiver {key} on {drawing.number} sheet {sheet.sheet_no}",
        actor=user.email,
    )
    db.commit()
    return Response(status_code=204)


@drawing_router.get("/drawings/{drawing_id}/drc", response_model=DrawingDrcRead)
def get_drawing_drc(drawing_id: str, db: Session = Depends(get_db)) -> dict:
    """DRC counts and findings across every sheet of a drawing."""
    return drawing_drc(db, _load_drawing(db, drawing_id))


@drawing_router.get(
    "/projects/{project_id}/verification-matrix", response_model=VerificationMatrixRead
)
def get_verification_matrix(project_id: str, db: Session = Depends(get_db)) -> dict:
    """Requirements against the drawing DRC checks and trace links."""
    return verification_matrix(db, require_model(db, Project, project_id))


@drawing_router.get("/sheets/{sheet_id}/index", response_model=SheetIndexRead)
def get_sheet_index(sheet_id: str, db: Session = Depends(get_db)) -> dict:
    sheet = require_model(db, DrawingSheet, sheet_id)
    items = list(db.scalars(select(SheetItem).where(SheetItem.sheet_id == sheet.id)))
    lines = list(db.scalars(select(SheetLine).where(SheetLine.sheet_id == sheet.id)))
    return {"sheet_id": sheet.id, "items": items, "lines": lines}


LIST_MEDIA_TYPES = {
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def _list_kind(kind: str) -> str:
    normalized = kind.replace("-", "_")
    if normalized not in LIST_KINDS:
        raise HTTPException(
            status_code=404, detail="Unknown list; expected one of " + ", ".join(LIST_KINDS)
        )
    return normalized


def _list_response(
    kind: str,
    scope: str,
    scope_name: str,
    header: dict,
    columns: list[tuple[str, str]],
    rows: list[dict],
    fmt: str,
) -> Response | dict:
    if fmt == "json":
        return {
            "kind": kind,
            "title": header.get("list", kind),
            "scope": scope,
            "header": header,
            "columns": [{"key": key, "label": label} for key, label in columns],
            "rows": rows,
        }
    if fmt not in LIST_MEDIA_TYPES:
        raise HTTPException(status_code=400, detail="format must be json, csv, or xlsx")
    payload = (
        rows_to_csv(header, columns, rows).encode("utf-8")
        if fmt == "csv"
        else rows_to_xlsx(header, columns, rows)
    )
    filename = list_filename(kind, scope_name, fmt)
    return Response(
        payload,
        media_type=LIST_MEDIA_TYPES[fmt],
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@drawing_router.get("/drawings/{drawing_id}/lists/{kind}", response_model=ListRead)
def get_drawing_list(
    drawing_id: str, kind: str, format: str = "json", db: Session = Depends(get_db)
):
    """Engineering list for one drawing (all sheets), as JSON rows, CSV, or XLSX."""
    list_kind = _list_kind(kind)
    drawing = _load_drawing(db, drawing_id)
    project = require_model(db, Project, drawing.project_id)
    rows = list_rows(db, list_kind, [drawing])
    return _list_response(
        list_kind,
        "drawing",
        drawing.number,
        list_header(list_kind, "drawing", drawing, project),
        list_columns(list_kind, "drawing"),
        rows,
        format,
    )


@drawing_router.get("/projects/{project_id}/lists/{kind}", response_model=ListRead)
def get_project_list(
    project_id: str, kind: str, format: str = "json", db: Session = Depends(get_db)
):
    """Engineering list across every drawing of a project."""
    list_kind = _list_kind(kind)
    project = require_model(db, Project, project_id)
    drawings = list(
        db.scalars(
            select(Drawing)
            .where(Drawing.project_id == project.id)
            .options(selectinload(Drawing.sheets), selectinload(Drawing.revisions))
            .order_by(Drawing.number)
        )
    )
    rows = list_rows(db, list_kind, drawings)
    return _list_response(
        list_kind,
        "project",
        project.name,
        list_header(list_kind, "project", None, project),
        list_columns(list_kind, "project"),
        rows,
        format,
    )


@drawing_router.post("/drawings/{drawing_id}/bom", response_model=BomSnapshotRead, status_code=201)
def create_drawing_bom(
    drawing_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> BomSnapshot:
    """Generate a BoM snapshot from the drawing's sheet index."""
    drawing = _load_drawing(db, drawing_id)
    snapshot = generate_drawing_bom_snapshot(db, drawing)
    record_change(
        db,
        "bom_snapshot",
        snapshot.id,
        "created",
        f"Generated BoM rev {snapshot.revision} for drawing {drawing.number}",
        actor=user.email,
    )
    db.commit()
    db.refresh(snapshot)
    return snapshot


@drawing_router.get("/drawings/{drawing_id}/bom", response_model=list[BomSnapshotRead])
def list_drawing_boms(drawing_id: str, db: Session = Depends(get_db)) -> list[BomSnapshot]:
    require_model(db, Drawing, drawing_id)
    return list(
        db.scalars(
            select(BomSnapshot)
            .where(BomSnapshot.drawing_id == drawing_id)
            .order_by(BomSnapshot.revision.desc())
        )
    )


@drawing_router.get("/projects/{project_id}/tag-scheme", response_model=TagSchemeRead)
def get_tag_scheme(project_id: str, db: Session = Depends(get_db)) -> dict:
    require_model(db, Project, project_id)
    row = db.scalar(select(TagScheme).where(TagScheme.project_id == project_id))
    return {"project_id": project_id, "scheme": row.scheme if row else None}


@drawing_router.put("/projects/{project_id}/tag-scheme", response_model=TagSchemeRead)
def update_tag_scheme(
    project_id: str,
    payload: TagSchemeIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    require_model(db, Project, project_id)
    row = db.scalar(select(TagScheme).where(TagScheme.project_id == project_id))
    if row is None:
        row = TagScheme(project_id=project_id, scheme=payload.scheme)
        db.add(row)
    else:
        row.scheme = payload.scheme
    record_change(
        db,
        "project",
        project_id,
        "updated",
        f"Updated tag scheme ({payload.scheme.get('kind', 'simple')})",
        actor=user.email,
    )
    db.commit()
    return {"project_id": project_id, "scheme": row.scheme}


@drawing_router.get("/projects/{project_id}/line-classes", response_model=list[LineClassRead])
def list_line_classes(project_id: str, db: Session = Depends(get_db)) -> list[LineClass]:
    require_model(db, Project, project_id)
    return list(
        db.scalars(
            select(LineClass).where(LineClass.project_id == project_id).order_by(LineClass.name)
        )
    )


@drawing_router.post(
    "/projects/{project_id}/line-classes", response_model=LineClassRead, status_code=201
)
def create_line_class(
    project_id: str,
    payload: LineClassCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> LineClass:
    require_model(db, Project, project_id)
    duplicate = db.scalar(
        select(LineClass.id).where(
            LineClass.project_id == project_id, LineClass.name == payload.name
        )
    )
    if duplicate:
        raise HTTPException(status_code=409, detail="Line class name already exists in project")
    line_class = LineClass(project_id=project_id, **payload.model_dump())
    db.add(line_class)
    record_change(
        db, "project", project_id, "updated", f"Added line class {payload.name}", actor=user.email
    )
    db.commit()
    db.refresh(line_class)
    return line_class


@drawing_router.put("/line-classes/{line_class_id}", response_model=LineClassRead)
def update_line_class(
    line_class_id: str,
    payload: LineClassUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> LineClass:
    line_class = require_model(db, LineClass, line_class_id)
    data = payload.model_dump(exclude_unset=True)
    if data.get("name") and data["name"] != line_class.name:
        duplicate = db.scalar(
            select(LineClass.id).where(
                LineClass.project_id == line_class.project_id,
                LineClass.name == data["name"],
                LineClass.id != line_class.id,
            )
        )
        if duplicate:
            raise HTTPException(status_code=409, detail="Line class name already exists in project")
    for field, value in data.items():
        if field == "name" and not value:
            continue
        setattr(line_class, field, value)
    record_change(
        db,
        "project",
        line_class.project_id,
        "updated",
        f"Updated line class {line_class.name}",
        actor=user.email,
    )
    db.commit()
    db.refresh(line_class)
    return line_class


@drawing_router.delete("/line-classes/{line_class_id}", status_code=204)
def delete_line_class(
    line_class_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> Response:
    line_class = require_model(db, LineClass, line_class_id)
    record_change(
        db,
        "project",
        line_class.project_id,
        "updated",
        f"Deleted line class {line_class.name}",
        actor=user.email,
    )
    db.delete(line_class)
    db.commit()
    return Response(status_code=204)


@drawing_router.post(
    "/projects/{project_id}/line-classes/import", response_model=LineClassImportRead
)
def import_line_classes(
    project_id: str,
    payload: LineClassImportIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_writer),
) -> dict:
    """Upsert line classes from CSV (header: name, material, rating, wall, sizes, ...)."""
    require_model(db, Project, project_id)
    reader = csv.DictReader(io.StringIO(payload.csv.strip()))
    if not reader.fieldnames or "name" not in [name.strip().lower() for name in reader.fieldnames]:
        raise HTTPException(status_code=422, detail="CSV needs a header row with a 'name' column")
    existing = {
        row.name: row
        for row in db.scalars(select(LineClass).where(LineClass.project_id == project_id))
    }
    if payload.replace:
        for row in existing.values():
            db.delete(row)
        db.flush()
        existing = {}
    created = updated = 0
    errors: list[str] = []
    for index, raw in enumerate(reader, start=2):
        row = {(key or "").strip().lower(): (value or "").strip() for key, value in raw.items()}
        name = row.get("name", "")
        if not name:
            errors.append(f"row {index}: missing name")
            continue
        sizes = [part.strip() for part in row.get("sizes", "").split(";") if part.strip()]
        values = {
            "description": row.get("description") or None,
            "material": row.get("material") or None,
            "rating": row.get("rating") or None,
            "wall": row.get("wall") or None,
            "sizes": sizes,
            "insulation": row.get("insulation") or None,
            "notes": row.get("notes") or None,
        }
        target = existing.get(name)
        if target:
            for field, value in values.items():
                setattr(target, field, value)
            updated += 1
        else:
            target = LineClass(project_id=project_id, name=name, **values)
            db.add(target)
            existing[name] = target
            created += 1
    record_change(
        db,
        "project",
        project_id,
        "updated",
        f"Imported line classes ({created} created, {updated} updated)",
        actor=user.email,
    )
    db.commit()
    return {"created": created, "updated": updated, "errors": errors}
