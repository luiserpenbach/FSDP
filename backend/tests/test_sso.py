"""OpenID Connect sign-in against a fake provider with a real signing key."""

import datetime as dt
import json
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.core import oidc
from app.core.config import Settings, settings
from app.main import app

ISSUER = "https://idp.example.test"
CLIENT_ID = "fsdp-client"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
JWK = {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key())), "kid": "k1"}


class Provider:
    """Stands in for the identity provider's HTTP endpoints."""

    def __init__(self) -> None:
        self.claims: dict = {"email": "new.engineer@example.test", "name": "New Engineer"}
        self.key = KEY
        self.nonce = ""
        self.token_requests: list[dict] = []

    def get_json(self, url: str) -> dict:
        if url.endswith("/.well-known/openid-configuration"):
            return {
                "issuer": ISSUER,
                "authorization_endpoint": f"{ISSUER}/authorize",
                "token_endpoint": f"{ISSUER}/token",
                "jwks_uri": f"{ISSUER}/keys",
            }
        assert url == f"{ISSUER}/keys"
        return {"keys": [JWK]}

    def post_form(self, url: str, data: dict) -> dict:
        assert url == f"{ISSUER}/token"
        self.token_requests.append(data)
        now = dt.datetime.now(dt.UTC)
        claims = {
            "iss": ISSUER,
            "aud": CLIENT_ID,
            "sub": "user-123",
            "iat": now,
            "exp": now + dt.timedelta(minutes=5),
            "nonce": self.nonce,
            **self.claims,
        }
        token = jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": "k1"})
        return {"id_token": token, "access_token": "unused"}


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> Provider:
    fake = Provider()
    monkeypatch.setattr(oidc, "_get_json", fake.get_json)
    monkeypatch.setattr(oidc, "_post_form", fake.post_form)
    monkeypatch.setattr(settings, "oidc_issuer", ISSUER)
    monkeypatch.setattr(settings, "oidc_client_id", CLIENT_ID)
    monkeypatch.setattr(settings, "oidc_client_secret", "shh")
    monkeypatch.setattr(settings, "oidc_redirect_url", "https://fsdp.test/api/auth/sso/callback")
    monkeypatch.setattr(settings, "oidc_post_login_url", "/")
    oidc._cache.clear()
    yield fake
    oidc._cache.clear()


def _start(browser: TestClient, provider: Provider) -> dict:
    response = browser.get("/auth/sso/login", follow_redirects=False)
    assert response.status_code == 303
    location = urlparse(response.headers["location"])
    query = {key: values[0] for key, values in parse_qs(location.query).items()}
    assert f"{location.scheme}://{location.netloc}{location.path}" == f"{ISSUER}/authorize"
    assert query["client_id"] == CLIENT_ID
    assert query["code_challenge_method"] == "S256"
    provider.nonce = query["nonce"]
    return query


def _finish(browser: TestClient, state: str, code: str = "abc"):
    return browser.get(
        "/auth/sso/callback", params={"code": code, "state": state}, follow_redirects=False
    )


def test_sso_is_off_until_configured(client: TestClient) -> None:
    browser = TestClient(app)
    assert browser.get("/auth/config").json() == {
        "sso_enabled": False,
        "sso_label": "Sign in with SSO",
        "password_login_enabled": True,
    }
    assert browser.get("/auth/sso/login", follow_redirects=False).status_code == 404
    assert browser.get("/auth/sso/callback", params={"code": "x", "state": "y"}).status_code == 404


def test_first_sso_sign_in_creates_a_viewer_and_a_session(
    client: TestClient, provider: Provider
) -> None:
    browser = TestClient(app)
    assert browser.get("/auth/config").json()["sso_enabled"] is True
    query = _start(browser, provider)
    done = _finish(browser, query["state"])
    assert done.status_code == 303 and done.headers["location"] == "/"

    me = browser.get("/auth/me").json()
    assert (me["email"], me["name"], me["role"]) == (
        "new.engineer@example.test",
        "New Engineer",
        "viewer",
    )
    # The code was exchanged with the PKCE verifier and the client secret.
    sent = provider.token_requests[0]
    assert sent["code"] == "abc" and sent["client_secret"] == "shh" and sent["code_verifier"]
    # The account has no usable password.
    assert (
        TestClient(app)
        .post("/auth/login", json={"email": "new.engineer@example.test", "password": ""})
        .status_code
        == 401
    )


