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
    Diagram,
    Drawing,
    DrawingRevision,
    DrawingSheet,
    FluidSystem,
    LineClass,
    Project,
    TagScheme,
    User,
)
from app.schemas import (
    DrawingCreate,
    DrawingRead,
    DrawingRevisionCreate,
    DrawingRevisionRead,
    DrawingRevisionUpdate,
    DrawingSheetCreate,
    DrawingSheetRead,
    DrawingSheetUpdate,
    DrawingUpdate,
    LineClassCreate,
    LineClassImportIn,
    LineClassImportRead,
    LineClassRead,
    LineClassUpdate,
    SheetExportIn,
    TagSchemeIn,
    TagSchemeRead,
)
from app.services.export import export_filename, svg_to_pdf, svg_to_png

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
            body = svg_to_pdf(payload.svg)
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
