"""Phase 5: DRC results and waivers, requirement constraints, verification matrix, PDF pages."""

import io

from fastapi.testclient import TestClient
from pypdf import PdfReader

SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 420 297">'
    '<rect x="10" y="10" width="400" height="277" fill="none" stroke="#000"/></svg>'
)


def _project(client: TestClient) -> str:
    return client.post("/projects", json={"name": "AMB2", "part_name_prefix": "AMB2"}).json()["id"]


def _drawing(client: TestClient, project_id: str) -> dict:
    return client.post(
        f"/projects/{project_id}/drawings", json={"title": "P&ID", "size": "ANSI_E"}
    ).json()


def _requirement(client: TestClient, project_id: str, key: str, constraint: dict | None) -> dict:
    response = client.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": key,
            "title": "316L wetted" if constraint else "Manual check",
            "text": "All wetted parts shall be 316L.",
            "requirement_type": "materials",
            "constraint": constraint,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _drc(requirement_id: str) -> dict:
    return {
        "findings": [
            {
                "key": "open_port:pt:process",
                "rule": "open_port",
                "severity": "warning",
                "message": "PT-3204 port process has no line",
                "itemId": "pt",
                "subject": "PT-3204",
                "zone": "C-3",
            },
            {
                "key": "duplicate_tag:hv2",
                "rule": "duplicate_tag",
                "severity": "error",
                "message": "HV-3201: Duplicate of HV-3201",
                "item_id": "hv2",
                "subject": "HV-3201",
                "zone": "D-3",
            },
            {
                "key": f"requirement:{requirement_id}:hv",
                "rule": "requirement",
                "severity": "error",
                "message": "REQ-7 (316L wetted): AMB2-003 material Brass is not one of 316L",
                "itemId": "hv",
                "subject": "HV-3201",
                "zone": "D-4",
                "requirementId": requirement_id,
            },
            {
                "key": "requirement:missing:hv",
                "rule": "requirement",
                "severity": "error",
                "message": "orphan",
                "requirementId": "missing",
            },
        ],
        "checks": [
            {
                "requirementId": requirement_id,
                "itemId": "hv",
                "subject": "HV-3201",
                "zone": "D-4",
                "status": "fail",
                "message": "Brass",
            },
            {
                "requirementId": requirement_id,
                "itemId": "pcv",
                "subject": "PCV-3202",
                "zone": "D-3",
                "status": "pass",
                "message": "316L",
            },
            {"requirementId": "missing", "itemId": "x", "status": "pass"},
        ],
    }


