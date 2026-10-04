"""Tests for Phase 3 (BoM workflow, trace links) and Phase 4 (roles).

Diagram BoM snapshots are legacy history now: their rows are inserted directly
(tests/legacy.py) and read through the BoM endpoints; drawing BoMs are covered in
test_bom_release.py and test_lists_bom.py.
"""

from dataclasses import dataclass

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.main import app
from app.models import ComponentInstance
from tests.legacy import LegacyDiagram, add_legacy_bom, add_legacy_diagram, add_legacy_trace_link


@dataclass
class LegacySetup:
    project_id: str
    system_id: str
    diagram: LegacyDiagram
    part: dict
    snapshot_id: str


def make_diagram_with_bom(
    client: TestClient, session_factory: sessionmaker[Session], *extra: tuple[str, str | None]
) -> LegacySetup:
    project = client.post("/projects", json={"name": "P3 Project"}).json()
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "P3 System"}).json()
    part = client.post(
        "/parts",
        json={
            "part_number": "P3-VALVE",
            "description": "Valve",
            "part_type": "valve",
            "material": "316L",
            "pressure_rating_bar": 300,
            "qualification_status": "qualified",
        },
    ).json()
    diagram = add_legacy_diagram(
        session_factory, system["id"], "P3 P&ID", components=[("V-1", part["id"]), *extra]
    )
    snapshot_id = add_legacy_bom(session_factory, diagram.id)
    return LegacySetup(project["id"], system["id"], diagram, part, snapshot_id)


def _requirement(client: TestClient, project_id: str, key: str) -> dict:
    return client.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": key,
            "title": "t",
            "text": "x",
            "requirement_type": "safety",
        },
    ).json()


