"""Phase A catalog: numbering, lifecycle, search, usage, documents."""

from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import settings


def test_generate_name_uses_prefix_seq(client: TestClient) -> None:
    first = client.post("/catalog/generate-name")
    second = client.post("/catalog/generate-name")
    assert first.status_code == 200, first.text
    assert first.json()["part_number"] == "AMPH-001"
    assert second.json()["part_number"] == "AMPH-002"

    created = client.post(
        "/parts",
        json={
            "part_number": first.json()["part_number"],
            "description": "Generated valve",
            "part_type": "valve",
        },
    )
    assert created.status_code == 201
    assert created.json()["lifecycle_status"] == "draft"
    assert created.json()["preferred"] is False
    assert created.json()["completeness"] >= 40


def test_generate_name_uses_project_prefix(client: TestClient) -> None:
    project = client.post(
        "/projects", json={"name": "Vehicle 1", "part_name_prefix": "HV1"}
    ).json()
    name = client.post(f"/catalog/generate-name?project_id={project['id']}").json()
    assert name["part_number"] == "HV1-001"


def test_catalog_settings_admin_update_and_new_type(client: TestClient) -> None:
    listed = client.get("/catalog/settings")
    assert listed.status_code == 200
    assert "valve" in listed.json()["part_types"]

    updated = client.put(
        "/catalog/settings",
        json={"prefix": "TEST", "sequence_padding": 4, "part_types": ["valve", "widget"]},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["prefix"] == "TEST"
    generated = client.post("/catalog/generate-name").json()
    assert generated["part_number"] == "TEST-0001"

    client.post(
        "/parts",
        json={
            "part_number": "CUSTOM-TYPE-1",
            "description": "Odd part",
            "part_type": "burst_disc",
        },
    )
    types = client.get("/catalog/settings").json()["part_types"]
    assert "burst_disc" in types


def test_part_search_and_lifecycle_filters(client: TestClient) -> None:
    client.post(
        "/parts",
        json={
            "part_number": "SRCH-VALVE",
            "description": "Helium solenoid",
            "part_type": "valve",
            "manufacturer": "Swagelok",
            "lifecycle_status": "active",
        },
    )
    client.post(
        "/parts",
        json={
            "part_number": "SRCH-FILTER",
            "description": "Sintered filter",
            "part_type": "filter",
        },
    )
    helium = client.get("/parts?q=helium").json()
    assert [row["part_number"] for row in helium] == ["SRCH-VALVE"]
    drafts = client.get("/parts?lifecycle_status=draft").json()
    assert {row["part_number"] for row in drafts} == {"SRCH-FILTER"}


def test_obsolete_blocks_new_placement_and_delete_while_used(client: TestClient) -> None:
    project = client.post("/projects", json={"name": "Cat Project"}).json()
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "Sys"}).json()
    diagram = client.post(f"/systems/{system['id']}/diagrams", json={"name": "P&ID"}).json()
    part = client.post(
        "/parts",
        json={"part_number": "OBS-1", "description": "Valve", "part_type": "valve"},
    ).json()
    client.post(
        f"/diagrams/{diagram['id']}/components", json={"tag": "V-1", "part_id": part["id"]}
    )

    obsolete = client.post(f"/parts/{part['id']}/obsolete")
    assert obsolete.status_code == 200
    assert obsolete.json()["lifecycle_status"] == "obsolete"

    blocked_place = client.post(
        f"/diagrams/{diagram['id']}/components", json={"tag": "V-2", "part_id": part["id"]}
    )
    assert blocked_place.status_code == 409

    blocked_delete = client.delete(f"/parts/{part['id']}")
    assert blocked_delete.status_code == 409

    usage = client.get(f"/parts/{part['id']}/usage")
    assert usage.status_code == 200
    assert usage.json()["components"][0]["tag"] == "V-1"
    assert usage.json()["components"][0]["project_name"] == "Cat Project"


def test_document_upload_download_delete(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "catalog_files_dir", str(tmp_path))
    part = client.post(
        "/parts",
        json={"part_number": "DOC-1", "description": "Valve", "part_type": "valve"},
    ).json()

    upload = client.post(
        f"/parts/{part['id']}/documents",
        files={"file": ("datasheet.pdf", b"%PDF-1.4 test", "application/pdf")},
        data={"title": "Datasheet", "kind": "datasheet"},
    )
    assert upload.status_code == 201, upload.text
    document = upload.json()
    assert document["title"] == "Datasheet"
    assert document["kind"] == "datasheet"

    listed = client.get(f"/parts/{part['id']}/documents").json()
    assert len(listed) == 1

    downloaded = client.get(f"/parts/{part['id']}/documents/{document['id']}/file")
    assert downloaded.status_code == 200
    assert downloaded.content.startswith(b"%PDF")

    rejected = client.post(
        f"/parts/{part['id']}/documents",
        files={"file": ("notes.exe", b"MZ", "application/octet-stream")},
    )
    assert rejected.status_code == 422

    deleted = client.delete(f"/parts/{part['id']}/documents/{document['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/parts/{part['id']}/documents").json() == []
