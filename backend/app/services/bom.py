from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import BomSnapshot, ComponentInstance, Diagram, Drawing, Part
from app.services.sheet_index import drawing_index_rows

# Symbol categories that become BoM line items (connectors and actuators do not).
BOM_ITEM_CATEGORIES = {"valve", "regulator", "inline", "instrument", "equipment", "custom"}
# Line types that consume tubing and fittings.
BULK_LINE_TYPES = {"process", "vacuum", "capillary"}


def _part_row(part: Part | None, description: str) -> dict:
    return {
        "kind": "part" if part else "unassigned",
        "part_id": part.id if part else None,
        "part_number": part.part_number if part else None,
        "revision": part.revision if part else None,
        "description": part.description if part else description,
        "manufacturer": part.manufacturer if part else None,
        "material": part.material if part else None,
        "pressure_rating_bar": part.pressure_rating_bar if part else None,
        "mass_kg": part.mass_kg if part else None,
        "cv": part.cv if part else None,
        "quantity": 0,
        "unit": "ea",
        "spare_quantity": 0,
        "qualification_status": part.qualification_status if part else "unresolved",
        "certification_status": part.certification_status if part else "unresolved",
        "component_tags": [],
        "dnp_tags": [],
        "sheets": [],
        "alternates": [],
    }


def _next_revision(db: Session, *, diagram_id: str | None, drawing_id: str | None) -> int:
    query = select(BomSnapshot).order_by(BomSnapshot.revision.desc())
    if diagram_id:
        query = query.where(BomSnapshot.diagram_id == diagram_id)
    else:
        query = query.where(BomSnapshot.drawing_id == drawing_id)
    latest = db.scalars(query).first()
    return (latest.revision + 1) if latest else 1


def generate_bom_snapshot(db: Session, diagram: Diagram) -> BomSnapshot:
    components = db.scalars(
        select(ComponentInstance).where(ComponentInstance.diagram_id == diagram.id)
    ).all()

    rows_by_part: dict[str, dict] = {}
    for component in components:
        part = db.get(Part, component.part_id) if component.part_id else None
        row_key = component.part_id or component.tag
        existing = rows_by_part.setdefault(row_key, _part_row(part, component.tag))
        existing["quantity"] += component.quantity
        existing["component_tags"].append(component.tag)

    snapshot = BomSnapshot(
        diagram_id=diagram.id,
        revision=_next_revision(db, diagram_id=diagram.id, drawing_id=None),
        status="draft",
        rows=list(rows_by_part.values()),
    )
    db.add(snapshot)
    db.flush()
    return snapshot


def drawing_bom_rows(db: Session, drawing: Drawing) -> list[dict]:
    """BoM rows for a drawing from its sheet index.

    Tagged symbols and equipment roll up by assigned part (or by symbol when
    no part is assigned yet); do-not-populate items are listed but not
    counted; spares add to `spare_quantity`. Lines add bulk rows: tubing
    length per (class or spec, size), fittings per line end on a port, and
    tees per size.
    """
    items, lines = drawing_index_rows(db, [drawing])
    part_ids = {item.part_id for item, _, _ in items if item.part_id}
    parts = {part.id: part for part in db.scalars(select(Part).where(Part.id.in_(part_ids)))}

    rows: dict[str, dict] = {}
    for item, sheet, _ in items:
        category = item.category or ""
        if item.kind == "symbol" and category not in BOM_ITEM_CATEGORIES:
            continue
        if item.kind == "equipment" and not item.tag:
            # Untagged boundaries (skids, panels) are not purchasable items.
            continue
        part = parts.get(item.part_id) if item.part_id else None
        if part:
            key = f"part:{part.id}"
        elif item.kind == "equipment":
            # Unassigned equipment is one row per boundary name (a chamber is not a tank).
            key = f"equipment:{item.label or item.item_id}"
        else:
            key = f"symbol:{item.symbol_key or item.kind}"
        description = (
            (item.label or item.tag or item.kind)
            if item.kind == "equipment"
            else (item.symbol_name or item.label or item.kind)
        )
        row = rows.setdefault(key, _part_row(part, description))
        row["symbol_key"] = item.symbol_key
        row["category"] = item.category or item.kind
        caption = item.tag or item.label or item.item_id
        if item.dnp:
            row["dnp_tags"].append(caption)
        else:
            row["quantity"] += 1
            row["component_tags"].append(caption)
        row["spare_quantity"] += item.spare
        if sheet.sheet_no not in row["sheets"]:
            row["sheets"].append(sheet.sheet_no)

    bulk: dict[str, dict] = {}

    def bulk_row(key: str, description: str, unit: str, **extra) -> dict:
        return bulk.setdefault(
            key,
            {
                "kind": "bulk",
                "part_id": None,
                "part_number": None,
                "description": description,
                "quantity": 0,
                "unit": unit,
                "spare_quantity": 0,
                "qualification_status": "bulk",
                "certification_status": "bulk",
                "component_tags": [],
                "dnp_tags": [],
                "sheets": [],
                "alternates": [],
                **extra,
            },
        )

    for line, sheet, _ in lines:
        if line.line_type not in BULK_LINE_TYPES:
            continue
        size = line.size or ""
        spec = line.line_class or line.spec or ""
        reference = line.line_number or line.line_id
        tube = bulk_row(
            f"tube:{spec}|{size}",
            " ".join(part for part in ["Tube", size, spec] if part).strip(),
            "m",
            size=size or None,
            line_class=line.line_class,
            spec=line.spec,
        )
        tube["quantity"] = round(tube["quantity"] + (line.length_m or 0.0), 3)
        tube["component_tags"].append(reference)
        if sheet.sheet_no not in tube["sheets"]:
            tube["sheets"].append(sheet.sheet_no)
        if line.connection_count:
            fitting = bulk_row(
                f"fitting:{size}", f"Tube fitting {size}".strip(), "ea", size=size or None
            )
            fitting["quantity"] += line.connection_count
            fitting["component_tags"].append(reference)
        if line.tee_count:
            tee = bulk_row(f"tee:{size}", f"Tube tee {size}".strip(), "ea", size=size or None)
            tee["quantity"] += line.tee_count
            tee["component_tags"].append(reference)

    ordered = sorted(
        rows.values(),
        key=lambda row: (row["kind"] != "part", row.get("part_number") or "", row["description"]),
    )
    ordered.extend(sorted(bulk.values(), key=lambda row: row["description"]))
    return ordered


def generate_drawing_bom_snapshot(db: Session, drawing: Drawing) -> BomSnapshot:
    snapshot = BomSnapshot(
        drawing_id=drawing.id,
        revision=_next_revision(db, diagram_id=None, drawing_id=drawing.id),
        status="draft",
        rows=drawing_bom_rows(db, drawing),
    )
    db.add(snapshot)
    db.flush()
    return snapshot
