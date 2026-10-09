"""Regression tests for the Phase 0 data-integrity fixes (see docs/gap-analysis.md).

The legacy diagram editor's write paths (graph saves, component placement) are
retired, so the binding and placement regressions went with them; what remains
covers the guards that still apply to legacy rows already in a database.
"""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from tests.legacy import LegacyDiagram, add_legacy_bom, add_legacy_diagram


def make_system(client: TestClient, name: str = "P&ID") -> tuple[dict, dict]:
    project = client.post("/projects", json={"name": f"Project {name}"}).json()
    system = client.post(
        f"/projects/{project['id']}/systems", json={"name": f"System {name}"}
    ).json()
    return project, system


def make_part(client: TestClient, part_number: str, **fields) -> dict:
    return client.post(
        "/parts",
        json={
            "part_number": part_number,
            "description": "Test part",
            "part_type": "valve",
            **fields,
        },
    ).json()


# --- B3: parts placed on diagrams must not be deletable ---


def test_delete_part_used_on_legacy_diagram_blocked_until_diagram_removed(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    _, system = make_system(client)
    part = make_part(client, "B3-PART")
    diagram: LegacyDiagram = add_legacy_diagram(
        session_factory, system["id"], components=[("R-1", part["id"])]
    )

    blocked = client.delete(f"/parts/{part['id']}")
    client.delete(f"/diagrams/{diagram.id}")
    allowed = client.delete(f"/parts/{part['id']}")

    assert blocked.status_code == 409
    assert allowed.status_code == 204


# --- B4/B10/B11: blank identifier validation ---


def test_blank_identifiers_rejected(client: TestClient) -> None:
    project, _ = make_system(client)

    blank_part = client.post(
        "/parts", json={"part_number": "  ", "description": "x", "part_type": "valve"}
    )
    blank_requirement = client.post(
        "/requirements",
        json={
            "project_id": project["id"],
            "key": "",
            "title": "t",
            "text": "x",
            "requirement_type": "safety",
        },
    )

    assert blank_part.status_code == 422
    assert blank_requirement.status_code == 422


# --- B6: trace links must reference real objects and not duplicate ---


def test_trace_link_validation(client: TestClient) -> None:
    project, _ = make_system(client)
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
    drawing = client.post(f"/projects/{project['id']}/drawings", json={"title": "P&ID"}).json()
    link = {
        "source_type": "requirement",
        "source_id": requirement["id"],
        "target_type": "drawing",
        "target_id": drawing["id"],
        "link_type": "satisfied_by",
    }

    missing_target = client.post("/trace-links", json={**link, "target_id": "nonexistent"})
    unknown_type = client.post("/trace-links", json={**link, "source_type": "starship"})
    created = client.post("/trace-links", json=link)
    duplicate = client.post("/trace-links", json=link)

    assert missing_target.status_code == 404
    assert unknown_type.status_code == 422
    assert created.status_code == 201
    assert duplicate.status_code == 409


# --- B9: CSV export carries a filename and engineering columns ---


def test_bom_csv_has_filename_and_engineering_columns(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    _, system = make_system(client)
    part = make_part(client, "B9-PART", material="316L", pressure_rating_bar=350, mass_kg=1.2)
    diagram = add_legacy_diagram(
        session_factory, system["id"], "Feed System", components=[("V-1", part["id"])]
    )
    snapshot_id = add_legacy_bom(session_factory, diagram.id)

    response = client.get(f"/bom/{snapshot_id}/csv")
    header = response.text.splitlines()[0]

    assert "attachment; filename=" in response.headers["content-disposition"]
    assert "feed-system" in response.headers["content-disposition"]
    assert "material" in header
    assert "pressure_rating_bar" in header
    assert "mass_kg" in header
    assert "component_tags" in header
    assert "316L" in response.text
