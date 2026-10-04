"""Bulk edit and bulk delete of catalog parts and project requirements (Excel parity, §2.4)."""

from fastapi.testclient import TestClient

from app.main import app

CONSTRAINT = {"kind": "material_in", "values": ["316L"]}


def _project(client: TestClient, name: str = "AMB2") -> str:
    return client.post("/projects", json={"name": name}).json()["id"]


def _part(client: TestClient, number: str, **extra) -> dict:
    body = {
        "part_number": number,
        "description": f"Valve {number}",
        "part_type": "valve",
        "material": "316L",
        "pressure_rating_bar": 200,
        **extra,
    }
    created = client.post("/parts", json=body)
    assert created.status_code == 201, created.text
    return created.json()


def _requirement(client: TestClient, project_id: str, key: str, **extra) -> dict:
    body = {
        "project_id": project_id,
        "key": key,
        "title": "Wetted",
        "text": "316L wetted parts",
        "requirement_type": "materials",
        **extra,
    }
    created = client.post("/requirements", json=body)
    assert created.status_code == 201, created.text
    return created.json()


def _document() -> dict:
    return {
        "schemaVersion": 1,
        "sheet": {
            "size": "A3",
            "orientation": "landscape",
            "frame": {"kind": "basic", "columns": 4, "rows": 3, "margin": 10},
        },
        "layers": [],
        "items": [
            {
                "id": "hv",
                "kind": "symbol",
                "layer": "symbols",
                "symbol": {"library": "fsdp", "key": "valve", "version": 1},
                "position": {"x": 50, "y": 50},
                "rotation": 0,
                "tag": "HV",
                "fields": {},
            }
        ],
        "meta": {"grid": 2.5},
    }


def _indexed_sheet(client: TestClient, project_id: str, part_id: str | None = None) -> str:
    drawing = client.post(
        f"/projects/{project_id}/drawings",
        json={"title": "P&ID", "first_sheet": {"document": _document()}},
    ).json()
    sheet_id = drawing["sheets"][0]["id"]
    saved = client.put(
        f"/sheets/{sheet_id}",
        json={
            "document": _document(),
            "index": {
                "items": [{"item_id": "hv", "kind": "symbol", "tag": "HV", "part_id": part_id}],
                "lines": [],
            },
            "drc": {"findings": [], "checks": []},
        },
    )
    assert saved.status_code == 200, saved.text
    return sheet_id


def _stale(client: TestClient, sheet_id: str) -> bool:
    return client.get(f"/sheets/{sheet_id}").json()["index_stale"]


def _viewer(client: TestClient) -> TestClient:
    client.post(
        "/auth/users",
        json={
            "email": "viewer@fsdp.test",
            "name": "Viewer",
            "password": "viewer-password",
            "role": "viewer",
        },
    )
    viewer = TestClient(app)
    viewer.post("/auth/login", json={"email": "viewer@fsdp.test", "password": "viewer-password"})
    return viewer


