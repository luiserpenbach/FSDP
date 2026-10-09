"""Legacy diagrams are import-only: listed and read for conversion into drawings, deletable."""

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Project
from app.seed import DEMO_PROJECT_NAME, seed_demo
from tests.legacy import add_legacy_bom, add_legacy_diagram, add_legacy_trace_link

GRAPH = {
    "nodes": [{"id": "v1", "type": "pidSymbol", "position": {"x": 0, "y": 0}, "data": {}}],
    "edges": [],
}
SCHEMATIC = {
    "schemaVersion": 1,
    "sheet": {"size": "A3", "orientation": "landscape", "frame": {"kind": "basic"}},
    "layers": [],
    "items": [],
    "meta": {"grid": 2.5},
}


def test_legacy_diagrams_components_and_boms_stay_readable(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    project = client.post("/projects", json={"name": "Read"}).json()
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "GHe"}).json()
    plain = add_legacy_diagram(session_factory, system["id"], "Plain", graph=GRAPH)
    drafted = add_legacy_diagram(session_factory, system["id"], "Drafted", schematic=SCHEMATIC)
    diagram = add_legacy_diagram(session_factory, system["id"], "Parts", components=[("V-1", None)])
    snapshot_id = add_legacy_bom(session_factory, diagram.id)

    listed = client.get(f"/systems/{system['id']}/diagrams").json()
    assert {row["name"] for row in listed} == {"Plain", "Drafted", "Parts"}
    assert client.get(f"/diagrams/{plain.id}").json()["graph"] == GRAPH
    assert client.get(f"/diagrams/{plain.id}/schematic").json() == {
        "diagram_id": plain.id,
        "revision": 1,
        "document": None,
    }
    assert client.get(f"/diagrams/{drafted.id}/schematic").json()["document"] == SCHEMATIC
    components = client.get(f"/diagrams/{diagram.id}/components").json()
    assert [(row["tag"], row["quantity"]) for row in components] == [("V-1", 1)]
    assert [row["id"] for row in client.get(f"/diagrams/{diagram.id}/bom").json()] == [snapshot_id]
    assert client.get(f"/bom/{snapshot_id}/readiness").status_code == 200
    assert client.get(f"/bom/{snapshot_id}/csv").status_code == 200


def test_legacy_write_endpoints_are_gone(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    project = client.post("/projects", json={"name": "Writes"}).json()
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "GHe"}).json()
    diagram = add_legacy_diagram(session_factory, system["id"], components=[("V-1", None)])
    component_id = diagram.components["V-1"]

    for method, path, body in (
        ("POST", f"/systems/{system['id']}/diagrams", {"name": "New"}),
        ("PUT", f"/diagrams/{diagram.id}", {"name": "Renamed"}),
        ("PUT", f"/diagrams/{diagram.id}/graph", {"graph": {}, "nodes": [], "edges": []}),
        ("PUT", f"/diagrams/{diagram.id}/schematic", {"document": SCHEMATIC}),
        ("POST", f"/diagrams/{diagram.id}/components", {"tag": "V-2"}),
        ("PUT", f"/components/{component_id}", {"tag": "V-3"}),
        ("DELETE", f"/components/{component_id}", None),
        ("POST", f"/diagrams/{diagram.id}/bom", None),
    ):
        response = client.request(method, path, json=body)
        assert response.status_code in (404, 405), (method, path, response.status_code)

    assert client.get(f"/diagrams/{diagram.id}").json()["name"] == "Legacy P&ID"
    assert len(client.get(f"/diagrams/{diagram.id}/components").json()) == 1
    assert client.get(f"/diagrams/{diagram.id}/bom").json() == []


def test_new_trace_links_to_legacy_objects_are_refused(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    project = client.post("/projects", json={"name": "Links"}).json()
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "GHe"}).json()
    diagram = add_legacy_diagram(session_factory, system["id"], components=[("V-1", None)])
    requirement = client.post(
        "/requirements",
        json={
            "project_id": project["id"],
            "key": "REQ-1",
            "title": "t",
            "text": "x",
            "requirement_type": "safety",
        },
    ).json()
    existing = add_legacy_trace_link(
        session_factory,
        ("requirement", requirement["id"]),
        ("component", diagram.components["V-1"]),
    )

    for target in (("component", diagram.components["V-1"]), ("diagram", diagram.id)):
        response = client.post(
            "/trace-links",
            json={
                "source_type": "requirement",
                "source_id": requirement["id"],
                "target_type": target[0],
                "target_id": target[1],
                "link_type": "verified_by",
            },
        )
        assert response.status_code == 422, target
        assert "read-only" in response.json()["detail"]

    # Links made before stay readable and removable.
    trace = client.get(f"/objects/requirement/{requirement['id']}/trace").json()
    assert [link["id"] for link in trace] == [existing]
    assert client.delete(f"/trace-links/{existing}").status_code == 204


def test_demo_seed_creates_a_convertible_legacy_diagram(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    with session_factory() as db:
        seed_demo(db)
        project_id = db.scalar(select(Project.id).where(Project.name == DEMO_PROJECT_NAME))
        assert db.scalar(select(func.count()).select_from(Project)) == 1

    diagrams = client.get(f"/projects/{project_id}/diagrams").json()
    assert [row["name"] for row in diagrams] == ["Pressurization P&ID"]
    graph = client.get(f"/diagrams/{diagrams[0]['id']}").json()["graph"]
    assert len(graph["nodes"]) == 7
    assert len(graph["edges"]) == 6
    components = client.get(f"/diagrams/{diagrams[0]['id']}/components").json()
    assert len(components) == 5
    # Conversion matches components to graph nodes by the node's external id.
    graph_node_ids = {node["id"] for node in graph["nodes"]}
    assert {row["node_external_id"] for row in components} <= graph_node_ids
    assert {row["tag"]: row["node_external_id"] for row in components}["F-1"] == "node-filter"
    requirements = client.get(f"/projects/{project_id}/requirements").json()
    assert len(requirements) == 3


def _project_with_systems(client: TestClient) -> tuple[str, dict, dict]:
    project = client.post("/projects", json={"name": "Legacy import"}).json()
    oxidizer = client.post(f"/projects/{project['id']}/systems", json={"name": "Oxidizer"}).json()
    helium = client.post(f"/projects/{project['id']}/systems", json={"name": "helium"}).json()
    return project["id"], oxidizer, helium


def test_project_diagrams_list_every_system_without_graphs(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    project_id, oxidizer, helium = _project_with_systems(client)
    add_legacy_diagram(session_factory, oxidizer["id"], "LOX feed", graph={"nodes": [{"id": "v1"}]})
    add_legacy_diagram(session_factory, helium["id"], "Press")
    add_legacy_diagram(session_factory, helium["id"], "fill")
    other = client.post("/projects", json={"name": "Other"}).json()
    other_system = client.post(f"/projects/{other['id']}/systems", json={"name": "S"}).json()
    add_legacy_diagram(session_factory, other_system["id"], "Elsewhere")

    listing = client.get(f"/projects/{project_id}/diagrams")

    assert listing.status_code == 200
    rows = listing.json()
    # Ordered by system, then diagram name (case-insensitive); graphs stay out of the listing.
    assert [(row["system_id"], row["name"]) for row in rows] == [
        (helium["id"], "fill"),
        (helium["id"], "Press"),
        (oxidizer["id"], "LOX feed"),
    ]
    assert all("graph" not in row for row in rows)
    assert client.get("/projects/missing/diagrams").status_code == 404
