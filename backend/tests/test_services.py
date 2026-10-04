from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import (
    Base,
    BomSnapshot,
    ComponentInstance,
    Diagram,
    FluidSystem,
    Part,
    Project,
    Requirement,
    TraceLink,
)
from app.services.catalog import qualification_warnings
from app.services.change_impact import get_change_impact
from app.services.traceability import get_trace_links


def make_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine)


def test_traceability_returns_links_in_both_directions() -> None:
    db = make_session()
    requirement = Requirement(
        project=Project(name="Demo"),
        key="REQ-1",
        title="Pressure compatibility",
        text="Components shall satisfy MEOP.",
        requirement_type="safety",
    )
    component = ComponentInstance(
        diagram=Diagram(
            system=FluidSystem(name="Feed", project=requirement.project), name="P&ID", graph={}
        ),
        tag="V-1",
    )
    db.add_all([requirement, component])
    db.flush()
    db.add(
        TraceLink(
            source_type="requirement",
            source_id=requirement.id,
            target_type="component",
            target_id=component.id,
            link_type="satisfied_by",
        )
    )
    db.flush()

    assert len(get_trace_links(db, "requirement", requirement.id)) == 1
    assert len(get_trace_links(db, "component", component.id)) == 1


def test_change_impact_finds_component_and_bom_usage_for_part() -> None:
    db = make_session()
    project = Project(name="Demo")
    system = FluidSystem(project=project, name="Feed")
    diagram = Diagram(system=system, name="P&ID", graph={})
    part = Part(part_number="REG-001", description="Regulator", part_type="regulator")
    db.add_all([project, system, diagram, part])
    db.flush()
    component = ComponentInstance(diagram_id=diagram.id, part_id=part.id, tag="REG-1")
    # A legacy diagram BoM snapshot, as the retired generator left them.
    db.add_all([component, BomSnapshot(diagram_id=diagram.id, revision=1, rows=[])])
    db.flush()

    impact = get_change_impact(db, "part", part.id)

    assert [item.id for item in impact["affected_components"]] == [component.id]
    assert len(impact["affected_bom_snapshots"]) == 1


def test_catalog_warnings_flag_missing_engineering_data() -> None:
    part = Part(part_number="TBD", description="Candidate valve", part_type="valve")

    assert qualification_warnings(part) == [
        "Part is not qualified or preferred.",
        "Pressure rating is missing.",
        "Material is missing.",
    ]