def test_bulk_patch_parts_applies_to_all_and_marks_sheets_stale(client: TestClient) -> None:
    project_id = _project(client)
    used = _part(client, "PV-1001")
    other = _part(client, "PV-1002", lifecycle_status="obsolete")
    unrelated = _part(client, "PV-1003")
    used_sheet = _indexed_sheet(client, project_id, used["id"])
    unrelated_sheet = _indexed_sheet(client, project_id, unrelated["id"])

    response = client.patch(
        "/parts/bulk",
        json={
            "ids": [used["id"], other["id"]],
            "changes": {"lifecycle_status": "obsolete", "manufacturer": "Acme"},
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["updated"] == 2 and body["unchanged"] == 0
    assert [item["id"] for item in body["items"]] == [used["id"], other["id"]]
    assert {item["lifecycle_status"] for item in body["items"]} == {"obsolete"}
    assert {item["manufacturer"] for item in body["items"]} == {"Acme"}
    assert _stale(client, used_sheet) is True
    assert _stale(client, unrelated_sheet) is False

    changes = client.get("/changes").json()
    per_part = [c for c in changes if c["object_type"] == "part" and c["action"] == "updated"]
    assert {c["object_id"] for c in per_part} == {used["id"], other["id"]}
    assert all(c["actor"] == "engineer@fsdp.test" for c in per_part)
    assert any(c["object_type"] == "catalog" and "Bulk edited 2" in c["summary"] for c in changes)

    # Re-applying the same values is a no-op that leaves fresh sheets fresh.
    _indexed_sheet(client, project_id, used["id"])
    again = client.patch(
        "/parts/bulk", json={"ids": [used["id"]], "changes": {"lifecycle_status": "obsolete"}}
    )
    assert again.json()["updated"] == 0 and again.json()["unchanged"] == 1


def test_bulk_patch_parts_is_all_or_none(client: TestClient) -> None:
    part = _part(client, "PV-1001")
    missing = client.patch(
        "/parts/bulk", json={"ids": [part["id"], "nope"], "changes": {"material": "Brass"}}
    )
    assert missing.status_code == 404
    assert "nope" in missing.json()["detail"]
    assert client.get(f"/parts/{part['id']}").json()["material"] == "316L"


def test_bulk_patch_parts_validates_fields_and_values(client: TestClient) -> None:
    part = _part(client, "PV-1001")

    def patch(changes: dict):
        return client.patch("/parts/bulk", json={"ids": [part["id"]], "changes": changes})

    identity = patch({"part_number": "PV-9"})
    assert identity.status_code == 422
    assert "part_number cannot be bulk edited" in identity.json()["detail"]
    bad_enum = patch({"lifecycle_status": "retired"})
    assert bad_enum.status_code == 422
    assert "must be one of" in bad_enum.json()["detail"][0]["msg"]
    not_clearable = patch({"lifecycle_status": None})
    assert not_clearable.status_code == 422
    assert patch({}).status_code == 422
    assert (
        client.patch("/parts/bulk", json={"ids": [], "changes": {"notes": "x"}}).status_code == 422
    )

    cleared = patch({"material": None, "notes": "checked"})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["items"][0]["material"] is None
    assert cleared.json()["items"][0]["notes"] == "checked"


def test_bulk_patch_requirements_scoped_to_project(client: TestClient) -> None:
    project_id = _project(client)
    other_project = _project(client, "Other")
    sheet_id = _indexed_sheet(client, project_id)
    manual = _requirement(client, project_id, "REQ-1")
    checked = _requirement(client, project_id, "REQ-2")
    foreign = _requirement(client, other_project, "REQ-1")
    path = f"/projects/{project_id}/requirements/bulk"

    outside = client.patch(path, json={"ids": [manual["id"], foreign["id"]], "changes": {}})
    assert outside.status_code == 422  # empty changes are refused first
    outside = client.patch(
        path, json={"ids": [manual["id"], foreign["id"]], "changes": {"status": "approved"}}
    )
    assert outside.status_code == 404
    assert client.get(f"/projects/{project_id}/requirements").json()[0]["status"] == "draft"

    response = client.patch(
        path,
        json={
            "ids": [manual["id"], checked["id"]],
            "changes": {"status": "approved", "verification_method": "inspection"},
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["updated"] == 2
    assert {item["status"] for item in response.json()["items"]} == {"approved"}
    # No constraint before or after: the DRC is unaffected.
    assert _stale(client, sheet_id) is False

    constrained = client.patch(
        path, json={"ids": [checked["id"]], "changes": {"constraint": CONSTRAINT}}
    )
    assert constrained.status_code == 200, constrained.text
    assert constrained.json()["items"][0]["constraint"]["kind"] == "material_in"
    assert _stale(client, sheet_id) is True

    title = client.patch(path, json={"ids": [manual["id"]], "changes": {"title": "x"}})
    assert title.status_code == 422


def test_bulk_delete_parts_reports_partial_results(client: TestClient) -> None:
    project_id = _project(client)
    in_use = _part(client, "PV-1001")
    free = _part(client, "PV-1002")
    _indexed_sheet(client, project_id, in_use["id"])

    response = client.post(
        "/parts/bulk-delete", json={"ids": [in_use["id"], free["id"], "nope", free["id"]]}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["deleted"] == 1 and body["refused"] == 2
    results = {result["id"]: result for result in body["results"]}
    assert results[free["id"]] == {"id": free["id"], "deleted": True, "reason": None}
    assert results[in_use["id"]]["deleted"] is False
    assert "PV-1001" in results[in_use["id"]]["reason"]
    assert "obsolete" in results[in_use["id"]]["reason"]
    assert results["nope"] == {"id": "nope", "deleted": False, "reason": "Part not found"}
    assert [part["part_number"] for part in client.get("/parts").json()] == ["PV-1001"]
    deleted_events = [c for c in client.get("/changes").json() if c["action"] == "deleted"]
    assert {c["object_id"] for c in deleted_events} >= {free["id"]}


def test_bulk_delete_requirements(client: TestClient) -> None:
    project_id = _project(client)
    other_project = _project(client, "Other")
    manual = _requirement(client, project_id, "REQ-1")
    checked = _requirement(client, project_id, "REQ-2", constraint=CONSTRAINT)
    sheet_id = _indexed_sheet(client, project_id)  # saved after the constraint went in
    assert _stale(client, sheet_id) is False
    foreign = _requirement(client, other_project, "REQ-9")

    response = client.post(
        f"/projects/{project_id}/requirements/bulk-delete",
        json={"ids": [manual["id"], checked["id"], foreign["id"]]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["deleted"] == 2 and body["refused"] == 1
    assert body["results"][2] == {
        "id": foreign["id"],
        "deleted": False,
        "reason": "Requirement not found in this project",
    }
    assert client.get(f"/projects/{project_id}/requirements").json() == []
    assert len(client.get(f"/projects/{other_project}/requirements").json()) == 1
    assert _stale(client, sheet_id) is True


def test_viewer_cannot_bulk_edit_or_delete(client: TestClient) -> None:
    project_id = _project(client)
    part = _part(client, "PV-1001")
    requirement = _requirement(client, project_id, "REQ-1")
    viewer = _viewer(client)
    calls = [
        viewer.patch("/parts/bulk", json={"ids": [part["id"]], "changes": {"notes": "x"}}),
        viewer.post("/parts/bulk-delete", json={"ids": [part["id"]]}),
        viewer.patch(
            f"/projects/{project_id}/requirements/bulk",
            json={"ids": [requirement["id"]], "changes": {"status": "approved"}},
        ),
        viewer.post(
            f"/projects/{project_id}/requirements/bulk-delete", json={"ids": [requirement["id"]]}
        ),
    ]
    assert [call.status_code for call in calls] == [403, 403, 403, 403]
    assert len(client.get("/parts").json()) == 1