def test_legacy_bom_status_is_read_only(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    setup = make_diagram_with_bom(client, session_factory)

    released = client.put(f"/bom/{setup.snapshot_id}/status", json={"status": "released"})
    invalid = client.put(f"/bom/{setup.snapshot_id}/status", json={"status": "shipped"})

    assert released.status_code == 409
    assert "read-only history" in released.json()["detail"]
    assert invalid.status_code == 422
    assert client.get(f"/projects/{setup.project_id}/bom").json()[0]["status"] == "draft"


def test_bom_readiness_flags_unqualified_and_unresolved(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    bad_part = client.post(
        "/parts",
        json={"part_number": "P3-UNQUAL", "description": "Sketchy valve", "part_type": "valve"},
    ).json()
    setup = make_diagram_with_bom(client, session_factory, ("V-2", bad_part["id"]), ("X-1", None))

    readiness = client.get(f"/bom/{setup.snapshot_id}/readiness").json()

    assert readiness["ready"] is False
    assert readiness["row_count"] == 3
    assert readiness["issue_count"] == 2
    issue_parts = {issue["part_number"] for issue in readiness["issues"]}
    assert issue_parts == {"P3-UNQUAL", None}
    unqualified = next(i for i in readiness["issues"] if i["part_number"] == "P3-UNQUAL")
    assert "Part is not qualified or preferred." in unqualified["warnings"]


def test_bom_readiness_all_clear(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    setup = make_diagram_with_bom(client, session_factory)

    readiness = client.get(f"/bom/{setup.snapshot_id}/readiness").json()

    assert readiness["ready"] is True
    assert readiness["issues"] == []


def test_bom_diff_reports_added_removed_and_quantity_changes(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    setup = make_diagram_with_bom(client, session_factory)
    new_part = client.post(
        "/parts",
        json={"part_number": "P3-REG", "description": "Regulator", "part_type": "regulator"},
    ).json()
    with session_factory() as db:
        db.get(ComponentInstance, setup.diagram.components["V-1"]).quantity = 3
        db.add(ComponentInstance(diagram_id=setup.diagram.id, tag="PR-1", part_id=new_part["id"]))
        db.commit()
    second = add_legacy_bom(session_factory, setup.diagram.id)

    diff = client.get(f"/bom/{second}/diff", params={"against_id": setup.snapshot_id}).json()

    assert [row["part_number"] for row in diff["added"]] == ["P3-REG"]
    assert diff["removed"] == []
    assert len(diff["changed"]) == 1
    assert diff["changed"][0]["part_number"] == "P3-VALVE"
    assert diff["changed"][0]["from_quantity"] == 1
    assert diff["changed"][0]["to_quantity"] == 3


def test_bom_diff_requires_same_diagram(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    setup = make_diagram_with_bom(client, session_factory)
    project = client.post("/projects", json={"name": "Other Project"}).json()
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "Other"}).json()
    other = add_legacy_bom(
        session_factory, add_legacy_diagram(session_factory, system["id"], "Other P&ID").id
    )

    response = client.get(f"/bom/{other}/diff", params={"against_id": setup.snapshot_id})

    assert response.status_code == 400


def test_project_bom_listing_includes_diagram_name(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    setup = make_diagram_with_bom(client, session_factory)

    listing = client.get(f"/projects/{setup.project_id}/bom").json()

    assert listing
    assert listing[0]["diagram_name"] == "P3 P&ID"
    assert client.get(f"/diagrams/{setup.diagram.id}/bom").json()[0]["id"] == setup.snapshot_id


def test_legacy_trace_link_delete(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    setup = make_diagram_with_bom(client, session_factory)
    requirement = _requirement(client, setup.project_id, "P3-REQ-1")
    link_id = add_legacy_trace_link(
        session_factory,
        ("requirement", requirement["id"]),
        ("component", setup.diagram.components["V-1"]),
    )

    deleted = client.delete(f"/trace-links/{link_id}")
    remaining = client.get(f"/objects/requirement/{requirement['id']}/trace").json()

    assert deleted.status_code == 204
    assert remaining == []


def test_deleting_legacy_diagram_removes_its_components_trace_links(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    setup = make_diagram_with_bom(client, session_factory)
    requirement = _requirement(client, setup.project_id, "P3-REQ-ORPHAN")
    add_legacy_trace_link(
        session_factory,
        ("requirement", requirement["id"]),
        ("component", setup.diagram.components["V-1"]),
    )

    deleted = client.delete(f"/diagrams/{setup.diagram.id}")
    remaining = client.get(f"/objects/requirement/{requirement['id']}/trace").json()

    assert deleted.status_code == 204
    assert remaining == []
    assert client.get(f"/projects/{setup.project_id}/bom").json() == []


def test_deleting_requirement_removes_its_trace_links(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    setup = make_diagram_with_bom(client, session_factory)
    requirement = _requirement(client, setup.project_id, "P3-REQ-DEL")
    component_id = setup.diagram.components["V-1"]
    add_legacy_trace_link(
        session_factory, ("requirement", requirement["id"]), ("component", component_id)
    )

    deleted = client.delete(f"/requirements/{requirement['id']}")
    remaining = client.get(f"/objects/component/{component_id}/trace").json()

    assert deleted.status_code == 204
    assert remaining == []


def test_deleting_project_removes_cascaded_object_trace_links(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    setup = make_diagram_with_bom(client, session_factory)
    other = client.post("/projects", json={"name": "Survivor Project"}).json()
    other_req = _requirement(client, other["id"], "KEEP-1")
    requirement = _requirement(client, setup.project_id, "P3-REQ-CASCADE")
    add_legacy_trace_link(
        session_factory,
        ("requirement", requirement["id"]),
        ("component", setup.diagram.components["V-1"]),
    )
    kept_link = client.post(
        "/trace-links",
        json={
            "source_type": "requirement",
            "source_id": other_req["id"],
            "target_type": "project",
            "target_id": other["id"],
            "link_type": "related_to",
        },
    ).json()

    deleted = client.delete(f"/projects/{setup.project_id}")
    orphaned = client.get(f"/objects/requirement/{requirement['id']}/trace").json()
    surviving = client.get(f"/objects/requirement/{other_req['id']}/trace").json()

    assert deleted.status_code == 204
    assert orphaned == []
    assert [link["id"] for link in surviving] == [kept_link["id"]]


def test_viewer_role_is_read_only(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    setup = make_diagram_with_bom(client, session_factory)
    client.post(
        "/auth/users",
        json={
            "email": "viewer@p3.test",
            "name": "Viewer",
            "password": "viewer-password",
            "role": "viewer",
        },
    )
    viewer = TestClient(app)
    login = viewer.post(
        "/auth/login", json={"email": "viewer@p3.test", "password": "viewer-password"}
    )
    assert login.status_code == 200

    can_read_projects = viewer.get("/projects")
    can_read_bom = viewer.get(f"/bom/{setup.snapshot_id}/readiness")
    can_read_diagram = viewer.get(f"/diagrams/{setup.diagram.id}")
    cannot_create = viewer.post("/projects", json={"name": "Viewer Project"})
    cannot_release = viewer.put(f"/bom/{setup.snapshot_id}/status", json={"status": "released"})
    cannot_delete = viewer.delete(f"/diagrams/{setup.diagram.id}")

    assert can_read_projects.status_code == 200
    assert can_read_bom.status_code == 200
    assert can_read_diagram.status_code == 200
    assert cannot_create.status_code == 403
    assert cannot_release.status_code == 403
    assert cannot_delete.status_code == 403
