"""Seed demo data for FSDP demos and local development.

Run after migrations (idempotent — skips if the demo project exists):

    python -m app.seed

Also creates the bootstrap admin when FSDP_ADMIN_EMAIL/FSDP_ADMIN_PASSWORD are set.
"""

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.bootstrap import ensure_bootstrap_admin
from app.db import SessionLocal
from app.models import (
    ComponentInstance,
    Diagram,
    DiagramEdge,
    DiagramNode,
    FluidSystem,
    Part,
    Project,
    Requirement,
    TraceLink,
)
from app.services.bom import generate_bom_snapshot

logger = logging.getLogger(__name__)

DEMO_PROJECT_NAME = "Amphora Demo Vehicle"

PARTS = [
    {
        "part_number": "AMPH-FL-001",
        "description": "Inline filter, 10 micron",
        "part_type": "filter",
        "manufacturer": "Amphora Standard",
        "material": "316L",
        "pressure_rating_bar": 420.0,
        "mass_kg": 0.35,
        "qualification_status": "unqualified",
        "certification_status": "unreviewed",
    },
    {
        "part_number": "AMPH-PR-001",
        "description": "Dome-loaded pressure regulator",
        "part_type": "regulator",
        "manufacturer": "Amphora Standard",
        "material": "316L",
        "pressure_rating_bar": 420.0,
        "cv": 1.2,
        "mass_kg": 1.8,
        "qualification_status": "qualified",
        "certification_status": "in_review",
    },
    {
        "part_number": "AMPH-SV-001",
        "description": "Normally closed solenoid valve",
        "part_type": "valve",
        "manufacturer": "Amphora Standard",
        "material": "316L",
        "pressure_rating_bar": 350.0,
        "cv": 0.8,
        "mass_kg": 0.9,
        "qualification_status": "preferred",
        "certification_status": "certified",
    },
    {
        "part_number": "AMPH-RV-001",
        "description": "Spring relief valve, 380 bar set",
        "part_type": "relief_valve",
        "manufacturer": "Amphora Standard",
        "material": "316L",
        "pressure_rating_bar": 420.0,
        "mass_kg": 0.6,
        "qualification_status": "qualified",
        "certification_status": "certified",
    },
    {
        "part_number": "AMPH-PT-001",
        "description": "Pressure transducer, 0-500 bar",
        "part_type": "sensor",
        "manufacturer": "Amphora Standard",
        "material": "17-4PH",
        "pressure_rating_bar": 500.0,
        "mass_kg": 0.2,
        "qualification_status": "preferred",
        "certification_status": "certified",
    },
]

# (external_id, symbol_type, label, x, y, tag or None, part_number or None)
NODES = [
    ("node-tank", "source", "GHe Tank", 0, 120, None, None),
    ("node-filter", "filter", "F-1: AMPH-FL-001", 190, 120, "F-1", "AMPH-FL-001"),
    ("node-reg", "regulator", "PR-1: AMPH-PR-001", 380, 120, "PR-1", "AMPH-PR-001"),
    ("node-valve", "valve", "V-1: AMPH-SV-001", 570, 120, "V-1", "AMPH-SV-001"),
    ("node-engine", "sink", "Engine Interface", 760, 120, None, None),
    ("node-relief", "relief_valve", "RV-1: AMPH-RV-001", 380, 300, "RV-1", "AMPH-RV-001"),
    ("node-pt", "sensor", "PT-1: AMPH-PT-001", 570, 300, "PT-1", "AMPH-PT-001"),
]

# (external_id, source, target, label)
EDGES = [
    ("edge-1", "node-tank", "node-filter", "GHe supply"),
    ("edge-2", "node-filter", "node-reg", "Filtered supply"),
    ("edge-3", "node-reg", "node-valve", "Regulated GHe"),
    ("edge-4", "node-valve", "node-engine", "Press line"),
    ("edge-5", "node-reg", "node-relief", "Relief branch"),
    ("edge-6", "node-valve", "node-pt", "Sense line"),
]

