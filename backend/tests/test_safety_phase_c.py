"""Safety phase C: volumes stored with the index, analyses (trapped volume,
relief scenario, single-point failure, fault tolerance), outdated tracking,
evidence attachment, auto-hazards from relief findings, the safety overlay,
and change impact through the safety objects."""

from fastapi.testclient import TestClient


def _project(client: TestClient) -> str:
    return client.post("/projects", json={"name": "LOX GSE", "part_name_prefix": "LOX"}).json()[
        "id"
    ]


def _item(item_id: str, category: str, symbol_key: str, tag: str, volume: str | None, **fields):
    return {
        "item_id": item_id,
        "kind": "symbol",
        "category": category,
        "symbol_key": symbol_key,
        "symbol_name": symbol_key.replace("_", " ").title(),
        "tag": tag,
        "label": None,
        "zone": "C-4",
        "x": 10,
        "y": 10,
        "part_id": fields.pop("part_id", None),
        "dnp": False,
        "spare": 0,
        "fields": {"service": "LOX", "volume_key": volume, **fields},
    }


def _line(line_id: str, number: str, from_item: str, to_item: str, **extra):
    return {
        "line_id": line_id,
        "line_number": number,
        "line_type": "process",
        "service": "LOX",
        "size": "DN50",
        "spec": None,
        "line_class": None,
        "from_item": from_item,
        "from_tag": None,
        "to_item": to_item,
        "to_tag": None,
        "zone": "C-4",
        "length_mm": 120,
        "length_m": 6.0,
        "connection_count": 2,
        "tee_count": 0,
        "design_pressure": "40 bar",
        "design_temperature": "-183 C",
        "operating_pressure": None,
        "operating_temperature": None,
        "insulation": None,
        "tracing": None,
        "fields": {},
        **extra,
    }


# Tank -> FV-201 -> L-2014 -> L-2015 -> QD-201; the section between FV-201 and
# QD-201 is an isolable volume with no relief.
ITEMS = [
    _item("tank", "equipment", "tank", "TK-100", "vol-aaaa0001"),
    _item("fv201", "valve", "pneumatic_valve", "FV-201", "vol-aaaa0001"),
    _item("pt205", "instrument", "instrument", "PT-205", "vol-bbbb0002"),
    _item("qd201", "inline", "quick_disconnect", "QD-201", "vol-bbbb0002"),
]
LINES = [
    _line("l1", "L-2010", "tank", "fv201"),
    _line("l2", "L-2014", "fv201", "pt205"),
    _line("l3", "L-2015", "pt205", "qd201"),
]
VOLUMES = [
    {
        "key": "vol-aaaa0001",
        "line_ids": ["l1"],
        "item_ids": ["tank", "fv201"],
        "isolable": False,
        "relieved": False,
        "relief_item_ids": [],
        "isolating_item_ids": ["fv201"],
        "service": "LOX",
        "design_pressure": "40 bar",
        "design_temperature": "-183 C",
        "line_numbers": ["L-2010"],
        "length_m": 6.0,
    },
    {
        "key": "vol-bbbb0002",
        "line_ids": ["l2", "l3"],
        "item_ids": ["fv201", "pt205", "qd201"],
        "isolable": True,
        "relieved": False,
        "relief_item_ids": [],
        "isolating_item_ids": ["fv201"],
        "service": "LOX",
        "design_pressure": "40 bar",
        "design_temperature": "-183 C",
        "line_numbers": ["L-2014", "L-2015"],
        "length_m": 12.0,
    },
]
RELIEF_FINDING = {
    "key": "relief_coverage:l2",
    "rule": "relief_coverage",
    "severity": "warning",
    "message": "Isolable volume (L-2014, L-2015) has no relief device",
    "item_id": "l2",
    "subject": "L-2014",
    "zone": "C-4",
}


def _document(items: list[dict]) -> dict:
    return {
        "schemaVersion": 1,
        "sheet": {"size": "A3", "orientation": "landscape", "units": "mm"},
        "items": items,
    }


