"""Drawing release workflow (H6) and stale sheet index tracking (H11)."""

import csv
import io

from fastapi.testclient import TestClient

from app.main import app
from app.services.release import next_revision_label

CONSTRAINT = {"kind": "material_in", "values": ["316L"]}


def _project(client: TestClient, name: str = "AMB2") -> str:
    return client.post("/projects", json={"name": name, "part_name_prefix": "AMB2"}).json()["id"]


def _document(*item_ids: str) -> dict:
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
                "id": item_id,
                "kind": "symbol",
                "layer": "symbols",
                "symbol": {"library": "fsdp", "key": "valve", "version": 1},
                "position": {"x": 50, "y": 50},
                "rotation": 0,
                "tag": item_id.upper(),
                "fields": {},
            }
            for item_id in item_ids
        ],
        "meta": {"grid": 2.5},
    }


def _drawing(client: TestClient, project_id: str, *item_ids: str) -> dict:
    body: dict = {"title": "P&ID\nHELIUM FILL"}
    if item_ids:
        body["first_sheet"] = {"document": _document(*item_ids)}
    created = client.post(f"/projects/{project_id}/drawings", json=body)
    assert created.status_code == 201, created.text
    return created.json()


def _index(part_id: str | None = None, item_id: str = "hv") -> dict:
    return {
        "items": [
            {
                "item_id": item_id,
                "kind": "symbol",
                "category": "valve",
                "symbol_key": "ball_valve",
                "symbol_name": "Ball valve",
                "tag": item_id.upper(),
                "zone": "D-4",
                "part_id": part_id,
            }
        ],
        "lines": [],
    }


def _error(key: str = "duplicate_tag:hv") -> dict:
    return {"key": key, "rule": "duplicate_tag", "severity": "error", "message": "Duplicate HV"}


def _save(
    client: TestClient,
    sheet_id: str,
    part_id: str | None = None,
    findings: list[dict] | None = None,
    item_id: str = "hv",
) -> dict:
    saved = client.put(
        f"/sheets/{sheet_id}",
        json={
            "document": _document(item_id),
            "index": _index(part_id, item_id),
            "drc": {"findings": findings or [], "checks": []},
        },
    )
    assert saved.status_code == 200, saved.text
    return saved.json()


def _sheet_stale(client: TestClient, drawing_id: str) -> list[bool]:
    return [
        sheet["index_stale"] for sheet in client.get(f"/drawings/{drawing_id}").json()["sheets"]
    ]


def _part(client: TestClient, number: str = "AMB2-001", **extra) -> dict:
    body = {
        "part_number": number,
        "description": f"Valve {number}",
        "part_type": "valve",
        "material": "316L",
        "pressure_rating_bar": 200,
        "manufacturer": "Swagelok",
        "qualification_status": "qualified",
        **extra,
    }
    created = client.post("/parts", json=body)
    assert created.status_code == 201, created.text
    return created.json()


def _released(client: TestClient, project_id: str) -> dict:
    drawing = _drawing(client, project_id, "hv")
    _save(client, drawing["sheets"][0]["id"])
    released = client.post(f"/drawings/{drawing['id']}/release")
    assert released.status_code == 200, released.text
    return released.json()


def test_next_revision_label() -> None:
    assert next_revision_label("-", 1) == "A"
    assert next_revision_label(None, 1) == "A"
    assert next_revision_label("A", 2) == "B"
    assert next_revision_label("z", 2) == "AA"
    assert next_revision_label("AZ", 5) == "BA"
    assert next_revision_label("3", 3) == "4"
    assert next_revision_label("A.1", 4) == "5"