def test_drc_results_are_replaced_on_save_and_waivers_survive(client: TestClient) -> None:
    project_id = _project(client)
    drawing = _drawing(client, project_id)
    sheet_id = drawing["sheets"][0]["id"]
    requirement = _requirement(
        client, project_id, "REQ-7", {"kind": "material_in", "values": ["316L"]}
    )

    saved = client.put(f"/sheets/{sheet_id}", json={"drc": _drc(requirement["id"])})
    assert saved.status_code == 200, saved.text
    drc = client.get(f"/sheets/{sheet_id}/drc").json()
    assert drc["sheet_no"] == 1
    assert drc["counts"] == {"error": 3, "warning": 1, "info": 0, "waived": 0}
    by_key = {finding["key"]: finding for finding in drc["findings"]}
    assert by_key["open_port:pt:process"]["item_id"] == "pt"
    assert by_key[f"requirement:{requirement['id']}:hv"]["requirement_id"] == requirement["id"]
    # Unknown requirement ids are kept as findings but unlinked; their checks are dropped.
    assert by_key["requirement:missing:hv"]["requirement_id"] is None
    assert [(check["item_id"], check["status"]) for check in drc["checks"]] == [
        ("hv", "fail"),
        ("pcv", "pass"),
    ]

    waived = client.put(
        f"/sheets/{sheet_id}/drc/waivers",
        json={"key": "open_port:pt:process", "reason": "Vented to atmosphere by design"},
    )
    assert waived.status_code == 201, waived.text
    assert waived.json()["waived_by"] == "engineer@fsdp.test"
    drc = client.get(f"/sheets/{sheet_id}/drc").json()
    assert drc["counts"] == {"error": 3, "warning": 0, "info": 0, "waived": 1}
    assert drc["waivers"][0]["reason"] == "Vented to atmosphere by design"

    # Updating the reason keeps one waiver; a new save keeps it too.
    client.put(
        f"/sheets/{sheet_id}/drc/waivers", json={"key": "open_port:pt:process", "reason": "Updated"}
    )
    client.put(
        f"/sheets/{sheet_id}",
        json={"drc": {"findings": _drc(requirement["id"])["findings"][:1], "checks": []}},
    )
    drc = client.get(f"/sheets/{sheet_id}/drc").json()
    assert len(drc["waivers"]) == 1
    assert drc["waivers"][0]["reason"] == "Updated"
    assert drc["counts"] == {"error": 0, "warning": 0, "info": 0, "waived": 1}
    assert drc["checks"] == []

    summary = client.get(f"/drawings/{drawing['id']}/drc").json()
    assert summary["counts"] == {"error": 0, "warning": 0, "info": 0, "waived": 1}
    assert [entry["sheet_no"] for entry in summary["sheets"]] == [1]

    assert client.delete(f"/sheets/{sheet_id}/drc/waivers/open_port:pt:process").status_code == 204
    assert client.delete(f"/sheets/{sheet_id}/drc/waivers/open_port:pt:process").status_code == 404
    assert client.get(f"/sheets/{sheet_id}/drc").json()["counts"]["warning"] == 1
    assert (
        client.put(f"/sheets/{sheet_id}/drc/waivers", json={"key": "x", "reason": "  "}).status_code
        == 422
    )


def test_requirement_constraints_are_validated_and_normalized(client: TestClient) -> None:
    project_id = _project(client)
    created = _requirement(
        client,
        project_id,
        "REQ-7",
        {
            "kind": "material_in",
            "values": [" 316L ", "", "316"],
            "scope": {"services": ["GHe"], "categories": []},
        },
    )
    assert created["constraint"] == {
        "kind": "material_in",
        "values": ["316L", "316"],
        "scope": {"services": ["GHe"]},
    }
    listed = client.get(f"/projects/{project_id}/requirements").json()
    assert listed[0]["constraint"]["kind"] == "material_in"

    bad_kind = client.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": "REQ-8",
            "title": "t",
            "text": "x",
            "requirement_type": "r",
            "constraint": {"kind": "bogus", "values": ["1"]},
        },
    )
    assert bad_kind.status_code == 422
    assert "constraint.kind" in bad_kind.text
    empty = client.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": "REQ-8",
            "title": "t",
            "text": "x",
            "requirement_type": "r",
            "constraint": {"kind": "material_in", "values": []},
        },
    )
    assert empty.status_code == 422

    relief = client.put(
        f"/requirements/{created['id']}",
        json={"constraint": {"kind": "relief_required", "values": []}},
    )
    assert relief.status_code == 200, relief.text
    assert relief.json()["constraint"] == {"kind": "relief_required", "values": [], "scope": {}}
    cleared = client.put(f"/requirements/{created['id']}", json={"constraint": None})
    assert cleared.json()["constraint"] is None


