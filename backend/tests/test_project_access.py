"""Per-project access: restricted projects, members, and what leaks across them."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.main import app
from tests.conftest import TEST_USER_EMAIL
from tests.legacy import add_legacy_diagram

PASSWORD = "member-password"


def _user(admin: TestClient, email: str, role: str = "engineer") -> tuple[TestClient, str]:
    created = admin.post(
        "/auth/users",
        json={"email": email, "name": email.split("@")[0], "password": PASSWORD, "role": role},
    )
    assert created.status_code == 201, created.text
    client = TestClient(app)
    assert (
        client.post("/auth/login", json={"email": email, "password": PASSWORD}).status_code == 200
    )
    return client, created.json()["id"]


def _document(tag: str) -> dict:
    return {
        "schemaVersion": 1,
        "sheet": {"size": "A3", "orientation": "landscape"},
        "layers": [],
        "items": [{"id": "sym-1", "kind": "symbol", "tag": tag}],
        "meta": {"grid": 2.5},
    }


def _secret_project(admin: TestClient, tag: str = "HV-7777") -> dict:
    """A restricted project with a drawing, an indexed tag, a requirement, and a part in use."""
    project = admin.post("/projects", json={"name": "Classified"}).json()
    part = admin.post(
        "/parts",
        json={"part_number": "VLV-7", "description": "Shared valve", "part_type": "valve"},
    ).json()
    drawing = admin.post(
        f"/projects/{project['id']}/drawings", json={"title": "Secret feed"}
    ).json()
    sheet_id = drawing["sheets"][0]["id"]
    index = {
        "items": [{"item_id": "sym-1", "kind": "symbol", "tag": tag, "part_id": part["id"]}],
        "lines": [],
    }
    saved = admin.put(
        f"/sheets/{sheet_id}",
        json={"document": _document(tag), "index": index, "drc": {"findings": []}},
    )
    assert saved.status_code == 200, saved.text
    requirement = admin.post(
        "/requirements",
        json={
            "project_id": project["id"],
            "key": "SEC-1",
            "title": "Secret requirement",
            "text": "Hidden.",
            "requirement_type": "functional",
        },
    ).json()
    restricted = admin.put(f"/projects/{project['id']}/access", json={"restricted": True})
    assert restricted.status_code == 200, restricted.text
    return {
        "project": project,
        "drawing": drawing,
        "sheet_id": sheet_id,
        "part": part,
        "requirement": requirement,
    }


def test_projects_are_open_until_restricted(client: TestClient) -> None:
    engineer, _ = _user(client, "eng@fsdp.test")
    project = client.post("/projects", json={"name": "Open"}).json()
    assert project["restricted"] is False
    assert [p["id"] for p in engineer.get("/projects").json()] == [project["id"]]
    assert (
        engineer.post(f"/projects/{project['id']}/systems", json={"name": "LOX"}).status_code == 201
    )


def test_restricted_project_is_invisible_to_non_members(client: TestClient) -> None:
    secret = _secret_project(client)
    outsider, _ = _user(client, "outsider@fsdp.test")
    project_id = secret["project"]["id"]
    drawing_id = secret["drawing"]["id"]

    assert outsider.get("/projects").json() == []
    for path in (
        f"/projects/{project_id}",
        f"/projects/{project_id}/drawings",
        f"/projects/{project_id}/requirements",
        f"/projects/{project_id}/access",
        f"/drawings/{drawing_id}",
        f"/drawings/{drawing_id}/lists/valves",
        f"/sheets/{secret['sheet_id']}",
        f"/sheets/{secret['sheet_id']}/index",
        f"/objects/requirement/{secret['requirement']['id']}/trace",
        f"/revisions/{secret['drawing']['revisions'][0]['id']}/snapshot",
    ):
        assert outsider.get(path).status_code == 404, path
    assert outsider.delete(f"/drawings/{drawing_id}").status_code == 404
    assert outsider.put(f"/sheets/{secret['sheet_id']}", json={"title": "x"}).status_code == 404
    assert outsider.post(f"/drawings/{drawing_id}/copy").status_code == 404
    assert (
        outsider.put(
            f"/requirements/{secret['requirement']['id']}", json={"title": "x"}
        ).status_code
        == 404
    )
    created = outsider.post(
        "/requirements",
        json={
            "project_id": project_id,
            "key": "X-1",
            "title": "x",
            "text": "x",
            "requirement_type": "functional",
        },
    )
    assert created.status_code == 404
    # The admin still sees everything.
    assert client.get(f"/drawings/{drawing_id}").status_code == 200


def test_restricted_project_does_not_leak_through_cross_project_views(
    client: TestClient,
) -> None:
    secret = _secret_project(client)
    outsider, _ = _user(client, "outsider@fsdp.test")

    for query in ("HV-7777", "Classified", "Secret", "SEC-1"):
        assert outsider.get("/search", params={"q": query}).json()["hits"] == [], query
    assert client.get("/search", params={"q": "HV-7777"}).json()["hits"]

    usage = outsider.get(f"/parts/{secret['part']['id']}/usage").json()
    assert usage["drawing_items"] == []
    assert client.get(f"/parts/{secret['part']['id']}/usage").json()["drawing_items"]

    impact = outsider.get(
        "/changes/impact", params={"object_type": "part", "object_id": secret["part"]["id"]}
    ).json()
    assert impact["affected_drawings"] == []
    assert impact["affected_sheet_items"] == []
    assert (
        outsider.get(
            "/changes/impact",
            params={"object_type": "requirement", "object_id": secret["requirement"]["id"]},
        ).status_code
        == 404
    )

    summaries = " ".join(event["summary"] for event in outsider.get("/changes").json())
    assert "Classified" not in summaries and "SEC-1" not in summaries
    assert "VLV-7" in summaries  # catalog changes stay visible
    assert "Classified" in " ".join(event["summary"] for event in client.get("/changes").json())


def test_member_roles_decide_read_and_write(client: TestClient) -> None:
    secret = _secret_project(client)
    project_id = secret["project"]["id"]
    reader, reader_id = _user(client, "reader@fsdp.test")
    writer, writer_id = _user(client, "writer@fsdp.test")
    watcher, watcher_id = _user(client, "watcher@fsdp.test", role="viewer")

    for user_id, role in ((reader_id, "viewer"), (writer_id, "engineer"), (watcher_id, "engineer")):
        added = client.put(f"/projects/{project_id}/members/{user_id}", json={"role": role})
        assert added.status_code == 200, added.text

    for member in (reader, writer, watcher):
        assert [p["id"] for p in member.get("/projects").json()] == [project_id]
        assert member.get(f"/drawings/{secret['drawing']['id']}").status_code == 200
        assert member.get("/search", params={"q": "HV-7777"}).json()["hits"]

    body = {"name": "LOX"}
    denied = reader.post(f"/projects/{project_id}/systems", json=body)
    assert denied.status_code == 403
    assert "read-only" in denied.json()["detail"]
    # A viewer account stays read-only even as an engineer member.
    assert watcher.post(f"/projects/{project_id}/systems", json=body).status_code == 403
    assert writer.post(f"/projects/{project_id}/systems", json=body).status_code == 201
    assert reader.get(f"/projects/{project_id}/access").json()["can_write"] is False
    assert writer.get(f"/projects/{project_id}/access").json()["can_write"] is True

    # Members cannot manage access unless they are owners.
    assert (
        writer.put(f"/projects/{project_id}/access", json={"restricted": False}).status_code == 403
    )
    assert (
        writer.put(
            f"/projects/{project_id}/members/{reader_id}", json={"role": "owner"}
        ).status_code
        == 403
    )
    client.put(f"/projects/{project_id}/members/{writer_id}", json={"role": "owner"})
    assert (
        writer.put(
            f"/projects/{project_id}/members/{reader_id}", json={"role": "engineer"}
        ).status_code
        == 200
    )
    assert reader.post(f"/projects/{project_id}/systems", json={"name": "CH4"}).status_code == 201

    # Removing a member shuts them out again.
    assert writer.delete(f"/projects/{project_id}/members/{reader_id}").status_code == 204
    assert reader.get(f"/projects/{project_id}").status_code == 404


def test_creator_owns_the_project_and_can_restrict_it(client: TestClient) -> None:
    lead, lead_id = _user(client, "lead@fsdp.test")
    other, _ = _user(client, "other@fsdp.test")
    project = lead.post("/projects", json={"name": "Lead's project"}).json()

    access = lead.get(f"/projects/{project['id']}/access").json()
    assert access["can_manage"] is True
    assert [(m["user_id"], m["role"]) for m in access["members"]] == [(lead_id, "owner")]
    assert other.get(f"/projects/{project['id']}/access").json()["can_manage"] is False
    assert (
        other.put(f"/projects/{project['id']}/access", json={"restricted": True}).status_code == 403
    )

    assert (
        lead.put(f"/projects/{project['id']}/access", json={"restricted": True}).status_code == 200
    )
    assert other.get(f"/projects/{project['id']}").status_code == 404
    # The last owner of a members-only project cannot be removed or demoted.
    assert lead.delete(f"/projects/{project['id']}/members/{lead_id}").status_code == 400
    assert (
        lead.put(
            f"/projects/{project['id']}/members/{lead_id}", json={"role": "viewer"}
        ).status_code
        == 400
    )
    assert "members only" in " ".join(e["summary"] for e in lead.get("/changes").json())


def test_copy_needs_write_access_to_the_destination_only(client: TestClient) -> None:
    secret = _secret_project(client)
    member, member_id = _user(client, "member@fsdp.test")
    client.put(f"/projects/{secret['project']['id']}/members/{member_id}", json={"role": "viewer"})
    own = member.post("/projects", json={"name": "Mine"}).json()

    # A read-only member may take a copy into a project they can write.
    copied = member.post(
        f"/drawings/{secret['drawing']['id']}/copy", json={"project_id": own["id"]}
    )
    assert copied.status_code == 201, copied.text
    # ...but not create one inside the project they only read.
    assert member.post(f"/drawings/{secret['drawing']['id']}/copy").status_code == 403
    # Nor into a project they cannot see.
    other = client.post("/projects", json={"name": "Other secret"}).json()
    client.put(f"/projects/{other['id']}/access", json={"restricted": True})
    blocked = member.post(f"/drawings/{copied.json()['id']}/copy", json={"project_id": other["id"]})
    assert blocked.status_code == 404


def test_convert_diagram_respects_project_access(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Convert-from-diagram is reuse: it must not read a restricted project's schematic.

    Path-level access only covers the destination drawing/project. Without a check on
    body `source_diagram_id`, an outsider could POST that id into their own project and
    receive the classified document — while `POST /drawings/{id}/copy` correctly 404s.
    """
    secret = client.post("/projects", json={"name": "Classified diagrams"}).json()
    system = client.post(f"/projects/{secret['id']}/systems", json={"name": "Secret LOX"}).json()
    schematic = {
        "schemaVersion": 1,
        "sheet": {"size": "A3", "orientation": "landscape"},
        "layers": [],
        "items": [{"id": "sym-1", "kind": "symbol", "tag": "HV-SECRET"}],
        "meta": {"grid": 2.5},
    }
    diagram = add_legacy_diagram(
        session_factory, system["id"], name="Secret P&ID", schematic=schematic
    )
    assert client.put(f"/projects/{secret['id']}/access", json={"restricted": True}).status_code == 200

    outsider, _ = _user(client, "converter@fsdp.test")
    assert outsider.get(f"/diagrams/{diagram.id}").status_code == 404
    own = outsider.post("/projects", json={"name": "Mine"}).json()

    stolen = outsider.post(
        f"/projects/{own['id']}/drawings",
        json={"title": "Stolen", "first_sheet": {"source_diagram_id": diagram.id}},
    )
    assert stolen.status_code == 404, stolen.text

    empty = outsider.post(f"/projects/{own['id']}/drawings", json={"title": "Empty"}).json()
    added = outsider.post(
        f"/drawings/{empty['id']}/sheets",
        json={"title": "From secret", "source_diagram_id": diagram.id},
    )
    assert added.status_code == 404, added.text

    # Same-project convert still works for a member who can read the diagram.
    open_project = client.post("/projects", json={"name": "Open convert"}).json()
    open_system = client.post(
        f"/projects/{open_project['id']}/systems", json={"name": "LOX"}
    ).json()
    open_diagram = add_legacy_diagram(
        session_factory, open_system["id"], schematic=schematic
    )
    other = client.post("/projects", json={"name": "Other open"}).json()
    cross = client.post(
        f"/projects/{other['id']}/drawings",
        json={"title": "Cross", "first_sheet": {"source_diagram_id": open_diagram.id}},
    )
    assert cross.status_code == 422
    assert "another project" in cross.json()["detail"]
    ok = client.post(
        f"/projects/{open_project['id']}/drawings",
        json={"title": "Converted", "first_sheet": {"source_diagram_id": open_diagram.id}},
    )
    assert ok.status_code == 201, ok.text
    sheet = client.get(f"/sheets/{ok.json()['sheets'][0]['id']}").json()
    assert sheet["document"]["items"][0]["tag"] == "HV-SECRET"


