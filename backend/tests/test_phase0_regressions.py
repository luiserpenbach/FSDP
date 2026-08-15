"""Regression tests for the Phase 0 data-integrity fixes (see docs/gap-analysis.md)."""

from fastapi.testclient import TestClient


def make_diagram(client: TestClient, name: str = "P&ID") -> tuple[dict, dict, dict]:
    project = client.post("/projects", json={"name": f"Project {name}"}).json()
    system = client.post(
        f"/projects/{project['id']}/systems", json={"name": f"System {name}"}
    ).json()
    diagram = client.post(f"/systems/{system['id']}/diagrams", json={"name": name}).json()
    return project, system, diagram


def graph_payload(*external_ids: str) -> dict:
    return {
        "graph": {"nodes": [{"id": eid} for eid in external_ids], "edges": []},
        "nodes": [
            {
                "external_id": eid,
                "node_type": "valve",
                "label": eid,
                "position": {"x": 0, "y": 0},
                "properties": {},
            }
            for eid in external_ids
        ],
        "edges": [],
    }


def make_part(client: TestClient, part_number: str) -> dict:
    return client.post(
        "/parts",
        json={"part_number": part_number, "description": "Test part", "part_type": "valve"},
    ).json()


# --- B1: graph saves must preserve component->node bindings ---


def test_graph_resave_preserves_component_binding(client: TestClient) -> None:
    _, _, diagram = make_diagram(client)
    client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload("valve-1"))
    part = make_part(client, "B1-VALVE")
    component = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-1", "part_id": part["id"], "properties": {"node_external_id": "valve-1"}},
    ).json()
    assert component["node_id"] is not None

    client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload("valve-1"))
    components = client.get(f"/diagrams/{diagram['id']}/components").json()

    assert components[0]["node_id"] == component["node_id"]


def test_graph_save_unbinds_only_removed_nodes(client: TestClient) -> None:
    _, _, diagram = make_diagram(client)
    client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload("valve-1", "valve-2"))
    part = make_part(client, "B1-REG")
    kept = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-1", "part_id": part["id"], "properties": {"node_external_id": "valve-1"}},
    ).json()
    removed = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-2", "part_id": part["id"], "properties": {"node_external_id": "valve-2"}},
    ).json()

    client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload("valve-1"))
    components = {c["tag"]: c for c in client.get(f"/diagrams/{diagram['id']}/components").json()}

    assert components["V-1"]["node_id"] == kept["node_id"]
    assert removed["node_id"] is not None
    assert components["V-2"]["node_id"] is None


def test_graph_save_rebinds_orphaned_components(client: TestClient) -> None:
    _, _, diagram = make_diagram(client)
    client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload("valve-1"))
    part = make_part(client, "B1-HEAL")
    component = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-1", "part_id": part["id"], "properties": {"node_external_id": "valve-1"}},
    ).json()
    # Simulate a binding severed by the old delete-and-recreate save behavior.
    client.put(f"/components/{component['id']}", json={"node_id": None})

    client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload("valve-1"))
    components = client.get(f"/diagrams/{diagram['id']}/components").json()

    assert components[0]["node_id"] is not None


# --- B2: duplicate external ids must be a client error, not a 500 ---


def test_duplicate_node_external_ids_rejected(client: TestClient) -> None:
    _, _, diagram = make_diagram(client)
    payload = graph_payload("valve-1")
    payload["nodes"].append(payload["nodes"][0].copy())

    response = client.put(f"/diagrams/{diagram['id']}/graph", json=payload)

    assert response.status_code == 422


# --- B3: parts placed on diagrams must not be deletable ---


def test_delete_placed_part_blocked_until_components_removed(client: TestClient) -> None:
    _, _, diagram = make_diagram(client)
    part = make_part(client, "B3-PART")
    component = client.post(
        f"/diagrams/{diagram['id']}/components", json={"tag": "R-1", "part_id": part["id"]}
    ).json()

    blocked = client.delete(f"/parts/{part['id']}")
    client.delete(f"/components/{component['id']}")
    allowed = client.delete(f"/parts/{part['id']}")

    assert blocked.status_code == 409
    assert allowed.status_code == 204


# --- B4/B10/B11: blank identifier validation ---


def test_blank_identifiers_rejected(client: TestClient) -> None:
    project, system, diagram = make_diagram(client)

    blank_part = client.post(
        "/parts", json={"part_number": "  ", "description": "x", "part_type": "valve"}
    )
    blank_diagram = client.post(f"/systems/{system['id']}/diagrams", json={"name": "   "})
    blank_requirement = client.post(
        "/requirements",
        json={
            "project_id": project["id"],
            "key": "",
            "title": "t",
            "text": "x",
            "requirement_type": "safety",
        },
    )
    blank_tag = client.post(f"/diagrams/{diagram['id']}/components", json={"tag": "   "})

    assert blank_part.status_code == 422
    assert blank_diagram.status_code == 422
    assert blank_requirement.status_code == 422
    assert blank_tag.status_code == 422


def test_duplicate_diagram_names_rejected_within_system(client: TestClient) -> None:
    _, system, _ = make_diagram(client, name="Main P&ID")

    duplicate = client.post(f"/systems/{system['id']}/diagrams", json={"name": " main p&id "})

    assert duplicate.status_code == 409


# --- B5: component tags unique per diagram ---


