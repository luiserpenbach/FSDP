"""Tests for user-defined P&ID symbol definitions."""

from fastapi.testclient import TestClient

VALVE_SVG = '<path d="M12 10 L32 20 L12 30 Z" /><path d="M52 10 L32 20 L52 30 Z" />'


def test_symbol_crud_roundtrip(client: TestClient) -> None:
    created = client.post(
        "/symbols",
        json={
            "name": "Cryo Valve",
            "view_box": "0 0 64 40",
            "svg": VALVE_SVG,
            "ports": [
                {"id": "in", "x": 2, "y": 20, "side": "left"},
                {"id": "out", "x": 62, "y": 20, "side": "right"},
            ],
        },
    )
    assert created.status_code == 201, created.text
    symbol = created.json()
    assert symbol["name"] == "Cryo Valve"
    assert [port["id"] for port in symbol["ports"]] == ["in", "out"]

    listed = client.get("/symbols").json()
    assert [entry["id"] for entry in listed] == [symbol["id"]]

    updated = client.put(
        f"/symbols/{symbol['id']}",
        json={"ports": [{"id": "in", "x": 4, "y": 20, "side": "left"}]},
    )
    assert updated.status_code == 200, updated.text
    assert len(updated.json()["ports"]) == 1
    assert updated.json()["svg"] == VALVE_SVG

    deleted = client.delete(f"/symbols/{symbol['id']}")
    assert deleted.status_code == 204
    assert client.get("/symbols").json() == []


def test_symbol_duplicate_name_rejected(client: TestClient) -> None:
    payload = {"name": "Filter", "svg": VALVE_SVG, "ports": []}
    assert client.post("/symbols", json=payload).status_code == 201
    duplicate = client.post("/symbols", json={**payload, "name": "  filter "})
    assert duplicate.status_code == 409


def test_symbol_rejects_active_svg_content(client: TestClient) -> None:
    for svg in (
        "<script>alert(1)</script>",
        '<circle cx="1" cy="1" r="1" onload="alert(1)" />',
        '<a href="javascript:alert(1)">x</a>',
    ):
        response = client.post("/symbols", json={"name": "Bad", "svg": svg, "ports": []})
        assert response.status_code == 422, svg


def test_symbol_rejects_invalid_port_side(client: TestClient) -> None:
    response = client.post(
        "/symbols",
        json={
            "name": "Bad Ports",
            "svg": VALVE_SVG,
            "ports": [{"id": "p", "x": 0, "y": 0, "side": "diagonal"}],
        },
    )
    assert response.status_code == 422
