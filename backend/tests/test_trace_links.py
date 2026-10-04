"""Trace links to drawings and sheet index rows stay consistent (C4)."""

from fastapi.testclient import TestClient


def _project(client: TestClient, name: str = "AMB2") -> str:
    return client.post("/projects", json={"name": name}).json()["id"]


def _drawing(client: TestClient, project_id: str) -> dict:
    return client.post(f"/projects/{project_id}/drawings", json={"title": "P&ID"}).json()


def _requirement(client: TestClient, project_id: str, key: str = "REQ-1") -> dict:
    return client.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": key,
            "title": "Relief",
            "text": "Every vessel has a relief valve.",
            "requirement_type": "design",
        },
    ).json()


def _part(client: TestClient) -> dict:
    return client.post(
        "/parts", json={"part_number": "TL-001", "description": "Valve", "part_type": "valve"}
    ).json()


def _index(*item_ids: str, line_ids: tuple[str, ...] = ()) -> dict:
    return {
        "items": [{"item_id": item_id, "kind": "symbol", "tag": item_id} for item_id in item_ids],
        "lines": [{"line_id": line_id} for line_id in line_ids],
    }


def _save(client: TestClient, sheet_id: str, index: dict) -> dict:
    saved = client.put(f"/sheets/{sheet_id}", json={"index": index})
    assert saved.status_code == 200, saved.text
    stored = client.get(f"/sheets/{sheet_id}/index").json()
    return {
        **{row["item_id"]: row["id"] for row in stored["items"]},
        **{row["line_id"]: row["id"] for row in stored["lines"]},
    }


def _link(client: TestClient, source: tuple[str, str], target: tuple[str, str]):
    return client.post(
        "/trace-links",
        json={
            "source_type": source[0],
            "source_id": source[1],
            "target_type": target[0],
            "target_id": target[1],
            "link_type": "verified_by",
        },
    )


def _trace(client: TestClient, object_type: str, object_id: str) -> list[dict]:
    return client.get(f"/objects/{object_type}/{object_id}/trace").json()


def test_sheet_save_keeps_index_row_ids_and_drops_links_of_removed_rows(
    client: TestClient,
) -> None:
    project_id = _project(client)
    sheet_id = _drawing(client, project_id)["sheets"][0]["id"]
    requirement = _requirement(client, project_id)
    ids = _save(client, sheet_id, _index("hv", "pt", line_ids=("l1", "l2")))
    for target in (("sheet_item", ids["hv"]), ("sheet_item", ids["pt"])):
        assert _link(client, ("requirement", requirement["id"]), target).status_code == 201
    for target in (("sheet_line", ids["l1"]), ("sheet_line", ids["l2"])):
        assert _link(client, ("requirement", requirement["id"]), target).status_code == 201

    # Re-saving updates rows in place: same ids, links still resolve.
    edited = _index("hv", "pt", line_ids=("l1", "l2"))
    edited["items"][0]["tag"] = "HV-2"
    assert _save(client, sheet_id, edited) == ids
    assert len(_trace(client, "requirement", requirement["id"])) == 4
    items = client.get(f"/sheets/{sheet_id}/index").json()["items"]
    assert {row["item_id"]: row["tag"] for row in items}["hv"] == "HV-2"

    # Rows that leave the sheet take their trace links with them.
    remaining = _save(client, sheet_id, _index("hv", line_ids=("l1",)))
    assert remaining == {"hv": ids["hv"], "l1": ids["l1"]}
    targets = {link["target_id"] for link in _trace(client, "requirement", requirement["id"])}
    assert targets == {ids["hv"], ids["l1"]}