def test_sso_signs_in_an_existing_account_with_its_role(
    client: TestClient, provider: Provider
) -> None:
    client.post(
        "/auth/users",
        json={
            "email": "lead@example.test",
            "name": "Lead",
            "password": "lead-password",
            "role": "engineer",
        },
    )
    provider.claims = {"email": "Lead@Example.test", "email_verified": True}
    browser = TestClient(app)
    assert _finish(browser, _start(browser, provider)["state"]).headers["location"] == "/"
    assert browser.get("/auth/me").json()["role"] == "engineer"
    assert len([u for u in client.get("/auth/users").json() if "lead" in u["email"]]) == 1


def _error(response) -> str:
    assert response.status_code == 303
    return parse_qs(urlparse(response.headers["location"]).query)["sso_error"][0]


def test_sso_rejects_forged_and_mismatched_responses(
    client: TestClient, provider: Provider
) -> None:
    browser = TestClient(app)
    query = _start(browser, provider)

    # Wrong state (a response the browser did not ask for).
    assert "does not match" in _error(_finish(browser, "someone-elses-state"))
    assert browser.get("/auth/me").status_code == 401

    # No state cookie at all (a callback opened in another browser).
    assert "Try again" in _error(_finish(TestClient(app), query["state"]))

    # Token signed by a key the provider does not publish.
    query = _start(browser, provider)
    provider.key = OTHER_KEY
    assert "could not be verified" in _error(_finish(browser, query["state"]))
    provider.key = KEY

    # Replayed token: the nonce belongs to an earlier request.
    query = _start(browser, provider)
    provider.nonce = "stale-nonce"
    assert "does not match" in _error(_finish(browser, query["state"]))

    # Token issued for another application.
    query = _start(browser, provider)
    provider.claims = {"email": "a@example.test", "aud": "another-client"}
    assert "could not be verified" in _error(_finish(browser, query["state"]))
    assert browser.get("/auth/me").status_code == 401


def test_sso_refuses_unverified_emails_other_domains_and_inactive_accounts(
    client: TestClient, provider: Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    browser = TestClient(app)
    provider.claims = {"email": "x@example.test", "email_verified": False}
    assert "not verified" in _error(_finish(browser, _start(browser, provider)["state"]))

    monkeypatch.setattr(settings, "oidc_allowed_domains", ["example.test"])
    provider.claims = {"email": "intruder@elsewhere.test"}
    assert "domain is not allowed" in _error(_finish(browser, _start(browser, provider)["state"]))
    provider.claims = {"email": "ok@example.test"}
    assert _finish(browser, _start(browser, provider)["state"]).headers["location"] == "/"

    user_id = next(
        u["id"] for u in client.get("/auth/users").json() if u["email"] == "ok@example.test"
    )
    client.put(f"/auth/users/{user_id}", json={"is_active": False})
    other = TestClient(app)
    assert "deactivated" in _error(_finish(other, _start(other, provider)["state"]))
    assert other.get("/auth/me").status_code == 401

    assert "did not complete" in _error(
        other.get("/auth/sso/callback", params={"error": "access_denied"}, follow_redirects=False)
    )


def test_password_sign_in_can_be_limited_to_administrators(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.post(
        "/auth/users",
        json={"email": "eng@example.test", "name": "Eng", "password": "eng-password"},
    )
    monkeypatch.setattr(settings, "password_login_enabled", False)
    refused = TestClient(app).post(
        "/auth/login", json={"email": "eng@example.test", "password": "eng-password"}
    )
    assert refused.status_code == 403
    from tests.conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD

    admin = TestClient(app).post(
        "/auth/login", json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD}
    )
    assert admin.status_code == 200


def test_sso_cannot_create_administrators() -> None:
    with pytest.raises(ValueError):
        Settings(oidc_default_role="admin")