def _drawing(client: TestClient, project_id: str) -> tuple[str, str]:
    drawing = client.post(
        f"/projects/{project_id}/drawings", json={"title": "LOX P&ID", "size": "ANSI_E"}
    ).json()
    return drawing["id"], drawing["sheets"][0]["id"]


def _save(client: TestClient, sheet_id: str, *, document=None, findings=None, volumes=VOLUMES):
    payload = {
        "index": {"items": ITEMS, "lines": LINES, "volumes": volumes},
        "drc": {"findings": findings or [], "checks": []},
    }
    if document is not None:
        payload["document"] = document
    response = client.put(f"/sheets/{sheet_id}", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_volumes_are_stored_and_listed(client: TestClient) -> None:
    project_id = _project(client)
    drawing_id, sheet_id = _drawing(client, project_id)
    _save(client, sheet_id)
    volumes = client.get(f"/sheets/{sheet_id}/volumes").json()
    assert [(v["key"], v["isolable"], v["relieved"]) for v in volumes] == [
        ("vol-aaaa0001", False, False),
        ("vol-bbbb0002", True, False),
    ]
    isolable = volumes[1]
    assert isolable["isolating_tags"] == ["FV-201"]
    assert isolable["item_tags"] == ["FV-201", "PT-205", "QD-201"]
    assert isolable["line_numbers"] == ["L-2014", "L-2015"]
    assert isolable["drawing_number"].startswith("LOX") and isolable["sheet_no"] == 1
    assert client.get(f"/drawings/{drawing_id}/volumes").json()[1]["key"] == "vol-bbbb0002"
    assert len(client.get(f"/projects/{project_id}/volumes").json()) == 2
    # A re-save with one volume gone removes it.
    _save(client, sheet_id, volumes=VOLUMES[1:])
    assert [v["key"] for v in client.get(f"/sheets/{sheet_id}/volumes").json()] == ["vol-bbbb0002"]


def test_trapped_volume_and_relief_scenario_analyses(client: TestClient) -> None:
    project_id = _project(client)
    drawing_id, sheet_id = _drawing(client, project_id)
    _save(client, sheet_id, document=_document([]))

    created = client.post(
        f"/projects/{project_id}/analyses", json={"kind": "trapped_volume", "sheet_id": sheet_id}
    )
    assert created.status_code == 201, created.text
    analysis = created.json()
    assert analysis["title"].startswith("Trapped volumes")
    assert analysis["verdict"] == "fail"
    assert analysis["outdated"] is False
    volumes = analysis["result"]["volumes"]
    assert len(volumes) == 1 and volumes[0]["volume_key"] == "vol-bbbb0002"
    assert volumes[0]["liquid"] is True
    assert volumes[0]["temperature_rise_to_design_k"] == 1.0  # 40 bar / (9000 * 0.0045)
    assert volumes[0]["reaches_design_pressure_on_warm_up"] is True
    assert volumes[0]["isolating_tags"] == ["FV-201"]
    assert analysis["assumptions"]["fluids"]["LOX"]["bulk_modulus_bar"] == 9000.0

    requirement = client.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": "REQ-SAF-031",
            "title": "Relief",
            "text": "Shall.",
            "requirement_type": "safety",
            "verification_method": "analysis",
        },
    ).json()
    attached = client.post(
        f"/analyses/{analysis['id']}/attach-evidence", json={"requirement_id": requirement["id"]}
    )
    assert attached.status_code == 200, attached.text
    assert attached.json()["evidence_for"] == [requirement["id"]]
    assert (
        client.get(f"/requirements/{requirement['id']}").json()["verification_status"] == "failed"
    )

    # Saving a changed document marks the analysis outdated; attaching is then refused.
    _save(
        client,
        sheet_id,
        document={
            **_document([]),
            "sheet": {"size": "A2", "orientation": "landscape", "units": "mm"},
        },
    )
    assert client.get(f"/analyses/{analysis['id']}").json()["outdated"] is True
    refused = client.post(
        f"/analyses/{analysis['id']}/attach-evidence", json={"requirement_id": requirement["id"]}
    )
    assert refused.status_code == 409
    rerun = client.post(f"/analyses/{analysis['id']}/run").json()
    assert rerun["outdated"] is False and rerun["run_by"] == "engineer@fsdp.test"

    scenario = client.post(
        f"/projects/{project_id}/analyses",
        json={
            "kind": "relief_scenario",
            "sheet_id": sheet_id,
            "scope": {"volume_key": "vol-bbbb0002"},
            "assumptions": {"scenario": "thermal_expansion", "heat_input_w_per_m": 25.0},
        },
    ).json()
    assert scenario["verdict"] == "fail"
    assert scenario["result"]["required_kw"] == 0.3
    assert scenario["result"]["required_kg_s"] == round(0.3 / 213.0, 5)
    assert "No relief device on this volume." in scenario["result"]["notes"]

    listed = client.get(f"/projects/{project_id}/analyses").json()
    assert [entry["kind"] for entry in listed] == ["trapped_volume", "relief_scenario"]
    gone = client.delete(f"/analyses/{analysis['id']}")
    assert gone.status_code == 204
    assert (
        client.get(f"/requirements/{requirement['id']}").json()["verification_status"] == "planned"
    )


