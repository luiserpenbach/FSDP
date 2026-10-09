from fastapi.testclient import TestClient


def test_duplicate_validation_and_core_delete_flow(client: TestClient) -> None:
    project = client.post("/projects", json={"name": "Demo"}).json()
    duplicate_project = client.post("/projects", json={"name": "Demo"})
    duplicate_project_with_spacing = client.post("/projects", json={"name": " demo "})
    blank_project_update = client.put(f"/projects/{project['id']}", json={"name": "   "})

    part = client.post(
        "/parts",
        json={
            "part_number": "VALVE-200",
            "description": "Solenoid valve",
            "part_type": "valve",
        },
    ).json()
    duplicate_part = client.post(
        "/parts",
        json={
            "part_number": "VALVE-200",
            "description": "Another valve",
            "part_type": "valve",
        },
    )
    updated_part = client.put(
        f"/parts/{part['id']}",
        json={"description": "Updated solenoid valve"},
    ).json()
    delete_part = client.delete(f"/parts/{part['id']}")
    delete_project = client.delete(f"/projects/{project['id']}")

    assert duplicate_project.status_code == 409
    assert duplicate_project_with_spacing.status_code == 409
    assert blank_project_update.status_code == 422
    assert duplicate_part.status_code == 409
    assert updated_part["description"] == "Updated solenoid valve"
    assert delete_part.status_code == 204
    assert delete_project.status_code == 204


def test_system_names_are_unique_within_project(client: TestClient) -> None:
    project = client.post("/projects", json={"name": "Vehicle A"}).json()
    other_project = client.post("/projects", json={"name": "Vehicle B"}).json()

    system = client.post(
        f"/projects/{project['id']}/systems",
        json={"name": "Helium Pressurization", "fluid": "GHe"},
    ).json()
    duplicate_same_project = client.post(
        f"/projects/{project['id']}/systems",
        json={"name": " helium pressurization ", "fluid": "GHe"},
    )
    same_name_other_project = client.post(
        f"/projects/{other_project['id']}/systems",
        json={"name": "Helium Pressurization", "fluid": "GHe"},
    )
    blank_system_update = client.put(f"/systems/{system['id']}", json={"name": "   "})

    assert duplicate_same_project.status_code == 409
    assert same_name_other_project.status_code == 201
    assert blank_system_update.status_code == 422