def test_status_is_an_enum_changed_only_by_actions(client: TestClient) -> None:
    drawing = _drawing(client, _project(client))
    assert drawing["status"] == "draft"
    assert drawing["current_revision"]["status"] == "draft"

    banana = client.put(f"/drawings/{drawing['id']}", json={"status": "banana"})
    assert banana.status_code == 422
    jump = client.put(f"/drawings/{drawing['id']}", json={"status": "released"})
    assert jump.status_code == 422
    assert "release" in jump.json()["detail"]
    # Echoing the current status (as an edit form does) is fine.
    same = client.put(f"/drawings/{drawing['id']}", json={"status": "draft", "title": "Renamed"})
    assert same.status_code == 200, same.text
    assert same.json()["title"] == "Renamed"


def test_submit_withdraw_and_release_from_review(client: TestClient) -> None:
    drawing = _drawing(client, _project(client), "hv")
    drawing_id = drawing["id"]
    _save(client, drawing["sheets"][0]["id"])

    submitted = client.post(f"/drawings/{drawing_id}/submit")
    assert submitted.status_code == 200, submitted.text
    body = submitted.json()
    assert body["status"] == "in_review"
    assert body["current_revision"]["status"] == "in_review"
    assert body["current_revision"]["submitted_by"] == "engineer@fsdp.test"
    assert body["current_revision"]["submitted_at"]
    assert client.post(f"/drawings/{drawing_id}/submit").status_code == 409

    withdrawn = client.post(f"/drawings/{drawing_id}/withdraw")
    assert withdrawn.json()["status"] == "draft"
    assert client.post(f"/drawings/{drawing_id}/withdraw").status_code == 409
    # Under review the drawing is still editable.
    client.post(f"/drawings/{drawing_id}/submit")
    assert client.put(f"/drawings/{drawing_id}", json={"title": "Edited"}).status_code == 200

    released = client.post(f"/drawings/{drawing_id}/release")
    assert released.status_code == 200, released.text
    body = released.json()
    assert body["status"] == "released"
    revision = body["current_revision"]
    assert revision["status"] == "released"
    assert revision["approved_by"] == "engineer@fsdp.test"
    assert revision["approved_at"]
    assert revision["approved_date"] == revision["approved_at"][:10]
    assert body["revisions"][-1] == revision
    assert client.post(f"/drawings/{drawing_id}/release").status_code == 409
    assert client.post(f"/drawings/{drawing_id}/submit").status_code == 409

    actions = {
        (change["action"], change["actor"])
        for change in client.get("/changes").json()
        if change["object_id"] == drawing_id
    }
    assert {("submitted", "engineer@fsdp.test"), ("withdrawn", "engineer@fsdp.test")} <= actions
    assert ("released", "engineer@fsdp.test") in actions


def test_release_refused_for_stale_index_and_open_drc_errors(client: TestClient) -> None:
    drawing = _drawing(client, _project(client), "hv")
    drawing_id = drawing["id"]
    sheet_id = drawing["sheets"][0]["id"]
    second = client.post(f"/drawings/{drawing_id}/sheets", json={"document": _document("pt")})
    assert second.json()["index_stale"] is True

    refused = client.post(f"/drawings/{drawing_id}/release")
    assert refused.status_code == 409
    detail = refused.json()["detail"]
    assert "cannot be released" in detail["message"]
    assert [(reason["code"], reason["sheet_no"]) for reason in detail["reasons"]] == [
        ("index_stale", 1),
        ("index_stale", 2),
    ]

    _save(client, sheet_id, findings=[_error(), {**_error("open_port:pt"), "severity": "warning"}])
    _save(client, second.json()["id"], item_id="pt")
    refused = client.post(f"/drawings/{drawing_id}/release")
    assert refused.status_code == 409
    reasons = refused.json()["detail"]["reasons"]
    assert [(reason["code"], reason["sheet_no"], reason.get("count")) for reason in reasons] == [
        ("drc_errors", 1, 1)
    ]

    waived = client.put(
        f"/sheets/{sheet_id}/drc/waivers", json={"key": "duplicate_tag:hv", "reason": "Accepted"}
    )
    assert waived.status_code == 201
    released = client.post(f"/drawings/{drawing_id}/release")
    assert released.status_code == 200, released.text
    assert client.get(f"/drawings/{drawing_id}").json()["status"] == "released"