def test_single_point_failure_and_fault_tolerance(client: TestClient) -> None:
    project_id = _project(client)
    drawing_id, sheet_id = _drawing(client, project_id)
    _save(client, sheet_id)
    spf = client.post(
        f"/projects/{project_id}/analyses",
        json={"kind": "single_point_failure", "sheet_id": sheet_id},
    ).json()
    # One valve between the tank and the quick disconnect: it is a single point.
    assert spf["verdict"] == "fail"
    assert [entry["tag"] for entry in spf["result"]["single_points"]] == ["FV-201"]
    assert spf["result"]["sources"] == ["TK-100"] and spf["result"]["boundaries"] == ["QD-201"]

    hazard = client.post(
        f"/projects/{project_id}/hazards",
        json={"title": "Loss of isolation", "severity_initial": "I", "likelihood_initial": "C"},
    ).json()
    requirement = client.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": "REQ-1",
            "title": "Two valves",
            "text": "Shall.",
            "requirement_type": "safety",
        },
    ).json()
    client.post(
        f"/hazards/{hazard['id']}/controls", json={"type": "requirement", "id": requirement["id"]}
    )
    tolerance = client.post(
        f"/projects/{project_id}/analyses",
        json={"kind": "fault_tolerance", "scope": {"hazard_id": hazard["id"]}},
    ).json()
    assert tolerance["verdict"] == "fail"
    assert tolerance["result"] == {
        **tolerance["result"],
        "hazard_key": hazard["key"],
        "required": 2,
        "independent": 1,
        "verified": 0,
    }


