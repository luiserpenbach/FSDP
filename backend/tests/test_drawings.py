"""Drawings, sheets, revisions, and sheet export."""

import re
import zlib

from fastapi.testclient import TestClient

SVG = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 420 297">'
    '<rect x="10" y="10" width="400" height="277" fill="none" stroke="#000" stroke-width="0.7"/>'
    '<text x="200" y="150" font-size="5" text-anchor="middle">TITLE</text></svg>'
)


def _inflate(payload: bytes) -> bytes:
    try:
        return zlib.decompress(payload)
    except zlib.error:
        return b""


def _project(client: TestClient) -> str:
    return client.post("/projects", json={"name": "AMB2", "part_name_prefix": "AMB2"}).json()["id"]


def _document(size: str = "A3") -> dict:
    return {
        "schemaVersion": 1,
        "sheet": {
            "size": size,
            "orientation": "landscape",
            "frame": {"kind": "basic", "columns": 4, "rows": 3, "margin": 10},
        },
        "layers": [],
        "items": [
            {
                "id": "v1",
                "kind": "symbol",
                "layer": "symbols",
                "symbol": {"library": "fsdp", "key": "valve", "version": 1},
                "position": {"x": 50, "y": 50},
                "rotation": 0,
                "tag": "HV-1",
                "fields": {},
            }
        ],
        "meta": {"grid": 2.5},
    }


def test_create_drawing_with_generated_number_first_sheet_and_revision(client: TestClient) -> None:
    project_id = _project(client)
    created = client.post(
        f"/projects/{project_id}/drawings",
        json={"title": "P&ID\nPHASE 2\nFILL TEST", "size": "ANSI_E", "units": "in"},
    )
    assert created.status_code == 201, created.text
    drawing = created.json()
    assert drawing["number"] == "AMB2-0001"
    assert drawing["size"] == "ANSI_E"
    assert drawing["frame_template"] == "fsdp-standard"
    assert [sheet["sheet_no"] for sheet in drawing["sheets"]] == [1]
    assert drawing["revisions"][0] == {
        **drawing["revisions"][0],
        "sequence": 1,
        "label": "-",
        "status": "working",
        "drawn_by": "Test Engineer",
    }

    sheet = client.get(f"/sheets/{drawing['sheets'][0]['id']}").json()
    assert sheet["document"]["sheet"]["size"] == "ANSI_E"
    assert sheet["document"]["items"] == []

    second = client.post(f"/projects/{project_id}/drawings", json={"title": "Second"}).json()
    assert second["number"] == "AMB2-0002"

    listed = client.get(f"/projects/{project_id}/drawings").json()
    assert [entry["number"] for entry in listed] == ["AMB2-0001", "AMB2-0002"]

    duplicate = client.post(
        f"/projects/{project_id}/drawings", json={"title": "Dup", "number": "AMB2-0001"}
    )
    assert duplicate.status_code == 409


