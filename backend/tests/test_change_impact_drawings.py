"""Change impact covers drawings: sheet items, drawing BoMs, and traced requirements."""

from fastapi.testclient import TestClient


def _setup(client: TestClient) -> dict:
    project_id = client.post("/projects", json={"name": "AMB2"}).json()["id"]
    part = client.post(
        "/parts", json={"part_number": "AMB2-001", "description": "Valve", "part_type": "valve"}
    ).json()
    other = client.post(
        "/parts", json={"part_number": "AMB2-002", "description": "Relief", "part_type": "valve"}
    ).json()
    drawing = client.post(f"/projects/{project_id}/drawings", json={"title": "P&ID"}).json()
    unrelated = client.post(f"/projects/{project_id}/drawings", json={"title": "Vent"}).json()
    sheet_id = drawing["sheets"][0]["id"]
    second = client.post(f"/drawings/{drawing['id']}/sheets", json={}).json()

    def index(*items: tuple[str, str | None]) -> dict:
        return {
            "items": [
                {
                    "item_id": item_id,
                    "kind": "symbol",
                    "category": "valve",
                    "tag": item_id.upper(),
                    "zone": "B-2",
                    "part_id": part_id,
                }
                for item_id, part_id in items
            ],
            "lines": [],
        }

    client.put(
        f"/sheets/{sheet_id}", json={"index": index(("hv1", part["id"]), ("rv1", other["id"]))}
    )
    client.put(f"/sheets/{second['id']}", json={"index": index(("hv2", part["id"]))})
    client.put(
        f"/sheets/{unrelated['sheets'][0]['id']}", json={"index": index(("rv2", other["id"]))}
    )
    rows = {
        row["item_id"]: row
        for sid in (sheet_id, second["id"])
        for row in client.get(f"/sheets/{sid}/index").json()["items"]
    }
    return {
        "project_id": project_id,
        "part": part,
        "other": other,
        "drawing": drawing,
        "unrelated": unrelated,
        "sheet_id": sheet_id,
        "second_id": second["id"],
        "rows": rows,
    }


def _requirement(client: TestClient, project_id: str, key: str) -> dict:
    return client.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": key,
            "title": f"Title {key}",
            "text": "Text",
            "requirement_type": "design",
        },
    ).json()


def _link(client: TestClient, source: tuple[str, str], target: tuple[str, str]) -> None:
    created = client.post(
        "/trace-links",
        json={
            "source_type": source[0],
            "source_id": source[1],
            "target_type": target[0],
            "target_id": target[1],
            "link_type": "verified_by",
        },
    )
    assert created.status_code == 201, created.text


def test_part_impact_lists_drawings_tags_boms_and_requirements(client: TestClient) -> None:
    setup = _setup(client)
    part, drawing, rows = setup["part"], setup["drawing"], setup["rows"]
    on_tag = _requirement(client, setup["project_id"], "REQ-TAG")
    on_drawing = _requirement(client, setup["project_id"], "REQ-DWG")
    on_part = _requirement(client, setup["project_id"], "REQ-PART")
    unrelated = _requirement(client, setup["project_id"], "REQ-OTHER")
    _link(client, ("requirement", on_tag["id"]), ("sheet_item", rows["hv1"]["id"]))
    _link(client, ("requirement", on_drawing["id"]), ("drawing", drawing["id"]))
    _link(client, ("part", part["id"]), ("requirement", on_part["id"]))
    _link(client, ("requirement", unrelated["id"]), ("sheet_item", rows["rv1"]["id"]))
    _link(client, ("requirement", unrelated["id"]), ("drawing", setup["unrelated"]["id"]))
    with_part = client.post(f"/drawings/{drawing['id']}/bom").json()
    without_part = client.post(f"/drawings/{setup['unrelated']['id']}/bom").json()

    impact = client.get(f"/changes/impact?object_type=part&object_id={part['id']}")
    assert impact.status_code == 200, impact.text
    body = impact.json()
    # Legacy fields keep their shape.
    assert body["affected_components"] == []
    assert [link["target_id"] for link in body["direct_links"]] == [on_part["id"]]

    assert [
        (d["number"], d["sheets"], d["status"], d["revision"]) for d in body["affected_drawings"]
    ] == [(drawing["number"], [1, 2], "draft", "-")]
    assert [
        (i["tag"], i["sheet_no"], i["drawing_number"]) for i in body["affected_sheet_items"]
    ] == [
        ("HV1", 1, drawing["number"]),
        ("HV2", 2, drawing["number"]),
    ]
    assert body["affected_sheet_items"][0]["id"] == rows["hv1"]["id"]
    assert [snapshot["id"] for snapshot in body["affected_bom_snapshots"]] == [with_part["id"]]
    assert without_part["id"] not in {s["id"] for s in body["affected_bom_snapshots"]}
    assert [r["key"] for r in body["affected_requirements"]] == ["REQ-DWG", "REQ-PART", "REQ-TAG"]


def test_requirement_impact_lists_traced_and_checked_items(client: TestClient) -> None:
    setup = _setup(client)
    rows, drawing = setup["rows"], setup["drawing"]
    requirement = _requirement(client, setup["project_id"], "REQ-1")
    _link(client, ("requirement", requirement["id"]), ("sheet_item", rows["hv1"]["id"]))
    # The requirement's constraint was evaluated on rv2 of the unrelated drawing.
    unrelated_sheet = setup["unrelated"]["sheets"][0]["id"]
    client.put(
        f"/sheets/{unrelated_sheet}",
        json={
            "drc": {
                "findings": [],
                "checks": [
                    {"requirement_id": requirement["id"], "item_id": "rv2", "status": "fail"}
                ],
            }
        },
    )
    snapshot = client.post(f"/drawings/{drawing['id']}/bom").json()

    body = client.get(
        f"/changes/impact?object_type=requirement&object_id={requirement['id']}"
    ).json()
    assert [(i["tag"], i["drawing_number"]) for i in body["affected_sheet_items"]] == [
        ("HV1", drawing["number"]),
        ("RV2", setup["unrelated"]["number"]),
    ]
    assert sorted(d["number"] for d in body["affected_drawings"]) == sorted(
        [drawing["number"], setup["unrelated"]["number"]]
    )
    assert [p["part_number"] for p in body["affected_parts"]] == ["AMB2-001", "AMB2-002"]
    assert snapshot["id"] in {s["id"] for s in body["affected_bom_snapshots"]}
    assert body["affected_requirements"] == []


def test_impact_for_unknown_object_is_empty(client: TestClient) -> None:
    body = client.get("/changes/impact?object_type=part&object_id=missing").json()
    assert body["affected_drawings"] == []
    assert body["affected_sheet_items"] == []
    assert body["affected_bom_snapshots"] == []
