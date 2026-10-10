"""Demo seed must stay idempotent enough not to brick Render boots."""

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Part, Project
from app.seed import DEMO_PROJECT_NAME, PARTS, REQUIREMENTS, seed_demo


def test_seed_reuses_leftover_catalog_parts_after_demo_project_delete(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Delete/rename of the demo project leaves global AMPH-* parts; next seed must not crash."""
    with session_factory() as db:
        seed_demo(db)
        project = db.scalar(select(Project).where(Project.name == DEMO_PROJECT_NAME))
        assert project is not None
        part_ids = {
            row.part_number: row.id
            for row in db.scalars(select(Part).where(Part.part_number.in_([p["part_number"] for p in PARTS])))
        }
        assert set(part_ids) == {p["part_number"] for p in PARTS}
        db.delete(project)
        db.commit()

    with session_factory() as db:
        assert db.scalar(select(Project).where(Project.name == DEMO_PROJECT_NAME)) is None
        assert db.scalar(select(func.count()).select_from(Part)) == len(PARTS)
        seed_demo(db)
        reseeded_id = db.scalar(select(Project.id).where(Project.name == DEMO_PROJECT_NAME))
        assert reseeded_id is not None
        # Same catalog rows — no duplicate part_numbers, no new Part ids.
        assert {
            row.part_number: row.id
            for row in db.scalars(select(Part).where(Part.part_number.in_(part_ids)))
        } == part_ids

    diagrams = client.get(f"/projects/{reseeded_id}/diagrams").json()
    assert [row["name"] for row in diagrams] == ["Pressurization P&ID"]
    components = client.get(f"/diagrams/{diagrams[0]['id']}/components").json()
    assert len(components) == 5


def test_seed_does_not_mutate_requirement_templates(
    session_factory: sessionmaker[Session],
) -> None:
    """REQUIREMENTS must keep trace_tag so a second call in-process still works."""
    assert all("trace_tag" in row for row in REQUIREMENTS)
    with session_factory() as db:
        seed_demo(db)
    assert all("trace_tag" in row for row in REQUIREMENTS)
    with session_factory() as db:
        project = db.scalar(select(Project).where(Project.name == DEMO_PROJECT_NAME))
        assert project is not None
        db.delete(project)
        db.commit()
        # Parts remain; seed must still succeed and leave templates intact.
        seed_demo(db)
    assert all("trace_tag" in row for row in REQUIREMENTS)
