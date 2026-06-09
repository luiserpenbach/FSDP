from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import get_db
from app.main import app
from app.models import Base


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

    def override_get_db() -> Generator[Session, None, None]:
        db = session_local()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)


def test_workflow_lists_saved_diagram_and_places_component_on_node(client: TestClient) -> None:
    project = client.post("/projects", json={"name": "Demo"}).json()
    system = client.post(
        f"/projects/{project['id']}/systems",
        json={"name": "Pressurization", "fluid": "GHe"},
    ).json()
    diagram = client.post(
        f"/systems/{system['id']}/diagrams",
        json={"name": "P&ID"},
    ).json()

    graph_payload = {
        "graph": {
            "nodes": [{"id": "valve-1", "position": {"x": 0, "y": 0}, "data": {"label": "Valve"}}],
            "edges": [],
        },
        "nodes": [
            {
                "external_id": "valve-1",
                "node_type": "component",
                "label": "Valve",
                "position": {"x": 0, "y": 0},
                "properties": {},
            }
        ],
        "edges": [],
    }
    updated_diagram = client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload).json()
    diagrams = client.get(f"/systems/{system['id']}/diagrams").json()

    part = client.post(
        "/parts",
        json={
            "part_number": "VALVE-100",
            "description": "Solenoid valve",
            "part_type": "valve",
        },
    ).json()
    component = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={
            "tag": "V-1",
            "part_id": part["id"],
            "properties": {"node_external_id": "valve-1"},
        },
    ).json()
    bom = client.post(f"/diagrams/{diagram['id']}/bom").json()

    assert updated_diagram["revision"] == 2
    assert diagrams[0]["id"] == diagram["id"]
    assert diagrams[0]["graph"]["nodes"][0]["id"] == "valve-1"
    assert component["node_id"] is not None
    assert bom["rows"][0]["part_number"] == "VALVE-100"


def test_duplicate_validation_and_core_delete_flow(client: TestClient) -> None:
    project = client.post("/projects", json={"name": "Demo"}).json()
    duplicate_project = client.post("/projects", json={"name": "Demo"})
    duplicate_project_with_spacing = client.post("/projects", json={"name": " demo "})
    blank_project_update = client.put(f"/projects/{project['id']}", json={"name": "   "})

    part = client.post(
        "/parts",
        json={
            "part_number": "VALVE-200",
            "description": "Solenoid valve",
            "part_type": "valve",
        },
    ).json()
    duplicate_part = client.post(
        "/parts",
        json={
            "part_number": "VALVE-200",
            "description": "Another valve",
            "part_type": "valve",
        },
    )
    updated_part = client.put(
        f"/parts/{part['id']}",
        json={"description": "Updated solenoid valve"},
    ).json()
    delete_part = client.delete(f"/parts/{part['id']}")
    delete_project = client.delete(f"/projects/{project['id']}")

    assert duplicate_project.status_code == 409
    assert duplicate_project_with_spacing.status_code == 409
    assert blank_project_update.status_code == 422
    assert duplicate_part.status_code == 409
    assert updated_part["description"] == "Updated solenoid valve"
    assert delete_part.status_code == 204
    assert delete_project.status_code == 204


def test_system_names_are_unique_within_project(client: TestClient) -> None:
    project = client.post("/projects", json={"name": "Vehicle A"}).json()
    other_project = client.post("/projects", json={"name": "Vehicle B"}).json()

    system = client.post(
        f"/projects/{project['id']}/systems",
        json={"name": "Helium Pressurization", "fluid": "GHe"},
    ).json()
    duplicate_same_project = client.post(
        f"/projects/{project['id']}/systems",
        json={"name": " helium pressurization ", "fluid": "GHe"},
    )
    same_name_other_project = client.post(
        f"/projects/{other_project['id']}/systems",
        json={"name": "Helium Pressurization", "fluid": "GHe"},
    )
    blank_system_update = client.put(f"/systems/{system['id']}", json={"name": "   "})

    assert duplicate_same_project.status_code == 409
    assert same_name_other_project.status_code == 201
    assert blank_system_update.status_code == 422