REQUIREMENTS = [
    {
        "key": "AMPH-REQ-001",
        "title": "Pressure boundary compatibility",
        "text": "All pressurized components shall be rated above 1.5x MEOP of 240 bar.",
        "requirement_type": "safety",
        "verification_method": "analysis",
        "status": "approved",
        "trace_tag": "V-1",
    },
    {
        "key": "AMPH-REQ-002",
        "title": "Relief protection of regulated section",
        "text": (
            "The regulated section shall be protected by a relief device sized for "
            "full regulator failure flow."
        ),
        "requirement_type": "safety",
        "verification_method": "test",
        "status": "approved",
        "trace_tag": "RV-1",
    },
    {
        "key": "AMPH-REQ-003",
        "title": "External leakage",
        "text": "External leakage shall not exceed 1e-4 sccs GHe at MEOP.",
        "requirement_type": "performance",
        "verification_method": "test",
        "status": "draft",
        "trace_tag": "V-1",
    },
]


def build_graph_json() -> dict:
    nodes = [
        {
            "id": external_id,
            "type": "pidSymbol",
            "position": {"x": x, "y": y},
            "style": {"width": 112, "height": 84},
            "data": {"label": label, "symbolType": symbol_type, "rotation": 0},
        }
        for external_id, symbol_type, label, x, y, _tag, _part in NODES
    ]
    edges = [
        {
            "id": external_id,
            "type": "orthogonal",
            "source": source,
            "target": target,
            "label": label,
        }
        for external_id, source, target, label in EDGES
    ]
    return {"nodes": nodes, "edges": edges}


def seed_demo(db: Session) -> None:
    project = Project(
        name=DEMO_PROJECT_NAME,
        owner="Propulsion Engineering",
        description="Seeded demo project showing the P&ID → parts → requirements → BoM thread.",
    )
    system = FluidSystem(
        project=project,
        name="Helium Pressurization",
        fluid="GHe",
        description="Main tank pressurization system.",
    )
    diagram = Diagram(system=system, name="Pressurization P&ID", graph=build_graph_json())
    db.add_all([project, system, diagram])

    parts_by_number: dict[str, Part] = {}
    for part_data in PARTS:
        part = Part(**part_data)
        parts_by_number[part.part_number] = part
        db.add(part)
    db.flush()

    nodes_by_external_id: dict[str, DiagramNode] = {}
    for external_id, symbol_type, label, x, y, _tag, _part in NODES:
        node = DiagramNode(
            diagram_id=diagram.id,
            external_id=external_id,
            node_type=symbol_type,
            label=label,
            position={"x": x, "y": y},
            properties={"label": label, "symbolType": symbol_type, "rotation": 0},
        )
        nodes_by_external_id[external_id] = node
        db.add(node)
    for external_id, source, target, label in EDGES:
        db.add(
            DiagramEdge(
                diagram_id=diagram.id,
                external_id=external_id,
                source_node_id=source,
                target_node_id=target,
                fluid="GHe",
                flow_direction="forward",
                properties={"label": label},
            )
        )
    db.flush()

    components_by_tag: dict[str, ComponentInstance] = {}
    for external_id, _symbol, _label, _x, _y, tag, part_number in NODES:
        if tag is None or part_number is None:
            continue
        component = ComponentInstance(
            diagram_id=diagram.id,
            node_id=nodes_by_external_id[external_id].id,
            part_id=parts_by_number[part_number].id,
            tag=tag,
            quantity=1,
            properties={"node_external_id": external_id},
        )
        components_by_tag[tag] = component
        db.add(component)
    db.flush()

    for requirement_data in REQUIREMENTS:
        trace_tag = requirement_data.pop("trace_tag")
        requirement = Requirement(project_id=project.id, **requirement_data)
        db.add(requirement)
        db.flush()
        db.add(
            TraceLink(
                source_type="requirement",
                source_id=requirement.id,
                target_type="component",
                target_id=components_by_tag[trace_tag].id,
                link_type="satisfied_by",
            )
        )

    generate_bom_snapshot(db, diagram)
    db.commit()
    logger.info("Seeded demo project '%s'", DEMO_PROJECT_NAME)


def main() -> None:
    ensure_bootstrap_admin()
    with SessionLocal() as db:
        existing = db.scalar(select(Project).where(Project.name == DEMO_PROJECT_NAME))
        if existing is not None:
            logger.info("Demo project already present; nothing to do.")
            return
        seed_demo(db)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    main()