def test_released_drawing_is_locked_but_readable(client: TestClient) -> None:
    project_id = _project(client)
    drawing = _released(client, project_id)
    drawing_id = drawing["id"]
    sheet_id = drawing["sheets"][0]["id"]
    revision_id = drawing["current_revision"]["id"]
    locked = f"Drawing {drawing['number']} is released; start a new revision to change it."

    attempts = [
        client.put(f"/drawings/{drawing_id}", json={"title": "Changed"}),
        client.delete(f"/drawings/{drawing_id}"),
        client.post(f"/drawings/{drawing_id}/sheets", json={}),
        client.put(f"/sheets/{sheet_id}", json={"title": "Changed"}),
        client.delete(f"/sheets/{sheet_id}"),
        client.post(f"/drawings/{drawing_id}/revisions", json={"label": "B", "description": "x"}),
        client.put(f"/revisions/{revision_id}", json={"description": "Changed"}),
        client.put(f"/sheets/{sheet_id}/drc/waivers", json={"key": "k", "reason": "r"}),
        client.delete(f"/sheets/{sheet_id}/drc/waivers/k"),
    ]
    for response in attempts:
        assert response.status_code == 409, response.text
        assert response.json()["detail"] == locked

    assert client.get(f"/drawings/{drawing_id}").status_code == 200
    assert client.get(f"/sheets/{sheet_id}").json()["document"]["items"][0]["id"] == "hv"
    assert client.get(f"/drawings/{drawing_id}/lists/valve").status_code == 200
    assert client.get(f"/drawings/{drawing_id}/lists/valve?format=xlsx").status_code == 200
    assert client.get(f"/drawings/{drawing_id}/drc").status_code == 200
    assert client.post(f"/drawings/{drawing_id}/bom").status_code == 201
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>'
    exported = client.post(f"/sheets/{sheet_id}/export", json={"svg": svg, "format": "svg"})
    assert exported.status_code == 200


def test_release_snapshot_is_immutable_across_revisions(client: TestClient) -> None:
    project_id = _project(client)
    part = _part(client)
    drawing = _drawing(client, project_id, "hv")
    drawing_id = drawing["id"]
    sheet_id = drawing["sheets"][0]["id"]
    _save(client, sheet_id, part_id=part["id"])
    first = client.post(f"/drawings/{drawing_id}/release").json()["current_revision"]

    unreleased = client.post(f"/drawings/{drawing_id}/revise")
    assert unreleased.status_code == 200, unreleased.text
    revised = unreleased.json()
    assert revised["status"] == "draft"
    assert [(rev["label"], rev["sequence"], rev["status"]) for rev in revised["revisions"]] == [
        ("-", 1, "released"),
        ("A", 2, "draft"),
    ]
    assert revised["current_revision"]["description"] == "Revision A"
    assert revised["current_revision"]["approved_by"] is None
    assert client.post(f"/drawings/{drawing_id}/revise").status_code == 409

    # The new revision is editable; the released one is not.
    _save(client, sheet_id, item_id="pt")
    assert client.put(f"/revisions/{first['id']}", json={"description": "x"}).status_code == 409
    current_id = revised["current_revision"]["id"]
    assert (
        client.put(f"/revisions/{current_id}", json={"description": "Moved PT"}).status_code == 200
    )

    snapshot = client.get(f"/revisions/{first['id']}/snapshot")
    assert snapshot.status_code == 200, snapshot.text
    body = snapshot.json()
    assert body["label"] == "-"
    assert body["approved_by"] == "engineer@fsdp.test"
    stored = body["snapshot"]
    assert stored["drawing"]["number"] == drawing["number"]
    assert stored["revision"]["label"] == "-"
    assert [sheet["sheet_no"] for sheet in stored["sheets"]] == [1]
    assert stored["sheets"][0]["document"]["items"][0]["id"] == "hv"
    assert [(row["item_id"], row["part_id"]) for row in stored["sheets"][0]["items"]] == [
        ("hv", part["id"])
    ]
    assert client.get(f"/revisions/{current_id}/snapshot").status_code == 404

    client.post(f"/drawings/{drawing_id}/release")
    second = client.post(
        f"/drawings/{drawing_id}/revise", json={"label": "C1", "description": "Rework"}
    )
    assert second.json()["current_revision"]["label"] == "C1"
    assert second.json()["current_revision"]["description"] == "Rework"
    assert (
        client.get(f"/revisions/{current_id}/snapshot").json()["snapshot"]["sheets"][0]["document"][
            "items"
        ][0]["id"]
        == "pt"
    )


