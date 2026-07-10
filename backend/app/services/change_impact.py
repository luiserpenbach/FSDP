from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import BomSnapshot, ComponentInstance
from app.services.traceability import get_trace_links


def get_change_impact(db: Session, object_type: str, object_id: str) -> dict:
    direct_links = get_trace_links(db, object_type, object_id)
    affected_components: list[ComponentInstance] = []
    affected_bom_snapshots: list[BomSnapshot] = []

    if object_type == "part":
        affected_components = list(
            db.scalars(select(ComponentInstance).where(ComponentInstance.part_id == object_id))
        )
        diagram_ids = {component.diagram_id for component in affected_components}
        if diagram_ids:
            affected_bom_snapshots = list(
                db.scalars(select(BomSnapshot).where(BomSnapshot.diagram_id.in_(diagram_ids)))
            )

    if object_type == "component":
        component = db.get(ComponentInstance, object_id)
        if component:
            affected_components = [component]
            affected_bom_snapshots = list(
                db.scalars(
                    select(BomSnapshot).where(BomSnapshot.diagram_id == component.diagram_id)
                )
            )

    if object_type == "requirement":
        component_ids: set[str] = set()
        for link in direct_links:
            if link.source_type == "requirement" and link.target_type == "component":
                component_ids.add(link.target_id)
            if link.target_type == "requirement" and link.source_type == "component":
                component_ids.add(link.source_id)
        if component_ids:
            affected_components = list(
                db.scalars(
                    select(ComponentInstance).where(ComponentInstance.id.in_(component_ids))
                )
            )
            diagram_ids = {component.diagram_id for component in affected_components}
            if diagram_ids:
                affected_bom_snapshots = list(
                    db.scalars(select(BomSnapshot).where(BomSnapshot.diagram_id.in_(diagram_ids)))
                )

    return {
        "object_type": object_type,
        "object_id": object_id,
        "direct_links": direct_links,
        "affected_bom_snapshots": affected_bom_snapshots,
        "affected_components": affected_components,
    }
