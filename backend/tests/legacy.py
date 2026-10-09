"""Legacy diagram rows for tests.

The API no longer creates legacy diagrams, component instances, or diagram
BoM snapshots (they are import-only), so tests that read them insert the rows
directly, the way existing databases already hold them.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy.orm import Session, sessionmaker

from app.models import BomSnapshot, ComponentInstance, Diagram, Part, TraceLink


@dataclass
class LegacyDiagram:
    id: str
    system_id: str
    # Component instance id by tag.
    components: dict[str, str] = field(default_factory=dict)


def add_legacy_diagram(
    session_factory: sessionmaker[Session],
    system_id: str,
    name: str = "Legacy P&ID",
    *,
    graph: dict | None = None,
    schematic: dict | None = None,
    components: Iterable[tuple[str, str | None] | tuple[str, str | None, int]] = (),
) -> LegacyDiagram:
    """A legacy diagram with component instances given as (tag, part_id[, quantity])."""
    with session_factory() as db:
        diagram = Diagram(
            system_id=system_id,
            name=name,
            graph=graph if graph is not None else {"nodes": [], "edges": []},
            schematic=schematic,
        )
        db.add(diagram)
        db.flush()
        created = LegacyDiagram(id=diagram.id, system_id=system_id)
        for spec in components:
            tag, part_id, *rest = spec
            component = ComponentInstance(
                diagram_id=diagram.id, tag=tag, part_id=part_id, quantity=rest[0] if rest else 1
            )
            db.add(component)
            db.flush()
            created.components[tag] = component.id
        db.commit()
        return created


def add_legacy_trace_link(
    session_factory: sessionmaker[Session],
    source: tuple[str, str],
    target: tuple[str, str],
    link_type: str = "satisfied_by",
) -> str:
    """A trace link to a legacy object, as made before such links were refused."""
    with session_factory() as db:
        link = TraceLink(
            source_type=source[0],
            source_id=source[1],
            target_type=target[0],
            target_id=target[1],
            link_type=link_type,
        )
        db.add(link)
        db.commit()
        return link.id


def add_legacy_bom(
    session_factory: sessionmaker[Session], diagram_id: str, *, status: str = "draft"
) -> str:
    """A diagram BoM snapshot rolled up from its components, as the retired generator did."""
    with session_factory() as db:
        rows: dict[str, dict] = {}
        components = db.query(ComponentInstance).filter_by(diagram_id=diagram_id).all()
        for component in components:
            part = db.get(Part, component.part_id) if component.part_id else None
            row = rows.setdefault(
                component.part_id or component.tag,
                {
                    "kind": "part" if part else "unassigned",
                    "part_id": part.id if part else None,
                    "part_number": part.part_number if part else None,
                    "revision": part.revision if part else None,
                    "description": part.description if part else component.tag,
                    "manufacturer": part.manufacturer if part else None,
                    "material": part.material if part else None,
                    "pressure_rating_bar": part.pressure_rating_bar if part else None,
                    "mass_kg": part.mass_kg if part else None,
                    "cv": part.cv if part else None,
                    "quantity": 0,
                    "unit": "ea",
                    "qualification_status": part.qualification_status if part else "unresolved",
                    "certification_status": part.certification_status if part else "unresolved",
                    "component_tags": [],
                },
            )
            row["quantity"] += component.quantity
            row["component_tags"].append(component.tag)
        revision = db.query(BomSnapshot).filter_by(diagram_id=diagram_id).count() + 1
        snapshot = BomSnapshot(
            diagram_id=diagram_id, revision=revision, status=status, rows=list(rows.values())
        )
        db.add(snapshot)
        db.commit()
        return snapshot.id
