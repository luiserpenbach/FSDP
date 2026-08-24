"""Phase A catalog: numbering, lifecycle, search, usage, documents."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api import routes as routes_mod
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
    assert not any(p.is_file() for p in tmp_path.rglob("*"))


def test_document_delete_keeps_file_when_commit_fails(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    """Unlinking before commit permanently loses bytes if the DB write fails."""
    monkeypatch.setattr(settings, "catalog_files_dir", str(tmp_path))
    part = client.post(
        "/parts",
        json={"part_number": "DOC-KEEP", "description": "Valve", "part_type": "valve"},
    ).json()
    upload = client.post(
        f"/parts/{part['id']}/documents",
        files={"file": ("datasheet.pdf", b"%PDF-1.4 keep-me", "application/pdf")},
        data={"title": "Datasheet", "kind": "datasheet"},
    )
    assert upload.status_code == 201, upload.text
    document = upload.json()
    stored = next(p for p in tmp_path.rglob("*") if p.is_file())
    assert stored.read_bytes().startswith(b"%PDF")

    def failing_commit(self: Session) -> None:
        raise RuntimeError("simulated commit failure")

    monkeypatch.setattr(Session, "commit", failing_commit)
    with pytest.raises(RuntimeError, match="simulated commit failure"):
        client.delete(f"/parts/{part['id']}/documents/{document['id']}")
    monkeypatch.undo()

    assert stored.is_file(), "file must survive a failed delete commit"
    assert stored.read_bytes().startswith(b"%PDF")
    listed = client.get(f"/parts/{part['id']}/documents").json()
    assert len(listed) == 1
    assert listed[0]["id"] == document["id"]


def test_part_delete_unlinks_files_only_after_commit(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "catalog_files_dir", str(tmp_path))
    part = client.post(
        "/parts",
        json={"part_number": "DOC-PART", "description": "Valve", "part_type": "valve"},
    ).json()
    upload = client.post(
        f"/parts/{part['id']}/documents",
        files={"file": ("drawing.pdf", b"%PDF-1.4 part-del", "application/pdf")},
        data={"kind": "drawing"},
    )
    assert upload.status_code == 201, upload.text
    stored = next(p for p in tmp_path.rglob("*") if p.is_file())

    deleted = client.delete(f"/parts/{part['id']}")
    assert deleted.status_code == 204
    assert not stored.exists()
    assert client.get(f"/parts/{part['id']}").status_code == 404


def test_document_upload_rejects_oversized_with_capped_read(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "catalog_files_dir", str(tmp_path))
    monkeypatch.setattr(routes_mod, "MAX_DOCUMENT_BYTES", 32)
    part = client.post(
        "/parts",
        json={"part_number": "DOC-BIG", "description": "Valve", "part_type": "valve"},
    ).json()

    rejected = client.post(
        f"/parts/{part['id']}/documents",
        files={"file": ("big.pdf", b"x" * 64, "application/pdf")},
        data={"kind": "other"},
    )
    assert rejected.status_code == 413
    assert client.get(f"/parts/{part['id']}/documents").json() == []
