"""Authentication, authorization, and audit-trail tests (Phase 1)."""

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import TEST_USER_EMAIL


def anonymous_client() -> TestClient:
    """A client against the same app/database but without a session cookie."""
    return TestClient(app)


def test_api_requires_authentication(client: TestClient) -> None:
    anonymous = anonymous_client()

    unauthenticated = anonymous.get("/projects")
    unauthenticated_write = anonymous.post("/projects", json={"name": "Nope"})
    health = anonymous.get("/health")

    assert unauthenticated.status_code == 401
    assert unauthenticated_write.status_code == 401
    assert health.status_code == 200


def test_login_rejects_bad_credentials(client: TestClient) -> None:
    wrong_password = anonymous_client().post(
        "/auth/login", json={"email": TEST_USER_EMAIL, "password": "wrong-password"}
    )
    unknown_user = anonymous_client().post(
        "/auth/login", json={"email": "ghost@fsdp.test", "password": "irrelevant-pass"}
    )

    assert wrong_password.status_code == 401
    assert unknown_user.status_code == 401


def test_me_logout_flow(client: TestClient) -> None:
    me = client.get("/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == TEST_USER_EMAIL

    logout = client.post("/auth/logout")
    me_after_logout = client.get("/auth/me")

    assert logout.status_code == 204
    assert me_after_logout.status_code == 401


def test_admin_manages_users_and_non_admin_is_forbidden(client: TestClient) -> None:
    created = client.post(
        "/auth/users",
        json={
            "email": "Viewer@FSDP.test ",
            "name": "Viewer User",
            "password": "viewer-password",
            "role": "viewer",
        },
    )
    assert created.status_code == 201
    assert created.json()["email"] == "viewer@fsdp.test"

    duplicate = client.post(
        "/auth/users",
        json={
            "email": "viewer@fsdp.test",
            "name": "Viewer Again",
            "password": "viewer-password",
            "role": "viewer",
        },
    )
    bad_role = client.post(
        "/auth/users",
        json={
            "email": "other@fsdp.test",
            "name": "Other",
            "password": "other-password",
            "role": "superuser",
        },
    )
    assert duplicate.status_code == 409
    assert bad_role.status_code == 422

    viewer = anonymous_client()
    login = viewer.post(
        "/auth/login", json={"email": "viewer@fsdp.test", "password": "viewer-password"}
    )
    assert login.status_code == 200

    forbidden = viewer.post(
        "/auth/users",
        json={"email": "x@fsdp.test", "name": "X", "password": "x-password-123"},
    )
    can_read = viewer.get("/projects")

    assert forbidden.status_code == 403
    assert can_read.status_code == 200


def test_deactivated_user_loses_access(client: TestClient) -> None:
    created = client.post(
        "/auth/users",
        json={
            "email": "temp@fsdp.test",
            "name": "Temp",
            "password": "temp-password-123",
            "role": "engineer",
        },
    ).json()
    temp = anonymous_client()
    temp.post("/auth/login", json={"email": "temp@fsdp.test", "password": "temp-password-123"})
    assert temp.get("/auth/me").status_code == 200

    deactivated = client.put(f"/auth/users/{created['id']}", json={"is_active": False})

    assert deactivated.status_code == 200
    assert temp.get("/auth/me").status_code == 401
    assert temp.get("/projects").status_code == 401


def test_admin_cannot_deactivate_own_account(client: TestClient) -> None:
    me = client.get("/auth/me").json()

    response = client.put(f"/auth/users/{me['id']}", json={"is_active": False})

    assert response.status_code == 400


def test_deletes_are_audited_with_actor(client: TestClient) -> None:
    project = client.post("/projects", json={"name": "Audit Me"}).json()
    client.delete(f"/projects/{project['id']}")

    changes = client.get("/changes").json()
    delete_events = [c for c in changes if c["action"] == "deleted"]

    assert delete_events, "expected a deletion audit event"
    assert delete_events[0]["object_id"] == project["id"]
    assert delete_events[0]["actor"] == TEST_USER_EMAIL


def test_change_history_lists_recent_events_with_actor(client: TestClient) -> None:
    client.post("/projects", json={"name": "History"}).json()

    changes = client.get("/changes", params={"limit": 10}).json()

    assert len(changes) >= 1
    assert all("summary" in change for change in changes)
    assert changes[0]["actor"] == TEST_USER_EMAIL