def test_verification_matrix_and_drawing_trace_links(client: TestClient) -> None:
    project_id = _project(client)
    drawing = _drawing(client, project_id)
    second = client.post(f"/drawings/{drawing['id']}/sheets", json={"title": "Vent"}).json()
    other_drawing = _drawing(client, project_id)
    checked = _requirement(client, project_id, "REQ-7", {"kind": "material_in", "values": ["316L"]})
    manual = _requirement(client, project_id, "REQ-9", None)
    _requirement(client, project_id, "REQ-8", {"kind": "relief_required", "values": []})

    client.put(f"/sheets/{drawing['sheets'][0]['id']}", json={"drc": _drc(checked["id"])})
    client.put(
        f"/sheets/{second['id']}",
        json={
            "drc": {
                "findings": [],
                "checks": [
                    {
                        "requirementId": checked["id"],
                        "itemId": "v",
                        "subject": "HV-3230",
                        "status": "pass",
                    }
                ],
            }
        },
    )
    client.put(
        f"/sheets/{other_drawing['sheets'][0]['id']}",
        json={
            "drc": {
                "findings": [],
                "checks": [
                    {
                        "requirementId": checked["id"],
                        "itemId": "w",
                        "subject": "HV-4201",
                        "status": "pass",
                    }
                ],
            }
        },
    )

    link = client.post(
        "/trace-links",
        json={
            "source_type": "requirement",
            "source_id": checked["id"],
            "target_type": "drawing",
            "target_id": drawing["id"],
            "link_type": "verified_by",
        },
    )
    assert link.status_code == 201, link.text
    bad = client.post(
        "/trace-links",
        json={
            "source_type": "requirement",
            "source_id": checked["id"],
            "target_type": "sheet_item",
            "target_id": "nope",
            "link_type": "verified_by",
        },
    )
    assert bad.status_code == 404
    unknown = client.post(
        "/trace-links",
        json={
            "source_type": "requirement",
            "source_id": checked["id"],
            "target_type": "bogus",
            "target_id": "x",
            "link_type": "verified_by",
        },
    )
    assert unknown.status_code == 422
    assert "drawing" in unknown.json()["detail"]

    matrix = client.get(f"/projects/{project_id}/verification-matrix").json()
    rows = {row["key"]: row for row in matrix["rows"]}
    assert set(rows) == {"REQ-7", "REQ-8", "REQ-9"}
    row = rows["REQ-7"]
    assert (row["checked"], row["passed"], row["failed"], row["verdict"]) == (4, 3, 1, "fail")
    assert [
        (entry["drawing_number"], entry["checked"], entry["failed"], entry["sheets"])
        for entry in row["drawings"]
    ] == [
        (drawing["number"], 3, 1, [1, 2]),
        (other_drawing["number"], 1, 0, [1]),
    ]
    assert row["linked_drawings"] == 1
    assert row["linked_components"] == 0
    assert [failure["subject"] for failure in row["failures"]] == ["HV-3201"]
    assert rows["REQ-9"]["verdict"] == "manual"
    assert rows["REQ-8"]["verdict"] == "no_data"
    assert rows["REQ-8"]["checked"] == 0

    # Deleting the requirement cascades its checks and trace links.
    assert client.delete(f"/requirements/{checked['id']}").status_code == 204
    assert client.get(f"/sheets/{drawing['sheets'][0]['id']}/drc").json()["checks"] == []
    assert client.get(f"/objects/drawing/{drawing['id']}/trace").json() == []
    # Stored findings stay until the next save; the deleted requirement is just unlinked.
    assert client.get(f"/drawings/{drawing['id']}/drc").json()["counts"]["error"] == 3
    assert client.delete(f"/requirements/{manual['id']}").status_code == 204


def test_pdf_export_appends_extra_pages(client: TestClient) -> None:
    project_id = _project(client)
    drawing = _drawing(client, project_id)
    sheet_id = drawing["sheets"][0]["id"]
    single = client.post(f"/sheets/{sheet_id}/export", json={"svg": SVG, "format": "pdf"})
    assert single.status_code == 200
    assert len(PdfReader(io.BytesIO(single.content)).pages) == 1
    double = client.post(
        f"/sheets/{sheet_id}/export", json={"svg": SVG, "format": "pdf", "pages": [SVG]}
    )
    assert double.status_code == 200, double.text
    assert double.headers["content-type"] == "application/pdf"
    assert len(PdfReader(io.BytesIO(double.content)).pages) == 2
    # PNG ignores extra pages; a non-SVG page is rejected.
    png = client.post(
        f"/sheets/{sheet_id}/export", json={"svg": SVG, "format": "png", "dpi": 50, "pages": [SVG]}
    )
    assert png.status_code == 200
    bad = client.post(
        f"/sheets/{sheet_id}/export", json={"svg": SVG, "format": "pdf", "pages": ["<html>"]}
    )
    assert bad.status_code == 422
