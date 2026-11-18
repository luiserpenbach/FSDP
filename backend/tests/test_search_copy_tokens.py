"""Global search, drawing copy, API tokens, and sign-in lockout."""

from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from tests.conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD


def _project(client: TestClient, name: str = "Booster") -> dict:
    response = client.post("/projects", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def _document(tag: str = "HV-1042") -> dict:
    return {
        "schemaVersion": 1,
        "sheet": {"size": "A3", "orientation": "landscape"},
        "layers": [],
        "items": [{"id": "sym-1", "kind": "symbol", "tag": tag}],
        "meta": {"grid": 2.5},
    }


def _index(tag: str = "HV-1042") -> dict:
    return {
        "items": [
            {
                "item_id": "sym-1",
                "kind": "symbol",
                "category": "valve",
                "symbol_name": "Ball valve",
                "tag": tag,
                "zone": "B2",
            }
        ],
        "lines": [
            {"line_id": "line-1", "line_number": "LOX-0107", "service": "LOX", "size": '2"'}
        ],
    }


def _drawing(client: TestClient, project_id: str, tag: str = "HV-1042", **extra) -> dict:
    response = client.post(
        f"/projects/{project_id}/drawings",
        json={"title": "LOX feed\nBooster aft", **extra},
    )
    assert response.status_code == 201, response.text
    drawing = response.json()
    sheet = drawing["sheets"][0]
    saved = client.put(
        f"/sheets/{sheet['id']}",
        json={"document": _document(tag), "index": _index(tag), "drc": {"findings": []}},
    )
    assert saved.status_code == 200, saved.text
    return client.get(f"/drawings/{drawing['id']}").json()


def _kinds(hits: list[dict]) -> list[str]:
    return [hit["kind"] for hit in hits]


def test_search_finds_tags_lines_drawings_parts_and_requirements(client: TestClient) -> None:
    project = _project(client)
    drawing = _drawing(client, project["id"])
    part = client.post(
        "/parts",
        json={"part_number": "VLV-1042-A", "description": "Cryo ball valve", "part_type": "valve"},
    )
    assert part.status_code == 201, part.text
    requirement = client.post(
        "/requirements",
        json={
            "project_id": project["id"],
            "key": "REQ-1042",
            "title": "LOX isolation",
            "text": "Isolate the LOX feed.",
            "requirement_type": "functional",
        },
    )
    assert requirement.status_code == 201, requirement.text

    hits = client.get("/search", params={"q": "1042"}).json()["hits"]
    assert {"tag", "part", "requirement"} <= set(_kinds(hits))
    tag = next(hit for hit in hits if hit["kind"] == "tag")
    assert tag["title"] == "HV-1042"
    assert tag["drawing_id"] == drawing["id"]
    assert tag["sheet_id"] == drawing["sheets"][0]["id"]
    assert tag["item_id"] == "sym-1"
    assert tag["project_name"] == "Booster"
    assert drawing["number"] in tag["subtitle"]

    line = client.get("/search", params={"q": "lox-01"}).json()["hits"][0]
    assert (line["kind"], line["title"], line["item_id"]) == ("line", "LOX-0107", "line-1")

    by_title = client.get("/search", params={"q": "booster aft"}).json()["hits"]
    assert [hit["kind"] for hit in by_title] == ["drawing"]


def test_search_ranks_exact_then_prefix_and_prefers_the_current_project(
    client: TestClient,
) -> None:
    ship = _project(client, "Ship")
    booster = _project(client, "Booster")
    _drawing(client, ship["id"], tag="HV-10")
    _drawing(client, booster["id"], tag="HV-10")
    _drawing(client, booster["id"], tag="HV-100")
    _drawing(client, booster["id"], tag="XHV-10")

    hits = client.get("/search", params={"q": "hv-10", "project_id": booster["id"]}).json()["hits"]
    tags = [(hit["title"], hit["project_name"]) for hit in hits if hit["kind"] == "tag"]
    assert tags == [
        ("HV-10", "Booster"),
        ("HV-10", "Ship"),
        ("HV-100", "Booster"),
        ("XHV-10", "Booster"),
    ]


def test_search_treats_wildcards_literally_and_ignores_short_queries(client: TestClient) -> None:
    project = _project(client)
    _drawing(client, project["id"])
    assert client.get("/search", params={"q": "h"}).json()["hits"] == []
    assert client.get("/search", params={"q": "%%"}).json()["hits"] == []
    assert client.get("/search", params={"q": "HV_1042"}).json()["hits"] == []


def test_search_requires_sign_in() -> None:
    assert TestClient(app).get("/search", params={"q": "valve"}).status_code == 401


def test_copy_drawing_into_another_project_as_a_fresh_draft(client: TestClient) -> None:
    source_project = _project(client, "Ship 30")
    target_project = _project(client, "Ship 31")
    source = _drawing(client, source_project["id"])
    second = client.post(f"/drawings/{source['id']}/sheets", json={"title": "Vent"})
    assert second.status_code == 201, second.text

    response = client.post(
        f"/drawings/{source['id']}/copy", json={"project_id": target_project["id"]}
    )
    assert response.status_code == 201, response.text
    copied = response.json()
    assert copied["id"] != source["id"]
    assert copied["project_id"] == target_project["id"]
    assert copied["status"] == "draft"
    assert copied["title"] == "LOX feed (copy)\nBooster aft"
    assert [sheet["sheet_no"] for sheet in copied["sheets"]] == [1, 2]
    assert len(copied["revisions"]) == 1
    assert source["number"] in copied["revisions"][0]["description"]

    sheet = client.get(f"/sheets/{copied['sheets'][0]['id']}").json()
    assert sheet["document"]["items"][0]["tag"] == "HV-1042"
    # The copied content has no index yet; the empty second sheet has nothing to index.
    assert [entry["index_stale"] for entry in copied["sheets"]] == [True, False]

    # The copy is independent: editing it leaves the source untouched.
    edited = _document("HV-2000")
    saved = client.put(
        f"/sheets/{sheet['id']}",
        json={"document": edited, "index": _index("HV-2000"), "drc": {"findings": []}},
    )
    assert saved.status_code == 200, saved.text
    original = client.get(f"/sheets/{source['sheets'][0]['id']}").json()
    assert original["document"]["items"][0]["tag"] == "HV-1042"


def test_copy_drawing_defaults_and_conflicts(client: TestClient) -> None:
    project = _project(client)
    system = client.post(f"/projects/{project['id']}/systems", json={"name": "LOX"}).json()
    source = _drawing(client, project["id"], system_id=system["id"])

    copied = client.post(f"/drawings/{source['id']}/copy").json()
    assert copied["project_id"] == project["id"]
    assert copied["system_id"] == system["id"]
    assert copied["number"] != source["number"]

    taken = client.post(f"/drawings/{source['id']}/copy", json={"number": source["number"]})
    assert taken.status_code == 409

    other = _project(client, "Other")
    wrong_system = client.post(
        f"/drawings/{source['id']}/copy",
        json={"project_id": other["id"], "system_id": system["id"]},
    )
    assert wrong_system.status_code == 422
    # A system does not follow the drawing into another project.
    moved = client.post(f"/drawings/{source['id']}/copy", json={"project_id": other["id"]})
    assert moved.json()["system_id"] is None


def test_api_token_authenticates_without_a_session_cookie(client: TestClient) -> None:
    created = client.post("/auth/tokens", json={"name": "ERP sync"})
    assert created.status_code == 201, created.text
    secret = created.json()["token"]
    assert secret.startswith("fsdp_pat_")

    listed = client.get("/auth/tokens").json()
    assert [(token["name"], token["prefix"]) for token in listed] == [("ERP sync", secret[:14])]
    assert "token" not in listed[0]

    script = TestClient(app)
    headers = {"Authorization": f"Bearer {secret}"}
    assert script.get("/projects").status_code == 401
    assert script.get("/projects", headers=headers).status_code == 200
    made = script.post("/projects", json={"name": "From a script"}, headers=headers)
    assert made.status_code == 201
    assert script.get("/auth/me", headers=headers).json()["email"] == TEST_USER_EMAIL
    assert client.get("/auth/tokens").json()[0]["last_used_at"] is not None

    bad = {"Authorization": "Bearer fsdp_pat_not-a-real-token"}
    assert script.get("/projects", headers=bad).status_code == 401

    assert client.delete(f"/auth/tokens/{created.json()['id']}").status_code == 204
    assert script.get("/projects", headers=headers).status_code == 401


def test_api_token_follows_its_owner_role_and_status(client: TestClient) -> None:
    viewer = client.post(
        "/auth/users",
        json={
            "email": "viewer@fsdp.test",
            "name": "Viewer",
            "password": "viewer-password",
            "role": "viewer",
        },
    ).json()
    viewer_client = TestClient(app)
    login = viewer_client.post(
        "/auth/login", json={"email": "viewer@fsdp.test", "password": "viewer-password"}
    )
    assert login.status_code == 200
    secret = viewer_client.post("/auth/tokens", json={"name": "Read only"}).json()["token"]
    headers = {"Authorization": f"Bearer {secret}"}

    script = TestClient(app)
    assert script.get("/projects", headers=headers).status_code == 200
    assert script.post("/projects", json={"name": "Nope"}, headers=headers).status_code == 403
    # Another user's token cannot be revoked or seen.
    token_id = viewer_client.get("/auth/tokens").json()[0]["id"]
    assert client.delete(f"/auth/tokens/{token_id}").status_code == 404
    assert client.get("/auth/tokens").json() == []

    client.put(f"/auth/users/{viewer['id']}", json={"is_active": False})
    assert script.get("/projects", headers=headers).status_code == 401


def test_expired_api_token_is_rejected(client: TestClient, session_factory) -> None:
    import datetime as dt

    from app.models import ApiToken

    secret = client.post("/auth/tokens", json={"name": "Short", "expires_in_days": 1}).json()[
        "token"
    ]
    headers = {"Authorization": f"Bearer {secret}"}
    script = TestClient(app)
    assert script.get("/projects", headers=headers).status_code == 200
    with session_factory() as db:
        token = db.query(ApiToken).one()
        token.expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)
        db.commit()
    assert script.get("/projects", headers=headers).status_code == 401