def test_trace_links_respect_project_access(client: TestClient) -> None:
    secret = _secret_project(client)
    outsider, _ = _user(client, "outsider@fsdp.test")
    link = client.post(
        "/trace-links",
        json={
            "source_type": "requirement",
            "source_id": secret["requirement"]["id"],
            "target_type": "drawing",
            "target_id": secret["drawing"]["id"],
            "link_type": "satisfied_by",
        },
    )
    assert link.status_code == 201, link.text
    assert outsider.delete(f"/trace-links/{link.json()['id']}").status_code == 404
    forged = outsider.post(
        "/trace-links",
        json={
            "source_type": "requirement",
            "source_id": secret["requirement"]["id"],
            "target_type": "part",
            "target_id": secret["part"]["id"],
            "link_type": "satisfied_by",
        },
    )
    assert forged.status_code == 404
    # A part's links into the hidden project are not listed for outsiders.
    client.post(
        "/trace-links",
        json={
            "source_type": "requirement",
            "source_id": secret["requirement"]["id"],
            "target_type": "part",
            "target_id": secret["part"]["id"],
            "link_type": "satisfied_by",
        },
    )
    assert outsider.get(f"/objects/part/{secret['part']['id']}/trace").json() == []
    assert len(client.get(f"/objects/part/{secret['part']['id']}/trace").json()) == 1


