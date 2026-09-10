"""Schematic document persistence for the drafting editor."""

from fastapi.testclient import TestClient


def _make_diagram(client: TestClient) -> str:
    project = client.post("/projects", json={"name": "Drafting"}).json()
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "GHe"}).json()
    diagram = client.post(f"/systems/{system['id']}/diagrams", json={"name": "P&ID 1"}).json()
    return diagram["id"]


def _document(items: list[dict] | None = None) -> dict:
    return {
        "schemaVersion": 1,
        "sheet": {
            "size": "A3",
            "orientation": "landscape",
            "frame": {"kind": "basic", "columns": 4, "rows": 3, "margin": 10},
        },
        "layers": [{"id": "process", "name": "Process lines"}],
        "items": items
        if items is not None
        else [
            {
                "id": "v1",
                "kind": "symbol",
                "layer": "symbols",
                "symbol": {"library": "fsdp", "key": "valve", "version": 1},
                "position": {"x": 50, "y": 50},
                "rotation": 0,
                "tag": "HV-1",
                "fields": {},
            },
            {
                "id": "l1",
                "kind": "line",
                "layer": "process",
                "points": [{"x": 60, "y": 50}, {"x": 90, "y": 50}],
                "lineType": "process",
                "fields": {},
            },
        ],
        "meta": {"grid": 2.5},
    }


def test_schematic_starts_empty_and_round_trips(client: TestClient) -> None:
    diagram_id = _make_diagram(client)

    empty = client.get(f"/diagrams/{diagram_id}/schematic")
    assert empty.status_code == 200, empty.text
    assert empty.json() == {"diagram_id": diagram_id, "revision": 1, "document": None}

    saved = client.put(f"/diagrams/{diagram_id}/schematic", json={"document": _document()})
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 2
    assert saved.json()["document"]["items"][0]["tag"] == "HV-1"

    fetched = client.get(f"/diagrams/{diagram_id}/schematic").json()
    assert fetched["document"] == _document()
    assert client.get(f"/diagrams/{diagram_id}").json()["revision"] == 2

    changes = client.get("/changes").json()
    assert any("Saved schematic" in change["summary"] for change in changes)


def test_schematic_validation(client: TestClient) -> None:
    diagram_id = _make_diagram(client)

    wrong_version = dict(_document(), schemaVersion=2)
    response = client.put(f"/diagrams/{diagram_id}/schematic", json={"document": wrong_version})
    assert response.status_code == 422

    duplicate = _document(
        [
            {"id": "a", "kind": "label", "layer": "annotation"},
            {"id": "a", "kind": "label", "layer": "annotation"},
        ]
    )
    response = client.put(f"/diagrams/{diagram_id}/schematic", json={"document": duplicate})
    assert response.status_code == 422
    assert "duplicate item id" in response.text

    missing = client.put("/diagrams/nope/schematic", json={"document": _document()})
    assert missing.status_code == 404


def test_schematic_requires_writer(client: TestClient) -> None:
    diagram_id = _make_diagram(client)
    credentials = {"email": "viewer@fsdp.test", "password": "viewer-password-1"}
    viewer = client.post("/auth/users", json={**credentials, "name": "Viewer", "role": "viewer"})
    assert viewer.status_code == 201, viewer.text
    login = client.post("/auth/login", json=credentials)
    assert login.status_code == 200
    response = client.put(f"/diagrams/{diagram_id}/schematic", json={"document": _document()})
    assert response.status_code == 403
    assert client.get(f"/diagrams/{diagram_id}/schematic").status_code == 200
