"""Single sign-on with OpenID Connect (authorization code flow with PKCE).

Works with any standards-compliant provider (Okta, Entra ID, Google Workspace,
Keycloak): the endpoints and signing keys come from the issuer's discovery
document. Enabled when FSDP_OIDC_ISSUER, FSDP_OIDC_CLIENT_ID and
FSDP_OIDC_REDIRECT_URL are set.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
import jwt

from app.core.config import settings

STATE_COOKIE = "fsdp_sso"
STATE_TTL_SECONDS = 600
_DISCOVERY_TTL_SECONDS = 3600
_ALLOWED_ALGORITHMS = ("RS256", "RS384", "RS512", "PS256", "ES256", "ES384")
_HTTP_TIMEOUT = 10.0

_cache: dict[str, tuple[float, dict]] = {}


class SsoError(Exception):
    """A sign-in that cannot be completed; the message is safe to show the user."""


@dataclass(frozen=True)
class SsoIdentity:
    email: str
    name: str


def sso_enabled() -> bool:
    return bool(settings.oidc_issuer and settings.oidc_client_id and settings.oidc_redirect_url)


def _get_json(url: str) -> dict:
    response = httpx.get(url, timeout=_HTTP_TIMEOUT, follow_redirects=True)
    response.raise_for_status()
    return response.json()


def _post_form(url: str, data: dict[str, str]) -> dict:
    response = httpx.post(url, data=data, timeout=_HTTP_TIMEOUT)
    if response.status_code >= 400:
        raise SsoError("The identity provider rejected the sign-in.")
    return response.json()


def _cached(url: str) -> dict:
    hit = _cache.get(url)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    try:
        value = _get_json(url)
    except (httpx.HTTPError, ValueError) as error:
        raise SsoError("The identity provider could not be reached.") from error
    _cache[url] = (time.monotonic() + _DISCOVERY_TTL_SECONDS, value)
    return value


def discovery() -> dict:
    issuer = settings.oidc_issuer.rstrip("/")
    document = _cached(f"{issuer}/.well-known/openid-configuration")
    # The issuer in the document must be the configured one (OIDC Discovery 4.3).
    if str(document.get("issuer", "")).rstrip("/") != issuer:
        raise SsoError("The identity provider's configuration does not match its issuer.")
    return document


def _signing_key(jwks_uri: str, kid: str | None):
    for attempt in range(2):
        keys = _cached(jwks_uri).get("keys", [])
        for key in keys:
            if kid is None or key.get("kid") == kid:
                return jwt.PyJWK(key).key
        # The provider may have rotated its keys since they were cached.
        if attempt == 0:
            _cache.pop(jwks_uri, None)
    raise SsoError("The identity provider signed the sign-in with an unknown key.")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def begin_login() -> tuple[str, str]:
    """The provider URL to send the browser to, and the signed state cookie value."""
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    query = urlencode(
        {
            "response_type": "code",
            "client_id": settings.oidc_client_id,
            "redirect_uri": settings.oidc_redirect_url,
            "scope": settings.oidc_scopes,
            "state": state,
            "nonce": nonce,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    endpoint = discovery()["authorization_endpoint"]
    separator = "&" if "?" in endpoint else "?"
    cookie = jwt.encode(
        {
            "state": state,
            "nonce": nonce,
            "verifier": verifier,
            "exp": dt.datetime.now(dt.UTC) + dt.timedelta(seconds=STATE_TTL_SECONDS),
        },
        settings.secret_key,
        algorithm="HS256",
    )
    return f"{endpoint}{separator}{query}", cookie


def complete_login(code: str, state: str, state_cookie: str | None) -> SsoIdentity:
    """Exchange the code and verify the ID token; raises SsoError on any mismatch."""
    try:
        pending = jwt.decode(state_cookie or "", settings.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError as error:
        raise SsoError("The sign-in took too long or was started elsewhere. Try again.") from error
    if not secrets.compare_digest(str(pending.get("state", "")), state):
        raise SsoError("The sign-in response does not match the request. Try again.")

    document = discovery()
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.oidc_redirect_url,
        "client_id": settings.oidc_client_id,
        "code_verifier": pending["verifier"],
    }
    if settings.oidc_client_secret:
        form["client_secret"] = settings.oidc_client_secret
    try:
        tokens = _post_form(document["token_endpoint"], form)
    except (httpx.HTTPError, ValueError) as error:
        raise SsoError("The identity provider could not be reached.") from error
    id_token = tokens.get("id_token")
    if not id_token:
        raise SsoError("The identity provider returned no identity.")

    try:
        header = jwt.get_unverified_header(id_token)
        algorithm = header.get("alg")
        if algorithm not in _ALLOWED_ALGORITHMS:
            raise SsoError("The identity provider uses an unsupported signature.")
        claims = jwt.decode(
            id_token,
            _signing_key(document["jwks_uri"], header.get("kid")),
            algorithms=[algorithm],
            audience=settings.oidc_client_id,
            issuer=document["issuer"],
            leeway=60,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError as error:
        raise SsoError("The identity provider's response could not be verified.") from error
    if not secrets.compare_digest(str(claims.get("nonce", "")), str(pending.get("nonce", ""))):
        raise SsoError("The sign-in response does not match the request. Try again.")

    email = str(claims.get("email") or "").strip().lower()
    if not email or "@" not in email:
        raise SsoError("Your identity provider account has no email address.")
    # Accounts are matched by email, so an unverified address must not sign in.
    if claims.get("email_verified") is False:
        raise SsoError("Your email address is not verified with the identity provider.")
    allowed = [domain.strip().lower().lstrip("@") for domain in settings.oidc_allowed_domains]
    if allowed and email.rsplit("@", 1)[1] not in allowed:
        raise SsoError("Your email domain is not allowed to sign in here.")
    name = str(claims.get("name") or claims.get("preferred_username") or email.split("@")[0])
    return SsoIdentity(email=email, name=name.strip()[:160] or email)
