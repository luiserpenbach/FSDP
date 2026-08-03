"""Tests for Phase 3 (BoM workflow, trace links) and Phase 4 (roles)."""

from fastapi.testclient import TestClient

from app.main import app


def make_diagram_with_bom(client: TestClient) -> tuple[dict, dict, dict]:
    project = client.post("/projects", json={"name": "P3 Project"}).json()
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "P3 System"}).json()
    diagram = client.post(f"/systems/{system['id']}/diagrams", json={"name": "P3 P&ID"}).json()
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
    client.post(f"/diagrams/{diagram['id']}/components", json={"tag": "V-1", "part_id": part["id"]})
    snapshot = client.post(f"/diagrams/{diagram['id']}/bom").json()
    return diagram, part, snapshot


def test_bom_status_workflow(client: TestClient) -> None:
    _, _, snapshot = make_diagram_with_bom(client)

    released = client.put(f"/bom/{snapshot['id']}/status", json={"status": "released"})
    invalid = client.put(f"/bom/{snapshot['id']}/status", json={"status": "shipped"})

    assert released.status_code == 200
    assert released.json()["status"] == "released"
    assert invalid.status_code == 422

    changes = client.get("/changes").json()
    assert any("status set to released" in change["summary"] for change in changes)


def test_bom_readiness_flags_unqualified_and_unresolved(client: TestClient) -> None:
    diagram, _, _ = make_diagram_with_bom(client)
    bad_part = client.post(
        "/parts",
        json={"part_number": "P3-UNQUAL", "description": "Sketchy valve", "part_type": "valve"},
    ).json()
    client.post(
        f"/diagrams/{diagram['id']}/components", json={"tag": "V-2", "part_id": bad_part["id"]}
    )
    client.post(f"/diagrams/{diagram['id']}/components", json={"tag": "X-1"})
    snapshot = client.post(f"/diagrams/{diagram['id']}/bom").json()

    readiness = client.get(f"/bom/{snapshot['id']}/readiness").json()

    assert readiness["ready"] is False
    assert readiness["row_count"] == 3
    assert readiness["issue_count"] == 2
    issue_parts = {issue["part_number"] for issue in readiness["issues"]}
    assert issue_parts == {"P3-UNQUAL", None}
    unqualified = next(i for i in readiness["issues"] if i["part_number"] == "P3-UNQUAL")
    assert "Part is not qualified or preferred." in unqualified["warnings"]


def test_bom_readiness_all_clear(client: TestClient) -> None:
    _, _, snapshot = make_diagram_with_bom(client)

    readiness = client.get(f"/bom/{snapshot['id']}/readiness").json()

    assert readiness["ready"] is True
    assert readiness["issues"] == []


def test_bom_diff_reports_added_removed_and_quantity_changes(client: TestClient) -> None:
    diagram, part, first = make_diagram_with_bom(client)
    components = client.get(f"/diagrams/{diagram['id']}/components").json()
    client.put(f"/components/{components[0]['id']}", json={"quantity": 3})
    new_part = client.post(
        "/parts",
        json={"part_number": "P3-REG", "description": "Regulator", "part_type": "regulator"},
    ).json()
    client.post(
        f"/diagrams/{diagram['id']}/components", json={"tag": "PR-1", "part_id": new_part["id"]}
    )
    second = client.post(f"/diagrams/{diagram['id']}/bom").json()

    diff = client.get(f"/bom/{second['id']}/diff", params={"against_id": first["id"]}).json()

    assert [row["part_number"] for row in diff["added"]] == ["P3-REG"]
    assert diff["removed"] == []
    assert len(diff["changed"]) == 1
    assert diff["changed"][0]["part_number"] == "P3-VALVE"
    assert diff["changed"][0]["from_quantity"] == 1
    assert diff["changed"][0]["to_quantity"] == 3
    assert part["id"]  # baseline part still exists


def test_bom_diff_requires_same_diagram(client: TestClient) -> None:
    _, _, first = make_diagram_with_bom(client)
    project = client.post("/projects", json={"name": "Other Project"}).json()
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "Other"}).json()
    diagram = client.post(f"/systems/{system['id']}/diagrams", json={"name": "Other P&ID"}).json()
    other = client.post(f"/diagrams/{diagram['id']}/bom").json()

    response = client.get(f"/bom/{other['id']}/diff", params={"against_id": first["id"]})

    assert response.status_code == 400


def test_project_bom_listing_includes_diagram_name(client: TestClient) -> None:
    diagram, _, _ = make_diagram_with_bom(client)
    system = client.get(f"/diagrams/{diagram['id']}").json()["system_id"]
    project_id = client.get(f"/systems/{system}/diagrams").json()  # noqa: F841 - sanity fetch

    projects = client.get("/projects").json()
    listing = client.get(f"/projects/{projects[0]['id']}/bom").json()

    assert listing
    assert listing[0]["diagram_name"] == "P3 P&ID"


def test_trace_link_delete(client: TestClient) -> None:
    diagram, _, _ = make_diagram_with_bom(client)
    projects = client.get("/projects").json()
    requirement = client.post(
        "/requirements",
        json={
            "project_id": projects[0]["id"],
            "key": "P3-REQ-1",
            "title": "t",
            "text": "x",
            "requirement_type": "safety",
        },
    ).json()
    component = client.get(f"/diagrams/{diagram['id']}/components").json()[0]
    link = client.post(
        "/trace-links",
        json={
            "source_type": "requirement",
            "source_id": requirement["id"],
            "target_type": "component",
            "target_id": component["id"],
            "link_type": "satisfied_by",
        },
    ).json()

    deleted = client.delete(f"/trace-links/{link['id']}")
    remaining = client.get(f"/objects/requirement/{requirement['id']}/trace").json()

    assert deleted.status_code == 204
    assert remaining == []


def test_viewer_role_is_read_only(client: TestClient) -> None:
    diagram, _, snapshot = make_diagram_with_bom(client)
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
    can_read_bom = viewer.get(f"/bom/{snapshot['id']}/readiness")
    cannot_create = viewer.post("/projects", json={"name": "Viewer Project"})
    cannot_generate = viewer.post(f"/diagrams/{diagram['id']}/bom")
    cannot_release = viewer.put(f"/bom/{snapshot['id']}/status", json={"status": "released"})
    cannot_delete = viewer.delete(f"/diagrams/{diagram['id']}")

    assert can_read_projects.status_code == 200
    assert can_read_bom.status_code == 200
    assert cannot_create.status_code == 403
    assert cannot_generate.status_code == 403
    assert cannot_release.status_code == 403
    assert cannot_delete.status_code == 403