def test_api_token_is_bound_by_project_access(client: TestClient) -> None:
    secret = _secret_project(client)
    outsider, _ = _user(client, "outsider@fsdp.test")
    token = outsider.post("/auth/tokens", json={"name": "script"}).json()["token"]
    script = TestClient(app)
    headers = {"Authorization": f"Bearer {token}"}
    assert script.get(f"/drawings/{secret['drawing']['id']}", headers=headers).status_code == 404
    assert script.get("/projects", headers=headers).json() == []


def test_change_history_is_paged_and_filtered_by_project(client: TestClient) -> None:
    first = client.post("/projects", json={"name": "First"}).json()
    second = client.post("/projects", json={"name": "Second"}).json()
    for index in range(3):
        client.post(f"/projects/{first['id']}/systems", json={"name": f"S{index}"})
    client.post(f"/projects/{second['id']}/drawings", json={"title": "Feed"})

    page = client.get("/changes", params={"limit": 2})
    assert len(page.json()) == 2
    total = int(page.headers["X-Total-Count"])
    assert total >= 3
    rest = client.get("/changes", params={"limit": 200, "offset": 2}).json()
    assert len(rest) == total - 2
    assert {event["id"] for event in page.json()}.isdisjoint(event["id"] for event in rest)

    scoped = client.get("/changes", params={"project_id": second["id"]})
    assert {event["project_id"] for event in scoped.json()} == {second["id"]}
    assert any("drawing" in event["summary"].lower() for event in scoped.json())
    assert client.get("/auth/me").json()["email"] == TEST_USER_EMAIL


