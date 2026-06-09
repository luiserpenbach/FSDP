from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import BomSnapshot, ComponentInstance, Diagram, Part


def generate_bom_snapshot(db: Session, diagram: Diagram) -> BomSnapshot:
    components = db.scalars(
        select(ComponentInstance).where(ComponentInstance.diagram_id == diagram.id)
    ).all()

    rows_by_part: dict[str, dict] = {}
    for component in components:
        part = db.get(Part, component.part_id) if component.part_id else None
        row_key = component.part_id or component.tag
        existing = rows_by_part.setdefault(
            row_key,
            {
                "part_id": part.id if part else None,
                "part_number": part.part_number if part else None,
                "revision": part.revision if part else None,
                "description": part.description if part else component.tag,
                "manufacturer": part.manufacturer if part else None,
                "quantity": 0,
                "qualification_status": part.qualification_status if part else "unresolved",
                "certification_status": part.certification_status if part else "unresolved",
                "component_tags": [],
                "alternates": [],
            },
        )
        existing["quantity"] += component.quantity
        existing["component_tags"].append(component.tag)

    latest = db.scalars(
        select(BomSnapshot)
        .where(BomSnapshot.diagram_id == diagram.id)
        .order_by(BomSnapshot.revision.desc())
    ).first()
    snapshot = BomSnapshot(
        diagram_id=diagram.id,
        revision=(latest.revision + 1) if latest else 1,
        status="draft",
        rows=list(rows_by_part.values()),
    )
    db.add(snapshot)
    db.flush()
    return snapshot