def test_drawing_update_sheets_and_revisions(client: TestClient) -> None:
    project_id = _project(client)
    drawing = client.post(
        f"/projects/{project_id}/drawings",
        json={"title": "Panel", "number": "AMB2-9003", "first_sheet": {"document": _document()}},
    ).json()
    drawing_id = drawing["id"]

    updated = client.put(
        f"/drawings/{drawing_id}",
        json={
            "title": "Panel\nrevised",
            "notes": ["ALL LINES 1/4 IN", "SEE PARTS LIST"],
            "fields": {"company": "Amphora", "scale": "NO SCALE"},
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["notes"] == ["ALL LINES 1/4 IN", "SEE PARTS LIST"]
    assert updated.json()["fields"]["company"] == "Amphora"
    assert updated.json()["number"] == "AMB2-9003"

    bad_size = client.put(f"/drawings/{drawing_id}", json={"size": "LETTER"})
    assert bad_size.status_code == 422

    sheet2 = client.post(f"/drawings/{drawing_id}/sheets", json={"title": "Vent system"})
    assert sheet2.status_code == 201, sheet2.text
    assert sheet2.json()["sheet_no"] == 2
    sheet3 = client.post(f"/drawings/{drawing_id}/sheets", json={}).json()
    assert sheet3["sheet_no"] == 3

    saved = client.put(f"/sheets/{sheet2.json()['id']}", json={"document": _document()})
    assert saved.status_code == 200, saved.text
    assert saved.json()["document"]["items"][0]["tag"] == "HV-1"
    invalid = client.put(f"/sheets/{sheet2.json()['id']}", json={"document": {"schemaVersion": 9}})
    assert invalid.status_code == 422

    removed = client.delete(f"/sheets/{sheet2.json()['id']}")
    assert removed.status_code == 204
    sheets = client.get(f"/drawings/{drawing_id}").json()["sheets"]
    numbers = [sheet["sheet_no"] for sheet in sheets]
    assert numbers == [1, 2]

    revision = client.post(
        f"/drawings/{drawing_id}/revisions",
        json={"label": "A", "description": "Added vent", "checked_by": "R. Eng"},
    )
    assert revision.status_code == 201, revision.text
    assert revision.json()["sequence"] == 2
    edited = client.put(f"/revisions/{revision.json()['id']}", json={"approved_by": "Chief"})
    assert edited.json()["approved_by"] == "Chief"
    labels = [rev["label"] for rev in client.get(f"/drawings/{drawing_id}").json()["revisions"]]
    assert labels == ["-", "A"]

    first_sheet_id = client.get(f"/drawings/{drawing_id}").json()["sheets"][0]["id"]
    client.delete(f"/sheets/{client.get(f'/drawings/{drawing_id}').json()['sheets'][1]['id']}")
    last = client.delete(f"/sheets/{first_sheet_id}")
    assert last.status_code == 409

    deleted = client.delete(f"/drawings/{drawing_id}")
    assert deleted.status_code == 204
    assert client.get(f"/drawings/{drawing_id}").status_code == 404


def test_convert_diagram_into_first_sheet(client: TestClient) -> None:
    project_id = _project(client)
    system = client.post(f"/projects/{project_id}/systems", json={"name": "GHe"}).json()
    diagram = client.post(f"/systems/{system['id']}/diagrams", json={"name": "Legacy"}).json()

    missing = client.post(
        f"/projects/{project_id}/drawings",
        json={"title": "From diagram", "first_sheet": {"source_diagram_id": diagram["id"]}},
    )
    assert missing.status_code == 422

    client.put(f"/diagrams/{diagram['id']}/schematic", json={"document": _document()})
    created = client.post(
        f"/projects/{project_id}/drawings",
        json={
            "title": "From diagram",
            "system_id": system["id"],
            "first_sheet": {"source_diagram_id": diagram["id"]},
        },
    )
    assert created.status_code == 201, created.text
    sheet = created.json()["sheets"][0]
    assert sheet["source_diagram_id"] == diagram["id"]
    assert client.get(f"/sheets/{sheet['id']}").json()["document"]["items"][0]["id"] == "v1"


def test_sheet_export_pdf_png_and_svg(client: TestClient) -> None:
    project_id = _project(client)
    drawing = client.post(
        f"/projects/{project_id}/drawings", json={"title": "Export", "number": "AMB2-9003"}
    ).json()
    sheet_id = drawing["sheets"][0]["id"]

    pdf = client.post(f"/sheets/{sheet_id}/export", json={"svg": SVG, "format": "pdf"})
    assert pdf.status_code == 200, pdf.text
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["content-disposition"] == 'attachment; filename="AMB2-9003-01-rev0.pdf"'
    assert pdf.content.startswith(b"%PDF")
    # A3 landscape at 72 pt/in: 1190.55 x 841.89 pt (Cairo stores it in a compressed object stream).
    inflated = b"".join(
        _inflate(match.group(1))
        for match in re.finditer(rb"stream\r?\n(.*?)endstream", pdf.content, re.S)
    )
    assert re.search(rb"MediaBox \[ 0 0 1190\.\d+ 841\.\d+ \]", inflated)

    png = client.post(f"/sheets/{sheet_id}/export", json={"svg": SVG, "format": "png", "dpi": 150})
    assert png.status_code == 200
    assert png.content[:8] == b"\x89PNG\r\n\x1a\n"
    width = int.from_bytes(png.content[16:20], "big")
    assert 2470 <= width <= 2490  # 420 mm at 150 dpi

    svg = client.post(f"/sheets/{sheet_id}/export", json={"svg": SVG, "format": "svg"})
    assert svg.status_code == 200
    assert svg.headers["content-type"].startswith("image/svg+xml")

    scripted = client.post(
        f"/sheets/{sheet_id}/export",
        json={
            "svg": SVG.replace("</svg>", '<image href="http://evil/x.png"/></svg>'),
            "format": "pdf",
        },
    )
    assert scripted.status_code == 422
    not_svg = client.post(f"/sheets/{sheet_id}/export", json={"svg": "hello", "format": "pdf"})
    assert not_svg.status_code == 422


def test_drawing_update_json_null_object_fields_do_not_brick_project_list(client: TestClient) -> None:
    """Explicit JSON null on fields/notes must not persist NULL.

    Before the fix, update_drawing stored NULL, the PUT response failed DrawingRead
    validation (500 after commit), and GET /projects/{id}/drawings failed for the
    whole project.
    """
    project_id = _project(client)
    keep = client.post(
        f"/projects/{project_id}/drawings",
        json={"title": "Keep", "number": "AMB2-KEEP", "fields": {"company": "OK"}, "notes": ["keep"]},
    ).json()
    drawing = client.post(
        f"/projects/{project_id}/drawings",
        json={
            "title": "Null fields",
            "number": "AMB2-NULL",
            "fields": {"company": "Sierra Lobo"},
            "notes": ["ALL LINES 1/4 IN"],
        },
    ).json()

    for field, empty in (("fields", {}), ("notes", [])):
        updated = client.put(f"/drawings/{drawing['id']}", json={field: None})
        assert updated.status_code == 200, updated.text
        assert updated.json()[field] == empty

        listed = client.get(f"/projects/{project_id}/drawings")
        assert listed.status_code == 200, listed.text
        by_id = {row["id"]: row for row in listed.json()}
        assert by_id[drawing["id"]][field] == empty
        assert by_id[keep["id"]]["fields"]["company"] == "OK"
        assert by_id[keep["id"]]["notes"] == ["keep"]

        single = client.get(f"/drawings/{drawing['id']}")
        assert single.status_code == 200
        assert single.json()[field] == empty

    # Omitting the fields must not wipe previously stored values.
    client.put(
        f"/drawings/{drawing['id']}",
        json={"fields": {"company": "Restored"}, "notes": ["note"]},
    )
    renamed = client.put(f"/drawings/{drawing['id']}", json={"title": "Renamed"})
    assert renamed.status_code == 200
    assert renamed.json()["fields"] == {"company": "Restored"}
    assert renamed.json()["notes"] == ["note"]
