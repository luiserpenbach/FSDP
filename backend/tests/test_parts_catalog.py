from fastapi.testclient import TestClient


def test_part_revision_history_and_where_used(client: TestClient) -> None:
    part = client.post(
        "/parts",
        json={
            "part_number": "VALVE-100",
            "description": "Test valve",
            "part_type": "valve",
            "revision": "A",
        },
    ).json()
    updated = client.put(f"/parts/{part['id']}", json={"revision": "B", "material": "316L"}).json()
    assert updated["revision"] == "B"

    revisions = client.get(f"/parts/{part['id']}/revisions").json()
    assert len(revisions) == 1
    assert revisions[0]["snapshot"]["revision"] == "A"

    where_used = client.get(f"/parts/{part['id']}/where-used").json()
    assert where_used["part_id"] == part["id"]
    assert where_used["components"] == []


def test_part_families_import_bulk_compare(client: TestClient) -> None:
    family = client.post(
        "/parts/families",
        json={
            "name": "Tube Fittings",
            "part_type": "fitting",
            "template_properties": {"material": "Ti-6Al-4V", "source_type": "internal"},
        },
    ).json()

    part_a = client.post(
        "/parts",
        json={
            "part_number": "FIT-001",
            "description": "Fitting A",
            "part_type": "fitting",
            "family_id": family["id"],
        },
    ).json()
    assert part_a["material"] == "Ti-6Al-4V"

    part_b = client.post(
        "/parts",
        json={"part_number": "FIT-002", "description": "Fitting B", "part_type": "fitting"},
    ).json()

    compare = client.get(f"/parts/compare?left_id={part_a['id']}&right_id={part_b['id']}").json()
    assert compare["left"]["part_number"] == "FIT-001"
    assert any(diff["field"] == "material" for diff in compare["differences"])

    bulk = client.post(
        "/parts/bulk-update",
        json={
            "part_ids": [part_a["id"], part_b["id"]],
            "qualification_status": "preferred",
        },
    ).json()
    assert len(bulk) == 2
    assert bulk[0]["qualification_status"] == "preferred"

    csv_text = (
        "part_number,description,part_type,material\n"
        "FIT-003,Imported fitting,fitting,316L\n"
        "FIT-001,Updated fitting,fitting,316L"
    )
    imported = client.post(
        "/parts/import",
        json={
            "csv_text": csv_text,
            "column_mapping": {
                "part_number": "part_number",
                "description": "description",
                "part_type": "part_type",
                "material": "material",
            },
            "on_duplicate": "update",
        },
    ).json()
    assert imported["created"] == 1
    assert imported["updated"] == 1


def test_part_attachments_and_supersession(client: TestClient) -> None:
    old_part = client.post(
        "/parts",
        json={"part_number": "OBS-001", "description": "Obsolete", "part_type": "valve"},
    ).json()
    new_part = client.post(
        "/parts",
        json={"part_number": "OBS-002", "description": "Replacement", "part_type": "valve"},
    ).json()
    client.put(
        f"/parts/{old_part['id']}",
        json={
            "lifecycle_status": "obsolete",
            "replacement_part_id": new_part["id"],
        },
    )

    attachment = client.post(
        f"/parts/{new_part['id']}/attachments",
        json={
            "filename": "datasheet.pdf",
            "attachment_type": "datasheet",
            "mime_type": "application/pdf",
            "size_bytes": 12,
            "content_base64": "dGVzdA==",
        },
    ).json()
    assert attachment["filename"] == "datasheet.pdf"

    listed = client.get(f"/parts/{new_part['id']}/attachments").json()
    assert len(listed) == 1

    client.delete(f"/part-attachments/{attachment['id']}")
    assert client.get(f"/parts/{new_part['id']}/attachments").json() == []