def test_duplicate_component_tags_rejected_per_diagram(client: TestClient) -> None:
    _, _, diagram = make_diagram(client)
    _, _, other_diagram = make_diagram(client, name="Other")
    part = make_part(client, "B5-PART")

    first = client.post(
        f"/diagrams/{diagram['id']}/components", json={"tag": "V-1", "part_id": part["id"]}
    )
    duplicate = client.post(
        f"/diagrams/{diagram['id']}/components", json={"tag": "V-1", "part_id": part["id"]}
    )
    other = client.post(
        f"/diagrams/{other_diagram['id']}/components", json={"tag": "V-1", "part_id": part["id"]}
    )

    assert first.status_code == 201
    assert duplicate.status_code == 409
    assert other.status_code == 201


# --- B12: at most one component may bind to a given diagram node ---


def test_duplicate_component_node_binding_rejected(client: TestClient) -> None:
    _, _, diagram = make_diagram(client)
    client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload("valve-1"))
    part = make_part(client, "B12-PART")

    first = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-1", "part_id": part["id"], "properties": {"node_external_id": "valve-1"}},
    )
    duplicate = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-2", "part_id": part["id"], "properties": {"node_external_id": "valve-1"}},
    )

    assert first.status_code == 201
    assert first.json()["node_id"] is not None
    assert duplicate.status_code == 409
    assert "already has a component" in duplicate.json()["detail"]

    bom = client.post(f"/diagrams/{diagram['id']}/bom").json()
    assert bom["rows"][0]["quantity"] == 1
    assert bom["rows"][0]["component_tags"] == ["V-1"]


def test_update_cannot_steal_another_components_node(client: TestClient) -> None:
    _, _, diagram = make_diagram(client)
    client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload("valve-1", "valve-2"))
    part = make_part(client, "B12-STEAL")
    first = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-1", "part_id": part["id"], "properties": {"node_external_id": "valve-1"}},
    ).json()
    second = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-2", "part_id": part["id"], "properties": {"node_external_id": "valve-2"}},
    ).json()

    stolen = client.put(f"/components/{second['id']}", json={"node_id": first["node_id"]})
    same = client.put(f"/components/{first['id']}", json={"node_id": first["node_id"]})

    assert stolen.status_code == 409
    assert same.status_code == 200


def test_graph_rebind_does_not_double_bind_shared_node_external_id(client: TestClient) -> None:
    _, _, diagram = make_diagram(client)
    client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload("valve-1"))
    part = make_part(client, "B12-REBIND")
    first = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-1", "part_id": part["id"], "properties": {"node_external_id": "valve-1"}},
    ).json()
    # Second component claims the same node via properties but stays unbound
    # (create would now 409; seed an unbound duplicate the way old data can look).
    unbound = client.post(
        f"/diagrams/{diagram['id']}/components",
        json={"tag": "V-2", "part_id": part["id"]},
    ).json()
    client.put(
        f"/components/{unbound['id']}",
        json={"properties": {"node_external_id": "valve-1"}, "node_id": None},
    )

    client.put(f"/diagrams/{diagram['id']}/graph", json=graph_payload("valve-1"))
    components = {c["tag"]: c for c in client.get(f"/diagrams/{diagram['id']}/components").json()}

    assert components["V-1"]["node_id"] == first["node_id"]
    assert components["V-2"]["node_id"] is None


# --- B6: trace links must reference real objects and not duplicate ---


def test_trace_link_validation(client: TestClient) -> None:
    project, _, diagram = make_diagram(client)
    requirement = client.post(
        "/requirements",
        json={
            "project_id": project["id"],
            "key": "REQ-1",
            "title": "t",
            "text": "x",
            "requirement_type": "safety",
        },
    ).json()
    component = client.post(f"/diagrams/{diagram['id']}/components", json={"tag": "V-9"}).json()
    link = {
        "source_type": "requirement",
        "source_id": requirement["id"],
        "target_type": "component",
        "target_id": component["id"],
        "link_type": "satisfied_by",
    }

    missing_target = client.post("/trace-links", json={**link, "target_id": "nonexistent"})
    unknown_type = client.post("/trace-links", json={**link, "source_type": "starship"})
    created = client.post("/trace-links", json=link)
    duplicate = client.post("/trace-links", json=link)

    assert missing_target.status_code == 404
    assert unknown_type.status_code == 422
    assert created.status_code == 201
    assert duplicate.status_code == 409


# --- B7: quantities must be positive ---


def test_non_positive_component_quantity_rejected(client: TestClient) -> None:
    _, _, diagram = make_diagram(client)

    zero = client.post(f"/diagrams/{diagram['id']}/components", json={"tag": "Q-0", "quantity": 0})
    negative = client.post(
        f"/diagrams/{diagram['id']}/components", json={"tag": "Q-1", "quantity": -5}
    )

    assert zero.status_code == 422
    assert negative.status_code == 422


# --- B9: CSV export carries a filename and engineering columns ---


def test_bom_csv_has_filename_and_engineering_columns(client: TestClient) -> None:
    _, _, diagram = make_diagram(client, name="Feed System")
    part = client.post(
        "/parts",
        json={
            "part_number": "B9-PART",
            "description": "Valve",
            "part_type": "valve",
            "material": "316L",
            "pressure_rating_bar": 350,
            "mass_kg": 1.2,
        },
    ).json()
    client.post(f"/diagrams/{diagram['id']}/components", json={"tag": "V-1", "part_id": part["id"]})
    snapshot = client.post(f"/diagrams/{diagram['id']}/bom").json()

    response = client.get(f"/bom/{snapshot['id']}/csv")
    header = response.text.splitlines()[0]

    assert "attachment; filename=" in response.headers["content-disposition"]
    assert "feed-system" in response.headers["content-disposition"]
    assert "material" in header
    assert "pressure_rating_bar" in header
    assert "mass_kg" in header
    assert "component_tags" in header
    assert "316L" in response.text