def test_reindex_endpoints_are_bound_by_project_access(client: TestClient) -> None:
    secret = _secret_project(client)
    outsider, _ = _user(client, "outsider@fsdp.test")
    assert outsider.post(f"/projects/{secret['project']['id']}/reindex").status_code == 404
    assert outsider.post(f"/drawings/{secret['drawing']['id']}/reindex").status_code == 404


def test_hazards_and_analyses_are_bound_by_project_access(client: TestClient) -> None:
    secret = _secret_project(client)
    project_id = secret["project"]["id"]
    hazard = client.post(
        f"/projects/{project_id}/hazards",
        json={"title": "Overpressure", "category": "overpressure", "severity": 4, "likelihood": 2},
    )
    assert hazard.status_code == 201, hazard.text
    outsider, outsider_id = _user(client, "outsider@fsdp.test")
    assert outsider.get(f"/projects/{project_id}/hazards").status_code == 404
    assert outsider.get(f"/projects/{project_id}/analyses").status_code == 404
    assert outsider.put(f"/hazards/{hazard.json()['id']}", json={"title": "x"}).status_code == 404
    assert outsider.delete(f"/hazards/{hazard.json()['id']}").status_code == 404
    assert outsider.get(f"/objects/hazard/{hazard.json()['id']}/trace").status_code == 404

    client.put(f"/projects/{project_id}/members/{outsider_id}", json={"role": "viewer"})
    assert len(outsider.get(f"/projects/{project_id}/hazards").json()) == 1
    denied = outsider.put(f"/hazards/{hazard.json()['id']}", json={"title": "x"})
    assert denied.status_code == 403
    events = client.get("/changes", params={"project_id": project_id}).json()
    assert any(
        "HAZ" in event["summary"] or "hazard" in event["summary"].lower() for event in events
    )
