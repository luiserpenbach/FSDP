"""Regression: sheet index upsert must preserve TraceLink targets across saves."""

from fastapi.testclient import TestClient


def test_sheet_item_and_line_traces_survive_identical_index_replace(client: TestClient) -> None:
    project = client.post("/projects", json={"name": "OrphanProbe", "part_name_prefix": "OP"}).json()
    drawing = client.post(
        f"/projects/{project['id']}/drawings", json={"title": "P&ID", "size": "A3"}
    ).json()
    sheet_id = drawing["sheets"][0]["id"]
    req = client.post(
        "/requirements",
        json={
            "project_id": project["id"],
            "key": "REQ-1",
            "title": "Material",
            "text": "316L",
            "requirement_type": "design",
        },
    ).json()
    index = {
        "items": [
            {
                "item_id": "hv",
                "kind": "symbol",
                "category": "valve",
                "symbol_key": "ball_valve",
                "symbol_name": "Ball valve",
                "tag": "HV-1",
            }
        ],
        "lines": [
            {
                "line_id": "L1",
                "line_number": "3101",
                "line_type": "process",
                "size": '1/4"',
                "from_item": "hv",
                "from_tag": "HV-1",
            }
        ],
    }
    assert client.put(f"/sheets/{sheet_id}", json={"index": index}).status_code == 200
    stored = client.get(f"/sheets/{sheet_id}/index").json()
    item_pk = stored["items"][0]["id"]
    line_pk = stored["lines"][0]["id"]

    for target_type, target_id in (("sheet_item", item_pk), ("sheet_line", line_pk)):
        created = client.post(
            "/trace-links",
            json={
                "source_type": "requirement",
                "source_id": req["id"],
                "target_type": target_type,
                "target_id": target_id,
                "link_type": "verified_by",
            },
        )
        assert created.status_code == 201, created.text

    # Same content again — Drafting save always re-sends the index.
    updated_index = {
        "items": [
            {
                **index["items"][0],
                "tag": "HV-1A",
                "zone": "D-4",
            }
        ],
        "lines": [
            {
                **index["lines"][0],
                "size": '3/8"',
            }
        ],
    }
    assert client.put(f"/sheets/{sheet_id}", json={"index": updated_index}).status_code == 200
    stored2 = client.get(f"/sheets/{sheet_id}/index").json()
    assert stored2["items"][0]["id"] == item_pk
    assert stored2["lines"][0]["id"] == line_pk
    assert stored2["items"][0]["tag"] == "HV-1A"
    assert stored2["lines"][0]["size"] == '3/8"'

    traces = client.get(f"/objects/requirement/{req['id']}/trace").json()
    targets = {(link["target_type"], link["target_id"]) for link in traces}
    assert targets == {("sheet_item", item_pk), ("sheet_line", line_pk)}

    matrix = client.get(f"/projects/{project['id']}/verification-matrix").json()
    assert matrix["rows"][0]["linked_drawings"] == 2


def test_removed_index_rows_drop_their_trace_links(client: TestClient) -> None:
    project = client.post("/projects", json={"name": "OrphanCleanup", "part_name_prefix": "OC"}).json()
    drawing = client.post(
        f"/projects/{project['id']}/drawings", json={"title": "P&ID", "size": "A3"}
    ).json()
    sheet_id = drawing["sheets"][0]["id"]
    req = client.post(
        "/requirements",
        json={
            "project_id": project["id"],
            "key": "REQ-2",
            "title": "Gone",
            "text": "x",
            "requirement_type": "design",
        },
    ).json()
    assert (
        client.put(
            f"/sheets/{sheet_id}",
            json={
                "index": {
                    "items": [
                        {
                            "item_id": "hv",
                            "kind": "symbol",
                            "category": "valve",
                            "symbol_key": "ball_valve",
                            "symbol_name": "Ball valve",
                            "tag": "HV-1",
                        }
                    ],
                    "lines": [],
                }
            },
        ).status_code
        == 200
    )
    item_pk = client.get(f"/sheets/{sheet_id}/index").json()["items"][0]["id"]
    assert (
        client.post(
            "/trace-links",
            json={
                "source_type": "requirement",
                "source_id": req["id"],
                "target_type": "sheet_item",
                "target_id": item_pk,
                "link_type": "verified_by",
            },
        ).status_code
        == 201
    )

    # Item deleted from the sheet — its TraceLink must go with it.
    assert client.put(f"/sheets/{sheet_id}", json={"index": {"items": [], "lines": []}}).status_code == 200
    assert client.get(f"/sheets/{sheet_id}/index").json()["items"] == []
    assert client.get(f"/objects/requirement/{req['id']}/trace").json() == []
    matrix = client.get(f"/projects/{project['id']}/verification-matrix").json()
    assert matrix["rows"][0]["linked_drawings"] == 0