def test_viewer_cannot_run_release_actions(client: TestClient) -> None:
    drawing = _drawing(client, _project(client))
    client.post(
        "/auth/users",
        json={
            "email": "viewer@rel.test",
            "name": "V",
            "password": "viewer-pass-1",
            "role": "viewer",
        },
    )
    viewer = TestClient(app)
    viewer.post("/auth/login", json={"email": "viewer@rel.test", "password": "viewer-pass-1"})
    for action in ("submit", "release", "withdraw", "revise"):
        assert viewer.post(f"/drawings/{drawing['id']}/{action}").status_code == 403


def test_index_stale_follows_saves(client: TestClient) -> None:
    project_id = _project(client)
    blank = _drawing(client, project_id)
    assert blank["sheets"][0]["index_stale"] is False
    assert blank["sheets"][0]["indexed_at"] is None
    drawing = _drawing(client, project_id, "hv")
    drawing_id = drawing["id"]
    sheet_id = drawing["sheets"][0]["id"]
    assert drawing["sheets"][0]["index_stale"] is True

    saved = _save(client, sheet_id)
    assert saved["index_stale"] is False
    assert saved["indexed_at"]
    assert client.get(f"/sheets/{sheet_id}").json()["index_stale"] is False

    title_only = client.put(f"/sheets/{sheet_id}", json={"title": "Fill"}).json()
    assert title_only["index_stale"] is False
    document_only = client.put(f"/sheets/{sheet_id}", json={"document": _document("hv")}).json()
    assert document_only["index_stale"] is True
    _save(client, sheet_id)
    index_only = client.put(f"/sheets/{sheet_id}", json={"index": _index()}).json()
    assert index_only["index_stale"] is True
    assert client.get(f"/sheets/{sheet_id}/drc").json()["index_stale"] is True
    assert client.get(f"/drawings/{drawing_id}/drc").json()["sheets"][0]["index_stale"] is True


def test_converted_sheets_start_stale(client: TestClient) -> None:
    project_id = _project(client)
    system = client.post(f"/projects/{project_id}/systems", json={"name": "Fill"}).json()
    diagram = client.post(f"/systems/{system['id']}/diagrams", json={"name": "Legacy"}).json()
    client.put(f"/diagrams/{diagram['id']}/schematic", json={"document": _document("hv")})
    drawing = client.post(
        f"/projects/{project_id}/drawings",
        json={"title": "Converted", "first_sheet": {"source_diagram_id": diagram["id"]}},
    ).json()
    assert drawing["sheets"][0]["source_diagram_id"] == diagram["id"]
    assert drawing["sheets"][0]["index_stale"] is True


