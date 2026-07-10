from fastapi.testclient import TestClient


def _seed_requirement_context(client: TestClient) -> dict:
    project = client.post("/projects", json={"name": "Req Project"}).json()
    system = client.post(
        f"/projects/{project['id']}/systems",
        json={"name": "Pressurization", "fluid": "GHe"},
    ).json()
    diagram = client.post(f"/systems/{system['id']}/diagrams", json={"name": "P&ID"}).json()
    part = client.post(
        "/parts",
        json={
            "part_number": "V-REQ-1",
            "description": "Valve",
            "part_type": "valve",
        },
    ).json()
    component = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-1", "part_id": part["id"], "quantity": 1},
    ).json()
    requirement = client.post(
        "/requirements",
        json={
            "project_id": project["id"],
            "key": "REQ-1",
            "title": "Pressure boundary",
            "text": "Maintain pressure boundary.",
            "requirement_type": "safety",
            "verification_method": "analysis",
            "status": "draft",
        },
    ).json()
    link = client.post(
        "/trace-links",
        json={
            "source_type": "requirement",
            "source_id": requirement["id"],
            "target_type": "component",
            "target_id": component["id"],
            "link_type": "satisfied_by",
        },
    ).json()
    return {
        "project": project,
        "component": component,
        "requirement": requirement,
        "link": link,
    }


def test_requirement_traceability_and_coverage(client: TestClient) -> None:
    context = _seed_requirement_context(client)
    requirement = context["requirement"]
    project = context["project"]
    component = context["component"]
    link = context["link"]

    coverage = client.get(f"/projects/{project['id']}/requirements/coverage").json()
    assert coverage[requirement["id"]]["linked"] is True
    assert coverage[requirement["id"]]["link_count"] == 1
    assert coverage[requirement["id"]]["evidence_count"] == 0
    assert coverage[requirement["id"]]["verification_display"] == "in_progress"

    traceability = client.get(f"/requirements/{requirement['id']}/traceability").json()
    assert len(traceability["links"]) == 1
    assert traceability["components"][0]["tag"] == "V-1"

    traceable = client.get(f"/projects/{project['id']}/traceable-components").json()
    assert any(row["component_id"] == component["id"] for row in traceable)

    impact = client.get(
        f"/changes/impact?object_type=requirement&object_id={requirement['id']}"
    ).json()
    assert len(impact["direct_links"]) == 1
    assert len(impact["affected_components"]) == 1

    client.delete(f"/trace-links/{link['id']}")
    coverage_after = client.get(f"/projects/{project['id']}/requirements/coverage").json()
    assert coverage_after[requirement["id"]]["linked"] is False


def test_requirement_revision_compare_bulk_import_sets_and_evidence(client: TestClient) -> None:
    context = _seed_requirement_context(client)
    project = context["project"]
    requirement = context["requirement"]

    requirement_set = client.post(
        f"/projects/{project['id']}/requirement-sets",
        json={
            "name": "Pressurization boilerplate",
            "requirement_type": "safety",
            "default_verification_method": "analysis",
            "template_text": "All pressurized components shall...",
        },
    ).json()
    assert requirement_set["name"] == "Pressurization boilerplate"

    second = client.post(
        "/requirements",
        json={
            "project_id": project["id"],
            "key": "REQ-2",
            "title": "Secondary req",
            "text": "Secondary text.",
            "requirement_type": "functional",
            "set_id": requirement_set["id"],
        },
    ).json()
    assert second["set_id"] == requirement_set["id"]
    assert second["verification_method"] == "analysis"

    updated = client.put(
        f"/requirements/{requirement['id']}",
        json={"title": "Updated pressure boundary", "status": "ready_for_verification"},
    ).json()
    assert updated["title"] == "Updated pressure boundary"

    revisions = client.get(f"/requirements/{requirement['id']}/revisions").json()
    assert len(revisions) == 1
    assert revisions[0]["snapshot"]["title"] == "Pressure boundary"

    compare = client.get(
        f"/requirements/compare?left_id={requirement['id']}&right_id={second['id']}"
    ).json()
    assert any(diff["field"] == "key" for diff in compare["differences"])

    bulk = client.post(
        "/requirements/bulk-update",
        json={
            "requirement_ids": [requirement["id"], second["id"]],
            "owner": "systems-team",
            "verification_status": "in_progress",
        },
    ).json()
    assert len(bulk) == 2
    assert all(item["owner"] == "systems-team" for item in bulk)

    csv_text = (
        "key,title,text,requirement_type,status\n"
        "REQ-3,Imported req,Imported text,functional,draft\n"
        "REQ-1,Updated import title,Updated text,safety,reviewed\n"
    )
    import_result = client.post(
        "/requirements/import",
        json={
            "project_id": project["id"],
            "csv_text": csv_text,
            "column_mapping": {
                "key": "key",
                "title": "title",
                "text": "text",
                "requirement_type": "requirement_type",
                "status": "status",
            },
            "on_duplicate": "update",
        },
    ).json()
    assert import_result["created"] == 1
    assert import_result["updated"] == 1

    attachment = client.post(
        f"/requirements/{requirement['id']}/attachments",
        json={
            "filename": "analysis-memo.pdf",
            "attachment_type": "analysis_memo",
            "mime_type": "application/pdf",
            "size_bytes": 1024,
        },
    ).json()
    assert attachment["filename"] == "analysis-memo.pdf"

    coverage = client.get(f"/projects/{project['id']}/requirements/coverage").json()
    assert coverage[requirement["id"]]["evidence_count"] == 1

    matrix = client.get(
        f"/projects/{project['id']}/requirements/verification-matrix"
    ).json()
    assert len(matrix) >= 3
    assert any(row["key"] == "REQ-1" and row["evidence_count"] == 1 for row in matrix)

    client.delete(f"/requirement-attachments/{attachment['id']}")
    attachments = client.get(f"/requirements/{requirement['id']}/attachments").json()
    assert attachments == []