def test_auto_hazard_from_relief_finding_overlay_and_impact(client: TestClient) -> None:
    project_id = _project(client)
    settings = client.get(f"/projects/{project_id}/safety-settings").json()["settings"]
    settings["auto_hazard"] = True
    client.put(f"/projects/{project_id}/safety-settings", json={"settings": settings})
    drawing_id, sheet_id = _drawing(client, project_id)
    _save(client, sheet_id, findings=[RELIEF_FINDING])

    hazards = client.get(f"/projects/{project_id}/hazards").json()
    assert len(hazards) == 1
    hazard = hazards[0]
    assert hazard["category"] == "trapped_fluid"
    assert hazard["volume_keys"] == ["vol-bbbb0002"]
    assert "L-2014, L-2015" in hazard["title"]
    assert hazard["fault_tolerance_required"] == 2
    # A second save does not create a second hazard, and the finding links to it.
    _save(client, sheet_id, findings=[RELIEF_FINDING])
    assert len(client.get(f"/projects/{project_id}/hazards").json()) == 1
    project_drc = client.get(f"/projects/{project_id}/drc").json()
    assert project_drc["counts"]["warning"] == 1
    assert project_drc["findings"][0]["hazard_key"] == hazard["key"]
    volumes = client.get(f"/sheets/{sheet_id}/volumes").json()
    assert volumes[1]["hazard_keys"] == [hazard["key"]]

    # Waiving the finding needs the hazard accepted first.
    blocked = client.put(
        f"/sheets/{sheet_id}/drc/waivers", json={"key": RELIEF_FINDING["key"], "reason": "ok"}
    )
    assert blocked.status_code == 409
    client.post(f"/hazards/{hazard['id']}/accept", json={"justification": "Vent procedure"})
    allowed = client.put(
        f"/sheets/{sheet_id}/drc/waivers", json={"key": RELIEF_FINDING["key"], "reason": "ok"}
    )
    assert allowed.status_code == 201

    # Overlay: FMEA rows on FV-201 plus the hazard scoped to the volume.
    worksheet = client.post(
        f"/projects/{project_id}/fmea", json={"title": "LOX", "drawing_id": drawing_id}
    ).json()
    client.post(f"/fmea/{worksheet['id']}/generate", json={"categories": ["valve"]})
    rows = client.get(f"/fmea/{worksheet['id']}/rows").json()
    first = rows[0]
    client.put(
        f"/fmea/rows/{first['id']}",
        json={"hazard_id": hazard["id"], "occurrence": 5, "detection": 5},
    )
    overlay = client.get(f"/sheets/{sheet_id}/safety-overlay").json()
    fv = next(entry for entry in overlay["items"] if entry["tag"] == "FV-201")
    assert fv["open_rows"] == len(rows)
    assert fv["hazard_keys"] == [hazard["key"]]
    assert fv["max_rpn"] == first["severity"] * 25
    assert fv["highest_risk"] == "high"
    volume_entry = next(entry for entry in overlay["volumes"] if entry["key"] == "vol-bbbb0002")
    assert volume_entry["hazard_keys"] == [hazard["key"]] and volume_entry["highest_risk"] == "high"

    # Change impact from the part on FV-201 walks rows -> hazard -> requirement.
    requirement = client.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": "REQ-SAF-031",
            "title": "Relief",
            "text": "Shall.",
            "requirement_type": "safety",
        },
    ).json()
    client.post(
        f"/hazards/{hazard['id']}/controls", json={"type": "requirement", "id": requirement["id"]}
    )
    part = client.post(
        "/parts", json={"part_number": "AMPH-VL-022", "description": "Valve", "part_type": "valve"}
    ).json()
    items = [
        dict(item, part_id=part["id"]) if item["item_id"] == "fv201" else item for item in ITEMS
    ]
    client.put(
        f"/sheets/{sheet_id}", json={"index": {"items": items, "lines": LINES, "volumes": VOLUMES}}
    )
    impact = client.get(
        "/changes/impact", params={"object_type": "part", "object_id": part["id"]}
    ).json()
    assert [entry["tag"] for entry in impact["affected_items"]] == ["FV-201"]
    assert len(impact["affected_fmea_rows"]) == len(rows)
    assert all(row["stale_reason"] == "part_changed" for row in impact["affected_fmea_rows"])
    assert [entry["key"] for entry in impact["affected_hazards"]] == [hazard["key"]]
    assert [entry["key"] for entry in impact["affected_requirements"]] == ["REQ-SAF-031"]
    from_hazard = client.get(
        "/changes/impact", params={"object_type": "hazard", "object_id": hazard["id"]}
    ).json()
    assert len(from_hazard["affected_fmea_rows"]) == 1
    assert [entry["key"] for entry in from_hazard["affected_requirements"]] == ["REQ-SAF-031"]
