"""Template lineage: copies remember their source and can be compared with it."""

from fastapi.testclient import TestClient

from app.main import app


def _document(tags: dict[str, str]) -> dict:
    return {
        "schemaVersion": 1,
        "sheet": {"size": "A3", "orientation": "landscape"},
        "layers": [],
        "items": [{"id": item_id, "kind": "symbol", "tag": tag} for item_id, tag in tags.items()],
        "meta": {"grid": 2.5},
    }


def _save(client: TestClient, sheet_id: str, tags: dict[str, str], lines: list[dict], **parts):
    index = {
        "items": [
            {
                "item_id": item_id,
                "kind": "symbol",
                "symbol_name": "Ball valve",
                "tag": tag,
                "part_id": parts.get(item_id),
            }
            for item_id, tag in tags.items()
        ],
        "lines": lines,
    }
    saved = client.put(
        f"/sheets/{sheet_id}",
        json={"document": _document(tags), "index": index, "drc": {"findings": []}},
    )
    assert saved.status_code == 200, saved.text


def _template(client: TestClient) -> tuple[dict, dict]:
    project = client.post("/projects", json={"name": "Ship 30"}).json()
    drawing = client.post(f"/projects/{project['id']}/drawings", json={"title": "LOX feed"}).json()
    _save(
        client,
        drawing["sheets"][0]["id"],
        {"a": "HV-1", "b": "HV-2", "c": "PT-1"},
        [{"line_id": "l1", "line_number": "LOX-01", "size": '2"', "service": "LOX"}],
    )
    return project, client.get(f"/drawings/{drawing['id']}").json()


def test_copy_records_its_source_and_the_source_lists_its_copies(client: TestClient) -> None:
    project, source = _template(client)
    other = client.post("/projects", json={"name": "Ship 31"}).json()
    copied = client.post(f"/drawings/{source['id']}/copy", json={"project_id": other["id"]}).json()
    assert copied["copied_from_id"] == source["id"]
    assert copied["copied_from_number"] == source["number"]
    assert copied["copied_from_revision"] == "-"

    lineage = client.get(f"/drawings/{copied['id']}/lineage").json()
    assert lineage["source"]["id"] == source["id"]
    assert lineage["source"]["project_name"] == "Ship 30"
    assert lineage["source_revision_changed"] is False
    assert lineage["copies"] == []

    of_source = client.get(f"/drawings/{source['id']}/lineage").json()
    assert of_source["source"] is None
    assert [(c["id"], c["project_name"]) for c in of_source["copies"]] == [
        (copied["id"], "Ship 31")
    ]
    assert source["copied_from_id"] is None


def test_diff_matches_rows_by_id_so_a_renamed_tag_is_a_change(client: TestClient) -> None:
    _project, source = _template(client)
    part = client.post(
        "/parts", json={"part_number": "VLV-9", "description": "Valve", "part_type": "valve"}
    ).json()
    copied = client.post(f"/drawings/{source['id']}/copy").json()
    # In the copy: HV-1 renamed and given a part, PT-1 removed, a new valve and line added,
    # and the LOX line resized.
    _save(
        client,
        copied["sheets"][0]["id"],
        {"a": "HV-101", "b": "HV-2", "d": "HV-3"},
        [
            {"line_id": "l1", "line_number": "LOX-01", "size": '3"', "service": "LOX"},
            {"line_id": "l2", "line_number": "LOX-02"},
        ],
        a=part["id"],
    )

    diff = client.get(f"/drawings/{copied['id']}/lineage/diff").json()
    assert diff["source_number"] == source["number"]
    assert diff["counts"] == {"added": 2, "removed": 1, "changed": 2}
    rows = {(row["kind"], row["item_id"]): row for row in diff["rows"]}
    assert ("item", "b") not in rows
    assert rows[("item", "a")]["change"] == "changed"
    assert rows[("item", "a")]["label"] == "HV-101"
    assert rows[("item", "a")]["changes"] == [
        {"field": "tag", "source": "HV-1", "copy": "HV-101"},
        {"field": "part", "source": None, "copy": "VLV-9"},
    ]
    assert (rows[("item", "c")]["change"], rows[("item", "c")]["label"]) == ("removed", "PT-1")
    assert (rows[("item", "d")]["change"], rows[("item", "d")]["label"]) == ("added", "HV-3")
    assert rows[("line", "l1")]["changes"] == [{"field": "size", "source": '2"', "copy": '3"'}]
    assert rows[("line", "l2")]["change"] == "added"
    assert diff["stale"] == []


def test_diff_reports_stale_and_unmatched_sheets(client: TestClient) -> None:
    _project, source = _template(client)
    copied = client.post(f"/drawings/{source['id']}/copy").json()
    client.post(f"/drawings/{copied['id']}/sheets", json={"title": "Vent"})
    diff = client.get(f"/drawings/{copied['id']}/lineage/diff").json()
    # The fresh copy has not been indexed yet, so its rows read as removed; say so.
    assert diff["stale"] == [f"{copied['number']} sheet 1"]
    assert diff["sheets_added"] == [2]
    assert diff["sheets_removed"] == []


def test_lineage_survives_source_changes_and_respects_access(client: TestClient) -> None:
    project, source = _template(client)
    copied = client.post(f"/drawings/{source['id']}/copy").json()
    assert client.get(f"/drawings/{source['id']}/lineage/diff").status_code == 404

    # A member of the copy's project who cannot see the source's project learns only
    # the number the copy was taken from.
    other = client.post("/projects", json={"name": "Elsewhere"}).json()
    far = client.post(f"/drawings/{source['id']}/copy", json={"project_id": other["id"]}).json()
    client.put(f"/projects/{project['id']}/access", json={"restricted": True})
    client.post(
        "/auth/users",
        json={"email": "eng@fsdp.test", "name": "Eng", "password": "eng-password"},
    )
    engineer = TestClient(app)
    engineer.post("/auth/login", json={"email": "eng@fsdp.test", "password": "eng-password"})
    seen = engineer.get(f"/drawings/{far['id']}/lineage").json()
    assert seen["source"] is None
    assert seen["copied_from_number"] == source["number"]
    assert engineer.get(f"/drawings/{far['id']}/lineage/diff").status_code == 404

    # Deleting the source keeps the copy and the recorded origin.
    assert client.delete(f"/drawings/{source['id']}").status_code == 204
    after = client.get(f"/drawings/{copied['id']}").json()
    assert after["copied_from_id"] is None
    assert after["copied_from_number"] == source["number"]
    assert client.get(f"/drawings/{copied['id']}/lineage").json()["source"] is None