def test_deleting_sheet_drawing_or_project_removes_their_trace_links(client: TestClient) -> None:
    project_id = _project(client)
    drawing = _drawing(client, project_id)
    first_sheet = drawing["sheets"][0]["id"]
    second_sheet = client.post(f"/drawings/{drawing['id']}/sheets", json={}).json()["id"]
    part = _part(client)
    on_first = _save(client, first_sheet, _index("hv", line_ids=("l1",)))
    on_second = _save(client, second_sheet, _index("pt"))
    for target in (
        ("sheet_item", on_first["hv"]),
        ("sheet_line", on_first["l1"]),
        ("sheet_item", on_second["pt"]),
        ("drawing", drawing["id"]),
    ):
        assert _link(client, ("part", part["id"]), target).status_code == 201

    assert client.delete(f"/sheets/{first_sheet}").status_code == 204
    targets = {link["target_id"] for link in _trace(client, "part", part["id"])}
    assert targets == {on_second["pt"], drawing["id"]}

    assert client.delete(f"/drawings/{drawing['id']}").status_code == 204
    assert _trace(client, "part", part["id"]) == []

    other = _drawing(client, project_id)
    item_ids = _save(client, other["sheets"][0]["id"], _index("hv"))
    assert _link(client, ("part", part["id"]), ("drawing", other["id"])).status_code == 201
    assert _link(client, ("sheet_item", item_ids["hv"]), ("part", part["id"])).status_code == 201
    assert client.delete(f"/projects/{project_id}").status_code == 204
    assert _trace(client, "part", part["id"]) == []


def test_trace_link_endpoints_must_share_a_project(client: TestClient) -> None:
    project_a = _project(client, "Project A")
    project_b = _project(client, "Project B")
    requirement = _requirement(client, project_a)
    drawing_b = _drawing(client, project_b)
    item_b = _save(client, drawing_b["sheets"][0]["id"], _index("hv"))["hv"]

    for target in (
        ("drawing", drawing_b["id"]),
        ("sheet_item", item_b),
        ("project", project_b),
        ("requirement", _requirement(client, project_b, "REQ-B")["id"]),
    ):
        response = _link(client, ("requirement", requirement["id"]), target)
        assert response.status_code == 400, target
        assert "different projects" in response.json()["detail"]

    # Same-project links and links to catalog parts (shared across projects) are fine.
    drawing_a = _drawing(client, project_a)
    assert (
        _link(client, ("requirement", requirement["id"]), ("drawing", drawing_a["id"])).status_code
        == 201
    )
    part = _part(client)
    assert _link(client, ("part", part["id"]), ("sheet_item", item_b)).status_code == 201
    assert (
        _link(client, ("requirement", requirement["id"]), ("part", part["id"])).status_code == 201
    )


def test_project_sheet_items_list_tagged_trace_targets(client: TestClient) -> None:
    project_id = _project(client)
    drawing = client.post(
        f"/projects/{project_id}/drawings", json={"title": "HELIUM\nPANEL", "number": "AMB2-0002"}
    ).json()
    second = client.post(f"/drawings/{drawing['id']}/sheets", json={}).json()
    index = {
        "items": [
            {"item_id": "pt", "kind": "symbol", "category": "instrument", "tag": "PT-101"},
            {"item_id": "hv", "kind": "symbol", "category": "valve", "tag": "HV-1", "zone": "B-2"},
            {"item_id": "tee", "kind": "symbol", "category": "fitting"},
        ],
        "lines": [],
    }
    ids = _save(client, drawing["sheets"][0]["id"], index)
    ids |= _save(client, second["id"], _index("V-9"))
    other = _drawing(client, _project(client, "Other"))
    _save(client, other["sheets"][0]["id"], _index("XV-1"))

    rows = client.get(f"/projects/{project_id}/sheet-items").json()

    # Untagged items and other projects' drawings are left out; ordered by sheet, then tag.
    assert [(row["sheet_no"], row["tag"]) for row in rows] == [
        (1, "HV-1"),
        (1, "PT-101"),
        (2, "V-9"),
    ]
    assert rows[0] == {
        "id": ids["hv"],
        "sheet_id": drawing["sheets"][0]["id"],
        "item_id": "hv",
        "kind": "symbol",
        "category": "valve",
        "tag": "HV-1",
        "label": None,
        "symbol_name": None,
        "zone": "B-2",
        "part_id": None,
        "drawing_id": drawing["id"],
        "drawing_number": "AMB2-0002",
        "drawing_title": "HELIUM PANEL",
        "sheet_no": 1,
    }
    # The row id is the trace-link target id.
    requirement = _requirement(client, project_id)
    linked = _link(client, ("requirement", requirement["id"]), ("sheet_item", rows[1]["id"]))
    assert linked.status_code == 201
    assert client.get("/projects/missing/sheet-items").status_code == 404
