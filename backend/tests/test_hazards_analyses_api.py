"""Hazard register and stored analyses over the API."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import hazard_risk_level


def _project(client: TestClient, name: str = "AMB2") -> str:
    return client.post("/projects", json={"name": name}).json()["id"]


def _hazard(client: TestClient, project_id: str, **overrides) -> dict:
    response = client.post(
        f"/projects/{project_id}/hazards", json={"title": "Trapped LN2", **overrides}
    )
    assert response.status_code == 201, response.text
    return response.json()


def _sheet_item(client: TestClient, project_id: str, tag: str = "HV-1") -> str:
    drawing = client.post(f"/projects/{project_id}/drawings", json={"title": "P&ID"}).json()
    sheet_id = drawing["sheets"][0]["id"]
    index = {"items": [{"item_id": "hv", "kind": "symbol", "tag": tag}], "lines": []}
    assert client.put(f"/sheets/{sheet_id}", json={"index": index}).status_code == 200
    return client.get(f"/sheets/{sheet_id}/index").json()["items"][0]["id"]


def _link(client: TestClient, hazard_id: str, target_type: str, target_id: str):
    return client.post(
        "/trace-links",
        json={
            "source_type": "hazard",
            "source_id": hazard_id,
            "target_type": target_type,
            "target_id": target_id,
            "link_type": "applies_to",
        },
    )


def _viewer(client: TestClient) -> TestClient:
    created = client.post(
        "/auth/users",
        json={
            "email": "viewer@fsdp.test",
            "name": "Viewer",
            "password": "viewer-password",
            "role": "viewer",
        },
    )
    assert created.status_code == 201, created.text
    viewer = TestClient(app)
    login = viewer.post(
        "/auth/login", json={"email": "viewer@fsdp.test", "password": "viewer-password"}
    )
    assert login.status_code == 200
    return viewer


# ---- hazards ----


@pytest.mark.parametrize(
    ("severity", "likelihood", "level"),
    [(1, 1, "low"), (2, 2, "low"), (1, 5, "medium"), (3, 3, "medium"), (4, 1, "medium"),
     (2, 5, "high"), (3, 4, "high"), (4, 5, "high")],
)
def test_risk_level(severity: int, likelihood: int, level: str) -> None:
    assert hazard_risk_level(severity, likelihood) == level


def test_hazard_crud_with_generated_keys_and_derived_risk(client: TestClient) -> None:
    project_id = _project(client)

    first = _hazard(client, project_id, category="trapped_fluid", severity=3, likelihood=4)
    second = _hazard(client, project_id, title="Backflow into GN2 supply")
    custom = _hazard(client, project_id, key="HAZ-010", title="Ignition source")
    after_custom = _hazard(client, project_id, title="Next")

    assert [first["key"], second["key"], custom["key"], after_custom["key"]] == [
        "HAZ-001",
        "HAZ-002",
        "HAZ-010",
        "HAZ-011",
    ]
    assert (first["risk_score"], first["risk_level"]) == (12, "high")
    assert (second["severity"], second["likelihood"], second["status"]) == (1, 1, "open")
    assert second["category"] == "other"
    assert first["links"] == []

    updated = client.put(
        f"/hazards/{first['id']}",
        json={"status": "mitigated", "likelihood": 1, "mitigation": "Thermal relief PSV-12"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["risk_score"] == 3
    assert updated.json()["risk_level"] == "low"
    assert updated.json()["mitigation"] == "Thermal relief PSV-12"
    assert updated.json()["title"] == "Trapped LN2"

    listed = client.get(f"/projects/{project_id}/hazards").json()
    assert [hazard["key"] for hazard in listed] == ["HAZ-001", "HAZ-002", "HAZ-010", "HAZ-011"]
    assert listed[0]["status"] == "mitigated"

    assert client.delete(f"/hazards/{second['id']}").status_code == 204
    assert len(client.get(f"/projects/{project_id}/hazards").json()) == 3
    changes = client.get("/changes").json()
    assert {"created", "updated", "deleted"} <= {
        change["action"] for change in changes if change["object_type"] == "hazard"
    }


def test_hazard_validation(client: TestClient) -> None:
    project_id = _project(client)
    other_project = _project(client, "Other")
    hazard = _hazard(client, project_id)

    duplicate = client.post(
        f"/projects/{project_id}/hazards", json={"key": "HAZ-001", "title": "Again"}
    )
    same_key_elsewhere = client.post(
        f"/projects/{other_project}/hazards", json={"key": "HAZ-001", "title": "Elsewhere"}
    )
    second = _hazard(client, project_id)
    rename_clash = client.put(f"/hazards/{second['id']}", json={"key": "HAZ-001"})

    assert duplicate.status_code == 409
    assert same_key_elsewhere.status_code == 201
    assert rename_clash.status_code == 409
    for body in (
        {"title": " "},
        {"title": "x", "category": "meteor"},
        {"title": "x", "severity": 5},
        {"title": "x", "likelihood": 0},
        {"title": "x", "status": "ignored"},
    ):
        assert client.post(f"/projects/{project_id}/hazards", json=body).status_code == 422
    assert client.put(f"/hazards/{hazard['id']}", json={"severity": 9}).status_code == 422
    assert client.post("/projects/missing/hazards", json={"title": "x"}).status_code == 404
    assert client.get("/projects/missing/hazards").status_code == 404
    assert client.put("/hazards/missing", json={"title": "x"}).status_code == 404
    assert client.delete("/hazards/missing").status_code == 404


def test_hazard_links_to_drawing_items_and_requirements(client: TestClient) -> None:
    project_id = _project(client)
    other_project = _project(client, "Other")
    hazard = _hazard(client, project_id)
    item_id = _sheet_item(client, project_id)
    foreign_item_id = _sheet_item(client, other_project)
    requirement = client.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": "REQ-1",
            "title": "Relief",
            "text": "Every isolable volume has a relief device.",
            "requirement_type": "safety",
        },
    ).json()

    assert _link(client, hazard["id"], "sheet_item", item_id).status_code == 201
    assert _link(client, hazard["id"], "requirement", requirement["id"]).status_code == 201
    assert _link(client, hazard["id"], "sheet_item", item_id).status_code == 409
    assert _link(client, hazard["id"], "sheet_item", foreign_item_id).status_code == 400
    assert _link(client, "missing", "sheet_item", item_id).status_code == 404

    listed = client.get(f"/projects/{project_id}/hazards").json()
    assert {(link["target_type"], link["target_id"]) for link in listed[0]["links"]} == {
        ("sheet_item", item_id),
        ("requirement", requirement["id"]),
    }
    assert len(client.get(f"/objects/sheet_item/{item_id}/trace").json()) == 1

    assert client.delete(f"/hazards/{hazard['id']}").status_code == 204
    assert client.get(f"/objects/sheet_item/{item_id}/trace").json() == []
    assert client.get(f"/objects/requirement/{requirement['id']}/trace").json() == []


def test_deleting_a_project_removes_its_hazards_and_their_links(client: TestClient) -> None:
    project_id = _project(client)
    hazard = _hazard(client, project_id)
    item_id = _sheet_item(client, project_id)
    assert _link(client, hazard["id"], "sheet_item", item_id).status_code == 201

    assert client.delete(f"/projects/{project_id}").status_code == 204

    assert client.get(f"/objects/hazard/{hazard['id']}/trace").json() == []
    assert client.put(f"/hazards/{hazard['id']}", json={"title": "x"}).status_code == 404


def test_viewers_read_but_do_not_change_hazards_or_analyses(client: TestClient) -> None:
    project_id = _project(client)
    hazard = _hazard(client, project_id)
    stored = client.post(f"/projects/{project_id}/analyses", json=_pressure_drop_body()).json()
    viewer = _viewer(client)

    assert viewer.get(f"/projects/{project_id}/hazards").status_code == 200
    assert viewer.get(f"/projects/{project_id}/analyses").status_code == 200
    assert viewer.get(f"/analyses/{stored['id']}").status_code == 200
    # Preview stores nothing, so read-only accounts may use the calculators.
    preview = viewer.post("/analysis/preview", json=_pressure_drop_body())
    assert preview.status_code == 200
    assert viewer.post(f"/projects/{project_id}/hazards", json={"title": "x"}).status_code == 403
    assert viewer.put(f"/hazards/{hazard['id']}", json={"title": "x"}).status_code == 403
    assert viewer.delete(f"/hazards/{hazard['id']}").status_code == 403
    assert (
        viewer.post(f"/projects/{project_id}/analyses", json=_pressure_drop_body()).status_code
        == 403
    )
    assert viewer.put(f"/analyses/{stored['id']}", json={"name": "x"}).status_code == 403
    assert viewer.delete(f"/analyses/{stored['id']}").status_code == 403


# ---- analyses ----


def _pressure_drop_body(**overrides) -> dict:
    return {
        "kind": "pressure_drop",
        "name": "Fill line",
        "inputs": {
            "density_kg_m3": 998.2,
            "viscosity_mpa_s": 1.002,
            "volumetric_flow_l_min": 60,
            "segments": [
                {"name": "L1", "inner_diameter_mm": 25, "length_m": 10, "roughness_mm": 0.045}
            ],
        },
        **overrides,
    }


GAS_RELIEF_INPUTS = {
    "service": "gas",
    "set_pressure_kpag": 517,
    "mass_rate_kg_h": 24270,
    "relieving_temperature_c": 74.85,
    "molar_mass_kg_kmol": 51,
    "k": 1.11,
    "z": 0.9,
}


def test_preview_computes_without_storing(client: TestClient) -> None:
    project_id = _project(client)

    preview = client.post("/analysis/preview", json=_pressure_drop_body())

    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["results"]["totals"]["dp_total_kpa"] == pytest.approx(21.753, rel=1e-4)
    # Defaults are filled in so the stored inputs are complete.
    assert body["inputs"]["velocity_limit_m_s"] == 3.0
    assert body["inputs"]["segments"][0]["k_sum"] == 0
    assert client.get(f"/projects/{project_id}/analyses").json() == []

    relief = client.post(
        "/analysis/preview", json={"kind": "relief_sizing", "inputs": GAS_RELIEF_INPUTS}
    )
    assert relief.status_code == 200, relief.text
    assert relief.json()["results"]["orifice"]["letter"] == "P"
    assert relief.json()["inputs"]["overpressure_pct"] == 10


def test_analysis_is_stored_with_inputs_and_recomputed_on_update(client: TestClient) -> None:
    project_id = _project(client)
    drawing = client.post(f"/projects/{project_id}/drawings", json={"title": "P&ID"}).json()

    created = client.post(
        f"/projects/{project_id}/analyses", json=_pressure_drop_body(drawing_id=drawing["id"])
    )

    assert created.status_code == 201, created.text
    stored = created.json()
    assert stored["kind"] == "pressure_drop"
    assert stored["status"] == "draft"
    assert stored["drawing_id"] == drawing["id"]
    assert stored["created_by"] == "engineer@fsdp.test"
    assert stored["inputs"]["segments"][0]["roughness_mm"] == 0.045
    assert stored["results"]["totals"]["dp_total_kpa"] == pytest.approx(21.753, rel=1e-4)
    assert stored["results"]["calc_version"] == 1
    assert client.get(f"/analyses/{stored['id']}").json() == stored

    doubled = {**stored["inputs"], "volumetric_flow_l_min": 120}
    updated = client.put(
        f"/analyses/{stored['id']}", json={"inputs": doubled, "status": "checked"}
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["status"] == "checked"
    assert updated.json()["name"] == "Fill line"
    velocity = updated.json()["results"]["segments"][0]["velocity_m_s"]
    assert velocity == pytest.approx(4.0744, rel=1e-4)
    assert updated.json()["results"]["warnings"]

    renamed = client.put(f"/analyses/{stored['id']}", json={"name": "Fill line, max flow"})
    assert renamed.json()["name"] == "Fill line, max flow"
    assert renamed.json()["inputs"] == updated.json()["inputs"]
    assert renamed.json()["results"] == updated.json()["results"]

    relief = client.post(
        f"/projects/{project_id}/analyses",
        json={"kind": "relief_sizing", "name": "PSV-3203", "inputs": GAS_RELIEF_INPUTS},
    ).json()
    listed = client.get(f"/projects/{project_id}/analyses").json()
    assert {entry["id"] for entry in listed} == {stored["id"], relief["id"]}

    # Deleting the drawing keeps the analysis and clears the reference.
    assert client.delete(f"/drawings/{drawing['id']}").status_code == 204
    assert client.get(f"/analyses/{stored['id']}").json()["drawing_id"] is None

    assert client.delete(f"/analyses/{stored['id']}").status_code == 204
    assert client.get(f"/analyses/{stored['id']}").status_code == 404
    assert client.delete(f"/projects/{project_id}").status_code == 204
    assert client.get(f"/analyses/{relief['id']}").status_code == 404


def test_analysis_input_errors_are_readable(client: TestClient) -> None:
    project_id = _project(client)
    other_project = _project(client, "Other")
    foreign_drawing = client.post(
        f"/projects/{other_project}/drawings", json={"title": "P&ID"}
    ).json()

    def preview(inputs: dict, kind: str = "pressure_drop"):
        return client.post("/analysis/preview", json={"kind": kind, "inputs": inputs})

    good = _pressure_drop_body()["inputs"]
    bad_diameter = preview({**good, "segments": [{"inner_diameter_mm": 0}]})
    both_flows = preview({**good, "mass_flow_kg_s": 1})
    no_segments = preview({**good, "segments": []})
    unknown_field = preview({**good, "flow": 3})
    missing_gas_fields = preview({"service": "gas", "set_pressure_kpag": 100}, "relief_sizing")
    back_pressure = preview(
        {
            "service": "liquid",
            "set_pressure_kpag": 100,
            "back_pressure_kpag": 500,
            "volume_rate_l_min": 10,
            "density_kg_m3": 999,
        },
        "relief_sizing",
    )

    assert bad_diameter.status_code == 422
    assert "segments.0.inner_diameter_mm" in bad_diameter.json()["detail"]
    assert both_flows.status_code == 422
    assert "not both" in both_flows.json()["detail"]
    assert no_segments.status_code == 422
    assert unknown_field.status_code == 422
    assert missing_gas_fields.status_code == 422
    assert "mass_rate_kg_h" in missing_gas_fields.json()["detail"]
    assert back_pressure.status_code == 422
    assert back_pressure.json()["detail"] == "Back pressure must be below the relieving pressure."
    assert client.post("/analysis/preview", json={"kind": "cfd", "inputs": {}}).status_code == 422

    assert (
        client.post(
            f"/projects/{project_id}/analyses", json=_pressure_drop_body(name=" ")
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/projects/{project_id}/analyses",
            json=_pressure_drop_body(drawing_id=foreign_drawing["id"]),
        ).status_code
        == 400
    )
    assert client.post("/projects/missing/analyses", json=_pressure_drop_body()).status_code == 404
    assert client.get(f"/projects/{project_id}/analyses").json() == []
