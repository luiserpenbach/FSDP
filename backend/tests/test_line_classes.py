"""Project line classes: CRUD and CSV import."""

from fastapi.testclient import TestClient


def test_line_class_crud(client: TestClient) -> None:
    project_id = client.post("/projects", json={"name": "AMB2"}).json()["id"]
    created = client.post(
        f"/projects/{project_id}/line-classes",
        json={
            "name": "A1A",
            "material": "316L SS tube",
            "rating": "3000 psig",
            "wall": '0.035"',
            "sizes": ['1/8"', '1/4"', '1/4"', '1/2"'],
            "insulation": "foam",
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["sizes"] == ['1/8"', '1/4"', '1/2"']

    duplicate = client.post(f"/projects/{project_id}/line-classes", json={"name": "A1A"})
    assert duplicate.status_code == 409

    updated = client.put(f"/line-classes/{created.json()['id']}", json={"rating": "6000 psig"})
    assert updated.status_code == 200, updated.text
    assert updated.json()["rating"] == "6000 psig"
    assert updated.json()["material"] == "316L SS tube"

    listed = client.get(f"/projects/{project_id}/line-classes").json()
    assert [entry["name"] for entry in listed] == ["A1A"]

    deleted = client.delete(f"/line-classes/{created.json()['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/projects/{project_id}/line-classes").json() == []


def test_line_class_csv_import(client: TestClient) -> None:
    project_id = client.post("/projects", json={"name": "AMB2"}).json()["id"]
    client.post(f"/projects/{project_id}/line-classes", json={"name": "A1A", "rating": "old"})
    csv_text = (
        "name,material,rating,wall,sizes,insulation\n"
        'A1A,316L SS tube,3000 psig,0.035",1/4";1/2",foam\n'
        'GH,Garden hose,150 psig,,3/8" NPT,\n'
        ",missing,,,,\n"
    )
    imported = client.post(f"/projects/{project_id}/line-classes/import", json={"csv": csv_text})
    assert imported.status_code == 200, imported.text
    assert imported.json() == {"created": 1, "updated": 1, "errors": ["row 4: missing name"]}
    listed = {
        entry["name"]: entry for entry in client.get(f"/projects/{project_id}/line-classes").json()
    }
    assert listed["A1A"]["rating"] == "3000 psig"
    assert listed["A1A"]["sizes"] == ['1/4"', '1/2"']
    assert listed["GH"]["sizes"] == ['3/8" NPT']

    replaced = client.post(
        f"/projects/{project_id}/line-classes/import",
        json={"csv": "name,material\nNEW,copper\n", "replace": True},
    )
    assert replaced.status_code == 200
    assert [
        entry["name"] for entry in client.get(f"/projects/{project_id}/line-classes").json()
    ] == ["NEW"]

    bad = client.post(f"/projects/{project_id}/line-classes/import", json={"csv": "foo,bar\n1,2\n"})
    assert bad.status_code == 422
