"""Legacy diagrams are import-only: listed and read for conversion into drawings, deletable."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from tests.legacy import add_legacy_diagram


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