def test_part_changes_mark_sheets_using_it_stale(client: TestClient) -> None:
    project_id = _project(client)
    part = _part(client)
    other = _part(client, "AMB2-002")
    using = _drawing(client, project_id, "hv")
    unrelated = _drawing(client, project_id, "hv")
    _save(client, using["sheets"][0]["id"], part_id=part["id"])
    _save(client, unrelated["sheets"][0]["id"], part_id=other["id"])

    # A no-op update leaves the index current.
    client.put(f"/parts/{part['id']}", json={"material": "316L"})
    assert _sheet_stale(client, using["id"]) == [False]

    client.put(f"/parts/{part['id']}", json={"pressure_rating_bar": 100})
    assert _sheet_stale(client, using["id"]) == [True]
    assert _sheet_stale(client, unrelated["id"]) == [False]

    _save(client, using["sheets"][0]["id"], part_id=part["id"])
    client.post(f"/parts/{part['id']}/obsolete")
    assert _sheet_stale(client, using["id"]) == [True]
    assert _sheet_stale(client, unrelated["id"]) == [False]


def test_requirement_constraint_changes_mark_project_sheets_stale(client: TestClient) -> None:
    project_id = _project(client)
    other_project = _project(client, "Other")
    drawing = _drawing(client, project_id, "hv")
    elsewhere = _drawing(client, other_project, "hv")
    sheet_id = drawing["sheets"][0]["id"]
    _save(client, sheet_id)
    _save(client, elsewhere["sheets"][0]["id"])

    def requirement(key: str, constraint: dict | None) -> dict:
        return client.post(
            "/requirements",
            json={
                "project_id": project_id,
                "key": key,
                "title": "Wetted",
                "text": "316L wetted parts",
                "requirement_type": "materials",
                "constraint": constraint,
            },
        ).json()

    manual = requirement("REQ-1", None)
    client.put(f"/requirements/{manual['id']}", json={"title": "Manual"})
    assert _sheet_stale(client, drawing["id"]) == [False]

    checked = requirement("REQ-2", CONSTRAINT)
    assert _sheet_stale(client, drawing["id"]) == [True]
    assert _sheet_stale(client, elsewhere["id"]) == [False]

    _save(client, sheet_id)
    client.put(f"/requirements/{checked['id']}", json={"constraint": None})
    assert _sheet_stale(client, drawing["id"]) == [True]

    _save(client, sheet_id)
    client.put(f"/requirements/{checked['id']}", json={"constraint": CONSTRAINT})
    _save(client, sheet_id)
    client.delete(f"/requirements/{checked['id']}")
    assert _sheet_stale(client, drawing["id"]) == [True]
    assert _sheet_stale(client, elsewhere["id"]) == [False]


def test_lists_and_verification_matrix_report_stale_sheets(client: TestClient) -> None:
    project_id = _project(client)
    drawing = _drawing(client, project_id, "hv")
    sheet_id = drawing["sheets"][0]["id"]
    client.put(f"/sheets/{sheet_id}", json={"index": _index()})

    listed = client.get(f"/drawings/{drawing['id']}/lists/valve").json()
    assert listed["stale_sheets"] == [
        {
            "sheet_id": sheet_id,
            "sheet_no": 1,
            "drawing_id": drawing["id"],
            "drawing_number": drawing["number"],
        }
    ]
    assert "open and save" in listed["header"]["warning"]
    project_list = client.get(f"/projects/{project_id}/lists/valve").json()
    assert [entry["sheet_id"] for entry in project_list["stale_sheets"]] == [sheet_id]

    rows = list(
        csv.reader(
            io.StringIO(client.get(f"/drawings/{drawing['id']}/lists/valve?format=csv").text)
        )
    )
    warning = next(row for row in rows if row and row[0] == "Warning")
    assert f"{drawing['number']} sheet 1" in warning[1]

    matrix = client.get(f"/projects/{project_id}/verification-matrix").json()
    assert [entry["sheet_id"] for entry in matrix["stale_sheets"]] == [sheet_id]

    _save(client, sheet_id)
    assert client.get(f"/drawings/{drawing['id']}/lists/valve").json()["stale_sheets"] == []
    assert "warning" not in client.get(f"/drawings/{drawing['id']}/lists/valve").json()["header"]
    assert client.get(f"/projects/{project_id}/verification-matrix").json()["stale_sheets"] == []
