"""Project tag schemes and custom symbol library metadata."""

from fastapi.testclient import TestClient


def test_tag_scheme_defaults_to_none_and_upserts(client: TestClient) -> None:
    project_id = client.post("/projects", json={"name": "AMB2"}).json()["id"]

    empty = client.get(f"/projects/{project_id}/tag-scheme")
    assert empty.status_code == 200, empty.text
    assert empty.json() == {"project_id": project_id, "scheme": None}

    scheme = {
        "kind": "structured",
        "separator": " ",
        "functionLetters": [{"letters": "PT", "description": "Pressure transmitter"}],
        "systems": [{"digit": "3", "name": "Helium"}],
        "classes": [{"digit": "2", "name": "Test hardware"}],
        "sequenceLength": 2,
        "strictLetters": False,
    }
    saved = client.put(f"/projects/{project_id}/tag-scheme", json={"scheme": scheme})
    assert saved.status_code == 200, saved.text
    assert saved.json()["scheme"]["systems"][0]["name"] == "Helium"

    updated = client.put(
        f"/projects/{project_id}/tag-scheme", json={"scheme": {**scheme, "separator": "-"}}
    )
    assert updated.status_code == 200
    assert client.get(f"/projects/{project_id}/tag-scheme").json()["scheme"]["separator"] == "-"

    invalid = client.put(f"/projects/{project_id}/tag-scheme", json={"scheme": {"kind": "weird"}})
    assert invalid.status_code == 422
    too_long = client.put(
        f"/projects/{project_id}/tag-scheme", json={"scheme": {"sequenceLength": 9}}
    )
    assert too_long.status_code == 422
    assert client.get("/projects/nope/tag-scheme").status_code == 404

    changes = client.get("/changes").json()
    assert any("tag scheme" in change["summary"] for change in changes)


def test_custom_symbol_library_metadata(client: TestClient) -> None:
    created = client.post(
        "/symbols",
        json={
            "name": "Cryo valve",
            "svg": '<path d="M2 20 H62"/>',
            "ports": [{"id": "in", "x": 2, "y": 20, "side": "left"}],
            "category": "valve",
            "legend": "CRYOGENIC VALVE",
            "tag_prefix": "CXV",
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["legend"] == "CRYOGENIC VALVE"
    assert created.json()["tag_prefix"] == "CXV"

    updated = client.put(f"/symbols/{created.json()['id']}", json={"category": "inline"})
    assert updated.status_code == 200, updated.text
    assert updated.json()["category"] == "inline"
    assert updated.json()["legend"] == "CRYOGENIC VALVE"

    listed = client.get("/symbols").json()
    assert listed[0]["tag_prefix"] == "CXV"
