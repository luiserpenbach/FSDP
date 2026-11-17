"""The seeded test stand P&ID: loads, validates, binds parts, and indexes on the server."""

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Project
from app.seed import DEMO_PROJECT_NAME, seed_demo, seed_test_stand
from tests.test_server_index import real_engine

pytest_plugins = ["tests.test_server_index"]


def _seed(session_factory: sessionmaker[Session]) -> str:
    with session_factory() as db:
        seed_demo(db)
        project = db.scalar(select(Project).where(Project.name == DEMO_PROJECT_NAME))
        assert seed_test_stand(db, project) is True
        # Running the seed again adds nothing.
        assert seed_test_stand(db, project) is False
        return project.id


def test_seed_adds_the_test_stand_drawing_once(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    project_id = _seed(session_factory)
    drawings = client.get(f"/projects/{project_id}/drawings").json()
    assert [(d["number"], d["size"], d["status"]) for d in drawings] == [("TS-0100", "A1", "draft")]
    drawing = drawings[0]
    assert drawing["title"].split("\n")[1] == "PROPELLANT FEED AND PRESSURIZATION"
    assert drawing["current_revision"]["label"] == "A"
    assert [s["name"] for s in client.get(f"/projects/{project_id}/systems").json()] == [
        "Helium Pressurization",
        "Propellant Feed",
    ]
    classes = client.get(f"/projects/{project_id}/line-classes").json()
    assert {c["name"] for c in classes} == {"HP-316", "MP-316", "CRYO-304L"}

    sheet = client.get(f"/sheets/{drawing['sheets'][0]['id']}").json()
    items = sheet["document"]["items"]
    assert len([item for item in items if item["kind"] == "symbol"]) > 80
    # Catalog parts named by the drawing are bound to real part ids.
    parts = {part["id"]: part["part_number"] for part in client.get("/parts").json()}
    bound = {item["tag"]: parts[item["partId"]] for item in items if item.get("partId")}
    assert bound["PCV-001"] == "AMPH-PR-001"
    assert bound["PSV-131"] == "AMPH-RV-001"
    assert len(bound) >= 20
    # The stored document passes the same validation as a save from the editor.
    saved = client.put(f"/sheets/{sheet['id']}", json={"document": sheet["document"]})
    assert saved.status_code == 200, saved.text


@real_engine
def test_seeded_drawing_indexes_on_the_server_without_errors(
    client: TestClient, session_factory: sessionmaker[Session], engine: None
) -> None:
    project_id = _seed(session_factory)
    report = client.post(f"/projects/{project_id}/reindex")
    assert report.status_code == 200, report.text
    assert (report.json()["indexed"], report.json()["failed"]) == (1, 0)

    drawing = client.get(f"/projects/{project_id}/drawings").json()[0]
    assert drawing["sheets"][0]["index_stale"] is False
    drc = client.get(f"/drawings/{drawing['id']}/drc").json()
    assert drc["counts"]["error"] == 0
    valves = client.get(f"/drawings/{drawing['id']}/lists/valve").json()
    assert len(valves["rows"]) > 30
    hits = client.get("/search", params={"q": "XV-141"}).json()["hits"]
    assert [(hit["kind"], hit["title"]) for hit in hits] == [("tag", "XV-141")]
    bom = client.post(f"/drawings/{drawing['id']}/bom")
    assert bom.status_code == 201, bom.text
    assert any(row.get("part_number") == "AMPH-RV-001" for row in bom.json()["rows"])
