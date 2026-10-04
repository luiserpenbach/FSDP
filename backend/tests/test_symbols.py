"""Tests for user-defined P&ID symbol definitions."""

from fastapi.testclient import TestClient

VALVE_SVG = '<path d="M12 10 L32 20 L12 30 Z" /><path d="M52 10 L32 20 L52 30 Z" />'


def test_symbol_crud_roundtrip(client: TestClient) -> None:
    created = client.post(
        "/symbols",
        json={
            "name": "Cryo Valve",
            "view_box": "0 0 64 40",
            "svg": VALVE_SVG,
            "ports": [
                {"id": "in", "x": 2, "y": 20, "side": "left"},
                {"id": "out", "x": 62, "y": 20, "side": "right"},
            ],
        },
    )
    assert created.status_code == 201, created.text
    symbol = created.json()
    assert symbol["name"] == "Cryo Valve"
    assert [port["id"] for port in symbol["ports"]] == ["in", "out"]

    listed = client.get("/symbols").json()
    assert [entry["id"] for entry in listed] == [symbol["id"]]

    updated = client.put(
        f"/symbols/{symbol['id']}",
        json={"ports": [{"id": "in", "x": 4, "y": 20, "side": "left"}]},
    )
    assert updated.status_code == 200, updated.text
    assert len(updated.json()["ports"]) == 1
    assert updated.json()["svg"] == VALVE_SVG

    deleted = client.delete(f"/symbols/{symbol['id']}")
    assert deleted.status_code == 204
    assert client.get("/symbols").json() == []


def test_symbol_duplicate_name_rejected(client: TestClient) -> None:
    payload = {"name": "Filter", "svg": VALVE_SVG, "ports": []}
    assert client.post("/symbols", json=payload).status_code == 201
    duplicate = client.post("/symbols", json={**payload, "name": "  filter "})
    assert duplicate.status_code == 409


def test_symbol_rejects_active_svg_content(client: TestClient) -> None:
    for svg in (
        "<script>alert(1)</script>",
        '<circle cx="1" cy="1" r="1" onload="alert(1)" />',
        '<a href="javascript:alert(1)">x</a>',
        # Stored-XSS vectors that bypassed the original script/onload blocklist:
        # nested SVG via data: URI is executed when rendered with innerHTML.
        '<use href="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+" />',
        '<image xlink:href="data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E" />',
        '<set attributeName="onload" to="alert(1)"/>',
        '<style>@import "https://evil.example/x.css"</style><circle r="1"/>',
        '<a href="https://evil.example/phish">x</a>',
        '<animateTransform attributeName="transform" type="rotate" from="0" to="360"/>',
    ):
        response = client.post("/symbols", json={"name": "Bad", "svg": svg, "ports": []})
        assert response.status_code == 422, svg


def test_symbol_accepts_safe_drawing_markup(client: TestClient) -> None:
    """Path/shape markup from the symbol editor must still round-trip."""
    response = client.post(
        "/symbols",
        json={
            "name": "Drawn Valve",
            "view_box": "0 0 64 40",
            "svg": (
                VALVE_SVG
                + '<rect x="2" y="2" width="4" height="4" /><circle cx="32" cy="20" r="3" />'
            ),
            "ports": [],
        },
    )
    assert response.status_code == 201, response.text


def test_symbol_rejects_invalid_port_side(client: TestClient) -> None:
    response = client.post(
        "/symbols",
        json={
            "name": "Bad Ports",
            "svg": VALVE_SVG,
            "ports": [{"id": "p", "x": 0, "y": 0, "side": "diagonal"}],
        },
    )
    assert response.status_code == 422


def test_symbol_rejects_allowlist_bypass_payloads(client: TestClient) -> None:
    """Only allowlisted drawing markup is stored; blocklist bypasses are rejected (C5)."""
    for svg in (
        "<img/src=x/onerror=alert(1)>",
        '<img src="x" onerror="alert(1)"/>',
        "<svg><script>alert(1)</script></svg>",
        "<SCRIPT>alert(1)</SCRIPT>",
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
        '<a href="javascript:alert(1)"><circle r="1"/></a>',
        '<set attributeName="onclick" to="alert(1)"/>',
        '<rect width="1" height="1" style="background:url(javascript:alert(1))"/>',
        '<rect width="1" height="1" style="fill:url(https://evil.example/x.svg#a)"/>',
        '<rect width="1" height="1" fill="url(https://evil.example/x.svg#a)"/>',
        '<circle cx="1" cy="1" r="1" ONLOAD="alert(1)"/>',
        '<circle cx="1" cy="1" r="1" onLoad="alert(1)"/>',
        '<use xlink:href="https://evil.example/sprite.svg#icon"/>',
        '<use href=" javascript:alert(1)"/>',
        # The XML and HTML parsers disagree on these, so they are rejected outright.
        "<!--><img src=x onerror=alert(1)>-->",
        "<title><![CDATA[><img src=x onerror=alert(1)>]]></title>",
        '<?xml-stylesheet href="https://evil.example/x.css"?><circle r="1"/>',
        # Unknown namespaces and attributes are not passed through.
        '<path xmlns:x="https://evil.example" x:onload="alert(1)" d="M0 0"/>',
        '<path d="M0 0" filter="url(#f)"/>',
        "<path d='M0 0'",
    ):
        response = client.post("/symbols", json={"name": "Bad", "svg": svg, "ports": []})
        assert response.status_code == 422, svg


def test_symbol_accepts_browser_serialized_and_referencing_markup(client: TestClient) -> None:
    """Markup as the symbol editor's DOM serialization emits it, with #fragment references."""
    svg = (
        '<defs xmlns="http://www.w3.org/2000/svg">'
        '<linearGradient id="g1" gradientUnits="userSpaceOnUse">'
        '<stop offset="0" stop-color="#fff"/></linearGradient>'
        '<marker id="arrow" markerWidth="4" markerHeight="4" orient="auto">'
        '<path d="M0 0 L4 2 L0 4 Z"/></marker></defs>'
        '<path xmlns="http://www.w3.org/2000/svg" d="M12 10 L32 20" '
        'style="stroke: currentColor; stroke-width: 2" marker-end="url(#arrow)"/>'
        '<rect x="1" y="1" width="4" height="4" fill="url( \'#g1\' )"/>'
        '<use href="#arrow" x="4"/>'
        '<text x="2" y="8" font-size="6" text-anchor="middle">P&amp;ID</text>'
    )
    response = client.post(
        "/symbols", json={"name": "Referencing", "view_box": "0 0 64 40", "svg": svg, "ports": []}
    )
    assert response.status_code == 201, response.text
    assert response.json()["svg"] == svg
