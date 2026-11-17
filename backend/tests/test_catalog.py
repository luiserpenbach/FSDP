"""Phase A catalog: numbering, lifecycle, search, usage, documents."""

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from tests.legacy import add_legacy_diagram


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


def test_obsolete_part_still_blocks_delete_while_used_on_a_legacy_diagram(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    project = client.post("/projects", json={"name": "Cat Project"}).json()
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "Sys"}).json()
    part = client.post(
        "/parts",
        json={"part_number": "OBS-1", "description": "Valve", "part_type": "valve"},
    ).json()
    add_legacy_diagram(session_factory, system["id"], components=[("V-1", part["id"])])

    obsolete = client.post(f"/parts/{part['id']}/obsolete")
    assert obsolete.status_code == 200
    assert obsolete.json()["lifecycle_status"] == "obsolete"

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


def test_parts_list_pages_sorts_and_counts(client: TestClient) -> None:
    for index in range(7):
        created = client.post(
            "/parts",
            json={
                "part_number": f"PG-{index:02d}",
                "description": f"Paged part {index}",
                "part_type": "valve" if index % 2 else "fitting",
                "pressure_rating_bar": 100 + index,
            },
        )
        assert created.status_code == 201, created.text

    everything = client.get("/parts")
    assert len(everything.json()) == 7
    assert everything.headers["X-Total-Count"] == "7"

    seen: list[str] = []
    for offset in (0, 3, 6):
        page = client.get("/parts", params={"limit": 3, "offset": offset})
        assert page.headers["X-Total-Count"] == "7"
        seen.extend(part["part_number"] for part in page.json())
    assert seen == [f"PG-{index:02d}" for index in range(7)]

    top = client.get("/parts", params={"limit": 2, "sort": "-pressure_rating_bar"}).json()
    assert [part["part_number"] for part in top] == ["PG-06", "PG-05"]

    valves = client.get("/parts", params={"limit": 2, "part_type": "valve"})
    assert valves.headers["X-Total-Count"] == "3"
    assert len(valves.json()) == 2

    assert client.get("/parts", params={"sort": "password_hash"}).status_code == 422
    assert client.get("/parts", params={"limit": 0}).status_code == 422