def test_repeated_failed_sign_ins_lock_the_account(client: TestClient) -> None:
    attacker = TestClient(app)
    wrong = {"email": TEST_USER_EMAIL, "password": "wrong-password"}
    right = {"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD}
    for _ in range(settings.login_max_failures):
        assert attacker.post("/auth/login", json=wrong).status_code == 401
    # Locked: even the right password is refused until the lock expires.
    locked = attacker.post("/auth/login", json=right)
    assert locked.status_code == 429
    assert "Try again" in locked.json()["detail"]
    # Sessions that are already signed in keep working.
    assert client.get("/auth/me").status_code == 200


def test_successful_sign_in_resets_the_failure_count(client: TestClient) -> None:
    other = TestClient(app)
    wrong = {"email": TEST_USER_EMAIL, "password": "wrong-password"}
    right = {"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD}
    for _ in range(settings.login_max_failures - 1):
        assert other.post("/auth/login", json=wrong).status_code == 401
    assert other.post("/auth/login", json=right).status_code == 200
    for _ in range(settings.login_max_failures - 1):
        assert other.post("/auth/login", json=wrong).status_code == 401
    assert other.post("/auth/login", json=right).status_code == 200


def test_admin_password_reset_lifts_a_lock(client: TestClient) -> None:
    created = client.post(
        "/auth/users",
        json={"email": "locked@fsdp.test", "name": "Locked", "password": "first-password"},
    ).json()
    other = TestClient(app)
    for _ in range(settings.login_max_failures):
        other.post("/auth/login", json={"email": "locked@fsdp.test", "password": "nope-nope"})
    assert (
        other.post(
            "/auth/login", json={"email": "locked@fsdp.test", "password": "first-password"}
        ).status_code
        == 429
    )
    client.put(f"/auth/users/{created['id']}", json={"password": "second-password"})
    assert (
        other.post(
            "/auth/login", json={"email": "locked@fsdp.test", "password": "second-password"}
        ).status_code
        == 200
    )
