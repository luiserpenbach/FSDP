"""Safety phase A: hazard log, controls, derived requirements, evidence roll-up,
DRC evidence mirrored from sheet saves, requirement history and derivation."""

import io

from fastapi.testclient import TestClient


def _project(client: TestClient, name: str = "LOX GSE") -> str:
    return client.post("/projects", json={"name": name, "part_name_prefix": "LOX"}).json()["id"]


def _requirement(client: TestClient, project_id: str, key: str, **extra: object) -> dict:
    body = {
        "project_id": project_id,
        "key": key,
        "title": f"Requirement {key}",
        "text": "Shall.",
        "requirement_type": "safety",
        "category": "safety",
    }
    body.update(extra)
    response = client.post("/requirements", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _hazard(client: TestClient, project_id: str, **extra: object) -> dict:
    body = {
        "title": "Overpressure of trapped LOX between FV-201 and QD-201",
        "category": "trapped_fluid",
        "severity_initial": "I",
        "likelihood_initial": "C",
        "operating_modes": ["hold", "abort_safe"],
    }
    body.update(extra)
    response = client.post(f"/projects/{project_id}/hazards", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _drawing_with_sheet(client: TestClient, project_id: str) -> tuple[str, str]:
    drawing = client.post(
        f"/projects/{project_id}/drawings", json={"title": "LOX P&ID", "size": "ANSI_E"}
    ).json()
    return drawing["id"], drawing["sheets"][0]["id"]


def _save_checks(client: TestClient, sheet_id: str, requirement_id: str, status: str) -> None:
    payload = {
        "index": {
            "items": [
                {
                    "item_id": "fv201",
                    "kind": "symbol",
                    "category": "valve",
                    "symbol_key": "valve.gate",
                    "symbol_name": "Gate valve",
                    "tag": "FV-201",
                    "label": None,
                    "zone": "C-4",
                    "x": 100,
                    "y": 100,
                    "part_id": None,
                    "dnp": False,
                    "spare": 0,
                    "fields": {},
                },
                {
                    "item_id": "trv201",
                    "kind": "symbol",
                    "category": "relief",
                    "symbol_key": "relief.thermal",
                    "symbol_name": "Thermal relief valve",
                    "tag": "TRV-201",
                    "label": None,
                    "zone": "C-5",
                    "x": 140,
                    "y": 100,
                    "part_id": None,
                    "dnp": False,
                    "spare": 0,
                    "fields": {},
                },
            ],
            "lines": [],
        },
        "drc": {
            "findings": [],
            "checks": [
                {
                    "requirementId": requirement_id,
                    "itemId": "trv201",
                    "subject": "TRV-201",
                    "zone": "C-5",
                    "status": status,
                    "message": "relief present" if status == "pass" else "no relief",
                }
            ],
        },
    }
    response = client.put(f"/sheets/{sheet_id}", json=payload)
    assert response.status_code == 200, response.text


def test_safety_settings_default_and_update(client: TestClient) -> None:
    project_id = _project(client)
    settings = client.get(f"/projects/{project_id}/safety-settings").json()["settings"]
    assert settings["fault_tolerance"] == {"I": 2, "II": 2, "III": 1, "IV": 1}
    assert settings["risk_matrix"]["I"]["A"] == "high"
    assert "hold" in settings["operating_modes"]

    settings["fault_tolerance"]["I"] = 3
    settings["unknown_key"] = "dropped"
    updated = client.put(
        f"/projects/{project_id}/safety-settings", json={"settings": settings}
    ).json()["settings"]
    assert updated["fault_tolerance"]["I"] == 3
    assert "unknown_key" not in updated
    assert updated["operating_modes"] == settings["operating_modes"]


def test_hazard_keys_ratings_and_matrix(client: TestClient) -> None:
    project_id = _project(client)
    first = _hazard(client, project_id)
    second = _hazard(client, project_id, title="Backflow into pump", severity_initial="II")
    assert (first["key"], second["key"]) == ("HZ-001", "HZ-002")
    assert first["fault_tolerance_required"] == 2
    assert first["risk_initial"] == "high"
    assert first["computed_status"] == "open"
    assert first["controls_total"] == 0

    bad = client.post(
        f"/projects/{project_id}/hazards",
        json={"title": "x", "severity_initial": "V", "likelihood_initial": "A"},
    )
    assert bad.status_code == 422

    matrix = client.get(f"/projects/{project_id}/hazards/matrix").json()
    assert matrix["initial"]["I"]["C"] == 1
    assert matrix["initial"]["II"]["C"] == 1
    assert matrix["residual"]["I"]["C"] == 1
    assert matrix["unrated"] == 0

    listed = client.get(f"/projects/{project_id}/hazards", params={"mode": "hold"}).json()
    assert [entry["key"] for entry in listed] == ["HZ-001", "HZ-002"]
    filtered = client.get(
        f"/projects/{project_id}/hazards", params={"category": "trapped_fluid", "severity": "II"}
    ).json()
    assert [entry["key"] for entry in filtered] == ["HZ-002"]


def test_hazard_controlled_only_when_controls_verify_and_policy_is_met(
    client: TestClient,
) -> None:
    project_id = _project(client)
    hazard = _hazard(client, project_id)
    relief = _requirement(
        client,
        project_id,
        "REQ-SAF-031",
        constraint={"kind": "relief_required", "values": [], "scope": {"services": ["LOX"]}},
    )
    assert relief["verification_status"] == "planned"
    assert relief["safety_critical"] is False

    added = client.post(
        f"/hazards/{hazard['id']}/controls", json={"type": "requirement", "id": relief["id"]}
    )
    assert added.status_code == 201, added.text
    view = added.json()
    assert view["controls_total"] == 1
    assert view["controls"][0]["verification_status"] == "planned"
    assert view["computed_status"] == "open"
    duplicate = client.post(
        f"/hazards/{hazard['id']}/controls", json={"type": "requirement", "id": relief["id"]}
    )
    assert duplicate.status_code == 409

    # Linking to a severity I hazard makes the requirement safety-critical.
    assert client.get(f"/projects/{project_id}/requirements").json()[0]["safety_critical"] is True

    # A saved sheet with a passing check verifies the requirement through live DRC evidence.
    _, sheet_id = _drawing_with_sheet(client, project_id)
    _save_checks(client, sheet_id, relief["id"], "pass")
    evidence = client.get(f"/requirements/{relief['id']}/evidence").json()
    assert [(row["kind"], row["status"]) for row in evidence] == [("drc", "pass")]
    view = client.get(f"/hazards/{hazard['id']}").json()
    assert view["controls_verified"] == 1
    assert view["independent_controls"] == 1
    # Policy for severity I asks for two independent controls: still open.
    assert view["computed_status"] == "open"

    # Derive a second requirement straight from the hazard: linked, safety-critical, rationale set.
    derived = client.post(
        f"/hazards/{hazard['id']}/derive-requirement",
        json={
            "key": "REQ-SAF-034",
            "title": "Drainback before isolation",
            "text": (
                "The hold procedure shall open the drainback valve before isolating "
                "the fill line."
            ),
            "verification_method": "Demonstration",
        },
    )
    assert derived.status_code == 201, derived.text
    body = derived.json()
    assert body["rationale"].startswith("Controls HZ-001")
    assert body["safety_critical"] is True
    assert body["verification_method"] == "demonstration"
    assert body["category"] == "safety"
    view = client.get(f"/hazards/{hazard['id']}").json()
    assert view["controls_total"] == 2
    assert view["computed_status"] == "open"

    # Demonstration evidence passes: both controls verified, policy met -> controlled.
    recorded = client.post(
        f"/requirements/{body['id']}/evidence",
        json={"kind": "demonstration", "status": "pass", "note": "Procedure LOX-OPS-12 signed"},
    )
    assert recorded.status_code == 422  # not an evidence kind
    recorded = client.post(
        f"/requirements/{body['id']}/evidence",
        json={"kind": "document", "status": "pass", "ref_id": "LOX-OPS-12", "note": "signed"},
    )
    assert recorded.status_code == 201, recorded.text
    view = client.get(f"/hazards/{hazard['id']}").json()
    assert view["controls_verified"] == 2
    assert view["computed_status"] == "controlled"

    # A failing check on the next save drops the hazard back to open.
    _save_checks(client, sheet_id, relief["id"], "fail")
    assert client.get(f"/hazards/{hazard['id']}").json()["computed_status"] == "open"
    matrix_row = next(
        row
        for row in client.get(f"/projects/{project_id}/verification-matrix").json()["rows"]
        if row["key"] == "REQ-SAF-031"
    )
    assert matrix_row["verification_status"] == "failed"
    assert matrix_row["evidence"] == {"drc": 1}
    assert matrix_row["hazards"] == ["HZ-001"]
    assert matrix_row["safety_critical"] is True

    # Removing the control clears safety-critical when no other I/II hazard remains.
    link_id = view["controls"][0]["link_id"]
    removed = client.delete(f"/hazards/{hazard['id']}/controls/{link_id}")
    assert removed.status_code == 200, removed.text
    assert removed.json()["controls_total"] == 1
    relief_now = next(
        row
        for row in client.get(f"/projects/{project_id}/requirements").json()
        if row["id"] == relief["id"]
    )
    assert relief_now["safety_critical"] is False


def test_hardware_control_counts_only_when_covered_by_a_requirement(client: TestClient) -> None:
    project_id = _project(client)
    hazard = _hazard(client, project_id, severity_initial="III", likelihood_initial="D")
    assert hazard["fault_tolerance_required"] == 1
    material = _requirement(
        client, project_id, "REQ-MAT-1", constraint={"kind": "material_in", "values": ["316L"]}
    )
    _, sheet_id = _drawing_with_sheet(client, project_id)
    # Save with no checks: the relief valve exists on the sheet but no requirement applies to it.
    _save_checks(client, sheet_id, material["id"], "pass")
    picks = client.get(f"/projects/{project_id}/sheet-items", params={"q": "trv"}).json()
    assert [pick["tag"] for pick in picks] == ["TRV-201"]
    assert picks[0]["sheet_no"] == 1 and picks[0]["category"] == "relief"
    items = client.get(f"/sheets/{sheet_id}/index").json()["items"]
    trv = next(item for item in items if item["tag"] == "TRV-201")
    assert trv["id"] == picks[0]["id"]

    view = client.post(
        f"/hazards/{hazard['id']}/controls", json={"type": "sheet_item", "id": trv["id"]}
    ).json()
    control = view["controls"][0]
    assert control["type"] == "sheet_item"
    assert control["label"] == "TRV-201"
    # The material check above ran on trv201, so the requirement covers the item.
    assert control["covered"] is True
    assert control["covering_requirements"] == ["REQ-MAT-1"]
    assert control["verification_status"] == "verified"
    assert view["computed_status"] == "controlled"

    # Sheet item ids survive a re-save, so the control still resolves.
    _save_checks(client, sheet_id, material["id"], "pass")
    items_after = client.get(f"/sheets/{sheet_id}/index").json()["items"]
    assert next(item for item in items_after if item["tag"] == "TRV-201")["id"] == trv["id"]
    assert client.get(f"/hazards/{hazard['id']}").json()["controls"][0]["label"] == "TRV-201"


def test_accept_delete_and_history(client: TestClient) -> None:
    project_id = _project(client)
    hazard = _hazard(client, project_id)
    accepted = client.post(
        f"/hazards/{hazard['id']}/accept", json={"justification": "Residual risk medium; agreed."}
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "accepted"
    assert accepted.json()["computed_status"] == "accepted"
    assert accepted.json()["accepted_by"] == "engineer@fsdp.test"

    via_put = client.put(f"/hazards/{hazard['id']}", json={"status": "closed"})
    assert via_put.status_code == 200
    assert via_put.json()["computed_status"] == "closed"

    parent = _requirement(client, project_id, "SITE-4.2", category="safety")
    child = _requirement(client, project_id, "REQ-SAF-001", parent_id=parent["id"])
    assert child["parent_id"] == parent["id"]
    cycle = client.put(f"/requirements/{parent['id']}", json={"parent_id": child["id"]})
    assert cycle.status_code == 422
    other_project = _project(client, "Other")
    foreign = _requirement(client, other_project, "X-1")
    bad_parent = client.put(f"/requirements/{child['id']}", json={"parent_id": foreign["id"]})
    assert bad_parent.status_code == 422

    updated = client.put(
        f"/requirements/{child['id']}",
        json={"title": "Renamed", "owner": "GSE lead", "title2": "ignored"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["revision"] == 2
    history = client.get(f"/requirements/{child['id']}/history").json()
    assert {(row["field"], row["new_value"]) for row in history} == {
        ("title", "Renamed"),
        ("owner", "GSE lead"),
    }
    assert history[0]["actor"] == "engineer@fsdp.test"
    unchanged = client.put(f"/requirements/{child['id']}", json={"title": "Renamed"})
    assert unchanged.json()["revision"] == 2

    client.post(
        f"/hazards/{hazard['id']}/controls", json={"type": "requirement", "id": child["id"]}
    )
    deleted = client.delete(f"/hazards/{hazard['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/hazards/{hazard['id']}").status_code == 404
    assert (
        client.get(f"/objects/requirement/{child['id']}/trace").json() == []
    )


def test_requirement_filters_and_waiver_rollup(client: TestClient) -> None:
    project_id = _project(client)
    safety = _requirement(client, project_id, "REQ-SAF-9")
    _requirement(client, project_id, "REQ-PERF-1", category="performance")
    by_category = client.get(
        f"/projects/{project_id}/requirements", params={"category": "performance"}
    ).json()
    assert [row["key"] for row in by_category] == ["REQ-PERF-1"]
    by_query = client.get(f"/projects/{project_id}/requirements", params={"q": "saf"}).json()
    assert [row["key"] for row in by_query] == ["REQ-SAF-9"]

    pending = client.post(
        f"/requirements/{safety['id']}/evidence", json={"kind": "test", "status": "pending"}
    ).json()
    assert client.get(f"/requirements/{safety['id']}").json()["verification_status"] == (
        "in_progress"
    )
    rows = client.get(
        f"/projects/{project_id}/requirements", params={"verification_status": "in_progress"}
    ).json()
    assert [row["key"] for row in rows] == ["REQ-SAF-9"]
    client.post(
        f"/requirements/{safety['id']}/evidence",
        json={"kind": "waiver", "status": "pass", "note": "Waived by SMA"},
    )
    rows = client.get(f"/projects/{project_id}/requirements", params={"q": "REQ-SAF-9"}).json()
    assert rows[0]["verification_status"] == "waived"
    client.put(f"/evidence/{pending['id']}", json={"status": "pass"})
    rows = client.get(f"/projects/{project_id}/requirements", params={"q": "REQ-SAF-9"}).json()
    assert rows[0]["verification_status"] == "waived"
    drc_like = client.delete(f"/evidence/{pending['id']}")
    assert drc_like.status_code == 204
    rows = client.get(f"/projects/{project_id}/requirements", params={"q": "REQ-SAF-9"}).json()
    assert rows[0]["verification_status"] == "waived"

    unknown = client.post(
        "/trace-links",
        json={
            "source_type": "requirement",
            "source_id": safety["id"],
            "target_type": "project",
            "target_id": project_id,
            "link_type": "made_up",
        },
    )
    assert unknown.status_code == 422


def test_import_export_and_coverage(client: TestClient) -> None:
    project_id = _project(client)
    csv_text = (
        "ID,Requirement,Type,Verification,Parent,Clause\n"
        "SITE-4.2,Every isolable cryogenic volume shall have thermal relief.,Safety,Analysis,"
        ",4.2\n"
        "REQ-SAF-031,Every isolable LOX volume shall have a thermal relief valve.,safety,"
        "design rule,SITE-4.2,\n"
        "REQ-PERF-001,Fast fill shall deliver 40 kg/s.,performance,test,MISSING-1,\n"
    )
    files = {"file": ("reqs.csv", csv_text.encode(), "text/csv")}
    dry = client.post(
        f"/projects/{project_id}/requirements/import", files=files, data={"dry_run": "true"}
    )
    assert dry.status_code == 200, dry.text
    body = dry.json()
    assert body["dry_run"] is True
    assert (body["created"], body["updated"], body["skipped"]) == (3, 0, 0)
    assert body["mapping"] == {
        "ID": "key",
        "Requirement": "text",
        "Type": "category",
        "Verification": "verification_method",
        "Parent": "parent_key",
        "Clause": "source_ref",
    }
    assert any("MISSING-1" in error for error in body["errors"])
    assert client.get(f"/projects/{project_id}/requirements").json() == []

    real = client.post(f"/projects/{project_id}/requirements/import", files=files)
    assert real.status_code == 200, real.text
    assert real.json()["created"] == 3
    rows = {row["key"]: row for row in client.get(f"/projects/{project_id}/requirements").json()}
    assert rows["REQ-SAF-031"]["parent_id"] == rows["SITE-4.2"]["id"]
    assert rows["REQ-SAF-031"]["category"] == "safety"
    assert rows["REQ-SAF-031"]["verification_method"] == "design rule"
    assert rows["SITE-4.2"]["source_ref"] == "4.2"
    assert rows["REQ-PERF-001"]["parent_id"] is None

    # Re-import without update_existing skips; with it, updates in place.
    again = client.post(f"/projects/{project_id}/requirements/import", files=files).json()
    assert (again["created"], again["skipped"]) == (0, 3)
    updated_csv = csv_text.replace("Fast fill shall deliver 40 kg/s.", "Fast fill: 45 kg/s.")
    updated = client.post(
        f"/projects/{project_id}/requirements/import",
        files={"file": ("reqs.csv", updated_csv.encode(), "text/csv")},
        data={"update_existing": "true"},
    ).json()
    assert updated["updated"] == 3
    rows = {row["key"]: row for row in client.get(f"/projects/{project_id}/requirements").json()}
    assert rows["REQ-PERF-001"]["text"] == "Fast fill: 45 kg/s."

    # XLSX round trip through export.
    export = client.get(f"/projects/{project_id}/requirements/export", params={"format": "xlsx"})
    assert export.status_code == 200
    assert "attachment" in export.headers["content-disposition"]
    from openpyxl import load_workbook

    sheet = load_workbook(io.BytesIO(export.content)).worksheets[0]
    values = [[cell for cell in row] for row in sheet.iter_rows(values_only=True)]
    header_row = next(row for row in values if row and row[0] == "Key")
    assert header_row[:3] == ["Key", "Title", "Text"]
    exported_keys = {row[0] for row in values[values.index(header_row) + 1 :]}
    assert exported_keys == {"SITE-4.2", "REQ-SAF-031", "REQ-PERF-001"}
    xlsx_files = {"file": ("reqs.xlsx", export.content, "application/octet-stream")}
    from_xlsx = client.post(
        f"/projects/{project_id}/requirements/import",
        files=xlsx_files,
        data={"dry_run": "true", "mapping": '{"Derives from": "parent_key"}'},
    ).json()
    assert from_xlsx["errors"] == []
    assert from_xlsx["skipped"] == 3

    csv_export = client.get(f"/projects/{project_id}/requirements/export")
    assert csv_export.status_code == 200 and "REQ-SAF-031" in csv_export.text
    matrix_xlsx = client.get(
        f"/projects/{project_id}/verification-matrix", params={"format": "xlsx"}
    )
    assert matrix_xlsx.status_code == 200
    assert matrix_xlsx.headers["content-type"].startswith("application/vnd.openxmlformats")

    # Coverage: nothing traced yet, one hazard without controls.
    hazard = _hazard(client, project_id)
    client.post(
        f"/hazards/{hazard['id']}/controls",
        json={"type": "requirement", "id": rows["REQ-SAF-031"]["id"]},
    )
    empty = _hazard(client, project_id, title="Uncontrolled", severity_initial="III")
    report = client.get(f"/projects/{project_id}/requirements/coverage").json()
    assert report["totals"] == {
        "requirements": 3,
        "hazards": 2,
        "traced": 0,
        "with_evidence": 0,
    }
    assert {row["key"] for row in report["untraced_requirements"]} == set(rows)
    assert [row["key"] for row in report["critical_without_evidence"]] == ["REQ-SAF-031"]
    assert [row["key"] for row in report["hazards_without_controls"]] == [empty["key"]]
    assert report["uncovered_hardware_controls"] == []
