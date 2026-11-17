"""Server-side sheet index and DRC (app/services/server_index.py).

The real-engine tests run the bundled TypeScript engine under Node and need
`frontend/dist-engine/engine-cli.mjs` (`npm run build:engine` in `frontend/`, or
`FSDP_TEST_ENGINE_CLI`); they are skipped without it, or fail when
`FSDP_REQUIRE_ENGINE` is set (CI). The error paths use small fake CLI scripts run by
the Python interpreter instead of Node.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import shutil
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app import db as app_db
from app.core.config import settings
from app.models import (
    Drawing,
    DrawingRevision,
    DrawingSheet,
    DrcWaiver,
    Part,
    PidSymbolDef,
    Requirement,
    SheetItem,
    TagScheme,
)
from app.services import server_index

REPO_ROOT = Path(__file__).resolve().parents[2]
ENGINE_CLI = Path(
    os.environ.get("FSDP_TEST_ENGINE_CLI")
    or REPO_ROOT / "frontend" / "dist-engine" / "engine-cli.mjs"
)
PARITY_FILE = REPO_ROOT / "frontend" / "src" / "engine" / "testdata" / "engine-parity.json"
NODE = shutil.which("node")

# CI sets FSDP_REQUIRE_ENGINE so that a missing bundle fails these tests instead of
# quietly skipping them.
real_engine = pytest.mark.skipif(
    (NODE is None or not ENGINE_CLI.is_file()) and not os.environ.get("FSDP_REQUIRE_ENGINE"),
    reason="needs Node and the engine bundle (cd frontend && npm run build:engine)",
)


@pytest.fixture
def background_db(monkeypatch: pytest.MonkeyPatch, session_factory: sessionmaker[Session]) -> None:
    """Background tasks open their own session: point it at the test database."""
    monkeypatch.setattr(app_db, "SessionLocal", session_factory)


@pytest.fixture
def engine(monkeypatch: pytest.MonkeyPatch, background_db: None) -> None:
    """The real engine: Node and the bundle."""
    monkeypatch.setattr(settings, "engine_cli", str(ENGINE_CLI))
    monkeypatch.setattr(settings, "engine_node", NODE or "node")
    monkeypatch.setattr(settings, "engine_timeout_seconds", 60.0)


@pytest.fixture
def fake_engine(monkeypatch: pytest.MonkeyPatch, background_db: None, tmp_path: Path):
    """Install a Python script as the engine CLI; returns a function that sets its source."""

    def install(source: str, timeout: float = 20.0) -> Path:
        script = tmp_path / "fake-engine.py"
        script.write_text(source)
        monkeypatch.setattr(settings, "engine_cli", str(script))
        monkeypatch.setattr(settings, "engine_node", sys.executable)
        monkeypatch.setattr(settings, "engine_timeout_seconds", timeout)
        return script

    return install


# A fake CLI that answers every computed sheet with one indexed valve.
ECHO_ENGINE = """
import json, sys
request = json.load(sys.stdin)
results = []
for drawing in request["drawings"]:
    for sheet in drawing["sheets"]:
        if sheet.get("compute") is False:
            continue
        results.append({
            "sheetId": sheet["sheetId"], "ok": True,
            "index": {"items": [{"item_id": "v1", "kind": "symbol", "tag": "HV-FAKE"}]},
            "drc": {"findings": [], "checks": []},
        })
json.dump({"protocol": 1, "results": results}, sys.stdout)
"""


def _document(*items: dict) -> dict:
    return {
        "schemaVersion": 1,
        "sheet": {
            "size": "A3",
            "orientation": "landscape",
            "frame": {"kind": "basic", "columns": 4, "rows": 3, "margin": 10},
        },
        "layers": [],
        "items": list(items),
        "meta": {"grid": 2.5},
    }


def _symbol(item_id: str, key: str, x: float, y: float, **extra) -> dict:
    return {
        "id": item_id,
        "kind": "symbol",
        "layer": "symbols",
        "symbol": {"library": "fsdp", "key": key, "version": 1},
        "position": {"x": x, "y": y},
        "rotation": 0,
        "fields": {},
        **extra,
    }


def _line(item_id: str, *points: tuple[float, float], **extra) -> dict:
    return {
        "id": item_id,
        "kind": "line",
        "layer": "process",
        "points": [{"x": x, "y": y} for x, y in points],
        "lineType": "process",
        "fields": {},
        **extra,
    }


def _panel() -> dict:
    """Hand valve -> regulator on a numbered helium line."""
    return _document(
        _symbol("hv", "hand_valve", 80, 120, tag="HV-7701"),
        _symbol("pcv", "regulator", 130, 120, tag="PCV-7702"),
        _line("l1", (90, 120), (120, 120), lineNumber="GHE-7701", service="GHe", size='1/4"'),
    )


def _project(client: TestClient, name: str = "Stand") -> str:
    response = client.post("/projects", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _drawing(client: TestClient, project_id: str, document: dict | None = None) -> dict:
    body: dict = {"title": "Helium panel"}
    if document is not None:
        body["first_sheet"] = {"document": document}
    response = client.post(f"/projects/{project_id}/drawings", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _sheet(client: TestClient, sheet_id: str) -> dict:
    return client.get(f"/sheets/{sheet_id}").json()


def _index_tags(client: TestClient, sheet_id: str) -> list[str]:
    rows = client.get(f"/sheets/{sheet_id}/index").json()["items"]
    return sorted(row["tag"] for row in rows if row["tag"])


# --- Engine off: exactly as before -------------------------------------------------------


def test_engine_off_by_default(client: TestClient) -> None:
    assert settings.engine_cli == ""
    assert client.get("/engine/status").json() == {"enabled": False, "available": False}
    project_id = _project(client)
    drawing = _drawing(client, project_id, _panel())
    sheet_id = drawing["sheets"][0]["id"]
    # Nothing was scheduled: the sheet waits for the browser, as it always did.
    assert _sheet(client, sheet_id)["index_stale"] is True
    for path in (f"/projects/{project_id}/reindex", f"/drawings/{drawing['id']}/reindex"):
        response = client.post(path)
        assert response.status_code == 503
        assert "FSDP_ENGINE_CLI" in response.json()["detail"]
    assert _sheet(client, sheet_id)["index_stale"] is True
    assert client.post("/projects/nope/reindex").status_code == 404


def test_reindex_is_for_writers(client: TestClient, fake_engine) -> None:
    fake_engine(ECHO_ENGINE)
    project_id = _project(client)
    created = client.post(
        "/auth/users",
        json={
            "email": "viewer@fsdp.test",
            "name": "Viewer",
            "password": "viewer-password-1",
            "role": "viewer",
        },
    )
    assert created.status_code == 201, created.text
    viewer = TestClient(client.app)
    login = viewer.post(
        "/auth/login", json={"email": "viewer@fsdp.test", "password": "viewer-password-1"}
    )
    assert login.status_code == 200, login.text
    assert viewer.post(f"/projects/{project_id}/reindex").status_code == 403
    assert viewer.get("/engine/status").json()["enabled"] is True


# --- The real engine --------------------------------------------------------------------


@real_engine
def test_stored_rows_equal_what_the_browser_computes(
    client: TestClient, session_factory: sessionmaker[Session], engine: None
) -> None:
    """Replay the frontend's parity fixture from a database.

    `engine-parity.json` holds an engine request and the response the browser
    computes for it (kept in step by frontend/src/engine/cli.bundle.test.mjs). The
    same data goes into tables here; what the server stores must equal that response.
    """
    golden = json.loads(PARITY_FILE.read_text())
    context = golden["request"]["context"]
    drawing_in = golden["request"]["drawings"][0]
    expected = {result["sheetId"]: result for result in golden["response"]["results"]}
    project_id = _project(client)
    with session_factory() as db:
        for symbol in context["customSymbols"]:
            db.add(
                PidSymbolDef(
                    id=symbol["id"],
                    name=symbol["name"],
                    view_box=symbol["view_box"],
                    svg=symbol["svg"],
                    ports=symbol["ports"],
                    category=symbol["category"],
                    legend=symbol["legend"],
                    tag_prefix=symbol["tag_prefix"],
                )
            )
        for part in context["parts"]:
            db.add(Part(**part))
        db.add(TagScheme(project_id=project_id, scheme=context["tagScheme"]))
        drawing = Drawing(
            project_id=project_id,
            number="PID-0001",
            title="Parity",
            frame_template=drawing_in["frameTemplate"],
        )
        for sheet in drawing_in["sheets"]:
            drawing.sheets.append(
                DrawingSheet(
                    id=sheet["sheetId"],
                    sheet_no=sheet["sheetNo"],
                    document=sheet["document"],
                    index_stale=True,
                )
            )
        drawing.revisions.append(DrawingRevision(sequence=1))
        db.add(drawing)
        db.flush()
        for sheet in drawing_in["sheets"]:
            for waiver in sheet.get("waivers", []):
                db.add(DrcWaiver(sheet_id=sheet["sheetId"], **waiver))
        db.commit()
        # One row at a time so the project's requirements read back in the fixture's order.
        for requirement in context["requirements"]:
            db.add(
                Requirement(
                    project_id=project_id,
                    text=requirement["title"],
                    requirement_type="design",
                    **requirement,
                )
            )
            db.commit()

    response = client.post(f"/projects/{project_id}/reindex")
    assert response.status_code == 200, response.text
    assert response.json() == {
        "drawings": 1,
        "stale": 2,
        "indexed": 2,
        "skipped": 0,
        "failed": 0,
        "errors": [],
        "stale_sheets": [],
    }

    def without(rows: list[dict], *keys: str) -> list[dict]:
        return [{k: v for k, v in row.items() if k not in keys} for row in rows]

    def by(rows: list[dict], key: str) -> list[dict]:
        return sorted(rows, key=lambda row: json.dumps(row.get(key)))

    for sheet_id, result in expected.items():
        assert result["ok"] is True
        sheet = _sheet(client, sheet_id)
        assert sheet["index_stale"] is False
        assert sheet["indexed_at"] is not None
        stored = client.get(f"/sheets/{sheet_id}/index").json()
        assert by(without(stored["items"], "id", "sheet_id"), "item_id") == by(
            result["index"]["items"], "item_id"
        )
        assert by(without(stored["lines"], "id", "sheet_id"), "line_id") == by(
            result["index"]["lines"], "line_id"
        )
        drc = client.get(f"/sheets/{sheet_id}/drc").json()
        findings = [
            {
                "key": row["key"],
                "rule": row["rule"],
                "severity": row["severity"],
                "message": row["message"],
                "itemId": row["item_id"],
                "subject": row["subject"],
                "zone": row["zone"],
                "requirementId": row["requirement_id"],
            }
            for row in drc["findings"]
        ]
        wanted = [
            {**{"itemId": None, "subject": None, "zone": None, "requirementId": None}, **finding}
            for finding in result["drc"]["findings"]
        ]
        assert by(findings, "key") == by(wanted, "key")
        checks = [
            {
                "requirementId": row["requirement_id"],
                "itemId": row["item_id"],
                "subject": row["subject"],
                "zone": row["zone"],
                "status": row["status"],
                "message": row["message"],
            }
            for row in drc["checks"]
        ]

        def check_key(row: dict) -> str:
            return f"{row['requirementId']}:{row['itemId']}"

        assert sorted(checks, key=check_key) == sorted(result["drc"]["checks"], key=check_key)
        assert drc["counts"] == result["counts"]
    # Not a vacuous comparison: the custom symbol, the part, and the waiver came through.
    first = expected[drawing_in["sheets"][0]["sheetId"]]
    assert first["counts"]["waived"] == 1
    assert any(item["symbol_name"] == "Inline filter" for item in first["index"]["items"])
    assert any(finding["rule"] == "part_status" for finding in first["drc"]["findings"])


@real_engine
def test_create_copy_and_revise_index_in_the_background(client: TestClient, engine: None) -> None:
    assert client.get("/engine/status").json() == {"enabled": True, "available": True}
    project_id = _project(client)
    drawing = _drawing(client, project_id, _panel())
    sheet_id = drawing["sheets"][0]["id"]
    # No save from a browser: the background task indexed the new sheet.
    assert _sheet(client, sheet_id)["index_stale"] is False
    assert _index_tags(client, sheet_id) == ["HV-7701", "PCV-7702"]
    lines = client.get(f"/sheets/{sheet_id}/index").json()["lines"]
    assert [(line["line_number"], line["from_tag"], line["to_tag"]) for line in lines] == [
        ("GHE-7701", "HV-7701", "PCV-7702")
    ]

    other_project = _project(client, "Next stand")
    copied = client.post(f"/drawings/{drawing['id']}/copy", json={"project_id": other_project})
    assert copied.status_code == 201, copied.text
    copy_sheet = copied.json()["sheets"][0]["id"]
    assert _sheet(client, copy_sheet)["index_stale"] is False
    assert _index_tags(client, copy_sheet) == ["HV-7701", "PCV-7702"]
    hits = client.get("/search", params={"q": "PCV-7702", "project_id": other_project}).json()
    assert any(hit["kind"] == "tag" and hit["project_id"] == other_project for hit in hits["hits"])
    valves = client.get(f"/projects/{other_project}/lists/valve").json()
    assert valves["stale_sheets"] == []
    assert "HV-7701" in json.dumps(valves["rows"])

    # A second sheet with content, and a document saved without its index (an API client).
    added = client.post(
        f"/drawings/{drawing['id']}/sheets",
        json={"document": _document(_symbol("pt", "instrument", 100, 100, tag="PT-7703"))},
    )
    assert added.status_code == 201, added.text
    assert _index_tags(client, added.json()["id"]) == ["PT-7703"]
    edited = _panel()
    edited["items"][0]["tag"] = "HV-7709"
    saved = client.put(f"/sheets/{sheet_id}", json={"document": edited})
    assert saved.status_code == 200 and saved.json()["index_stale"] is True
    assert _sheet(client, sheet_id)["index_stale"] is False
    assert _index_tags(client, sheet_id) == ["HV-7709", "PCV-7702"]


@real_engine
def test_released_drawings_are_left_alone_until_revised(
    client: TestClient, session_factory: sessionmaker[Session], engine: None
) -> None:
    project_id = _project(client)
    drawing = _drawing(client, project_id, _document(_symbol("pt", "instrument", 100, 100)))
    sheet_id = drawing["sheets"][0]["id"]
    assert _sheet(client, sheet_id)["index_stale"] is False
    with session_factory() as db:
        db.get(Drawing, drawing["id"]).status = "released"
        # A frozen baseline whose flag is set anyway must still not be re-indexed.
        db.get(DrawingSheet, sheet_id).index_stale = True
        db.commit()
    report = client.post(f"/projects/{project_id}/reindex").json()
    assert (report["drawings"], report["indexed"]) == (0, 0)
    assert client.post(f"/drawings/{drawing['id']}/reindex").status_code == 409
    assert _sheet(client, sheet_id)["index_stale"] is True

    revised = client.post(f"/drawings/{drawing['id']}/revise")
    assert revised.status_code == 200, revised.text
    # revise flags every sheet stale; the background task refreshed it.
    assert _sheet(client, sheet_id)["index_stale"] is False


@real_engine
def test_a_sheet_the_engine_cannot_read_is_reported_and_stays_stale(
    client: TestClient, engine: None
) -> None:
    project_id = _project(client)
    drawing = _drawing(client, project_id, _panel())
    broken = {
        "schemaVersion": 1,
        "sheet": {"size": "A3"},
        "items": [{"id": "x", "kind": "symbol", "tag": "HV-1"}],
    }
    added = client.post(f"/drawings/{drawing['id']}/sheets", json={"document": broken})
    assert added.status_code == 201, added.text
    report = client.post(f"/drawings/{drawing['id']}/reindex").json()
    assert (report["stale"], report["indexed"], report["failed"]) == (1, 0, 1)
    assert report["errors"][0]["sheet_no"] == 2
    assert "document" in report["errors"][0]["message"]
    assert [entry["sheet_no"] for entry in report["stale_sheets"]] == [2]
    # The good sheet was indexed by the task that followed its creation.
    assert _sheet(client, drawing["sheets"][0]["id"])["index_stale"] is False


# --- Not clobbering a concurrent save ---------------------------------------------------


def test_a_save_during_the_engine_run_wins(
    client: TestClient, fake_engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = _project(client)
    drawing = _drawing(client, project_id, _panel())
    sheet_id = drawing["sheets"][0]["id"]
    fake_engine(ECHO_ENGINE)
    real_run = server_index.run_engine
    browser_index = {"items": [{"item_id": "hv", "kind": "symbol", "tag": "HV-BROWSER"}]}

    def run_then_save(request: dict) -> dict:
        results = real_run(request)
        # While "Node" ran, the editor saved the sheet with its own index.
        document = copy.deepcopy(request["drawings"][0]["sheets"][0]["document"])
        document["items"][0]["tag"] = "HV-BROWSER"
        saved = client.put(
            f"/sheets/{sheet_id}",
            json={"document": document, "index": browser_index, "drc": {"findings": []}},
        )
        assert saved.status_code == 200, saved.text
        return results

    monkeypatch.setattr(server_index, "run_engine", run_then_save)
    report = client.post(f"/projects/{project_id}/reindex").json()
    assert (report["stale"], report["indexed"], report["skipped"], report["failed"]) == (1, 0, 1, 0)
    assert _index_tags(client, sheet_id) == ["HV-BROWSER"]
    assert _sheet(client, sheet_id)["index_stale"] is False


def test_a_change_of_the_document_during_the_engine_run_leaves_the_sheet_stale(
    client: TestClient,
    session_factory: sessionmaker[Session],
    fake_engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id = _project(client)
    drawing = _drawing(client, project_id, _panel())
    sheet_id = drawing["sheets"][0]["id"]
    fake_engine(ECHO_ENGINE)
    real_run = server_index.run_engine

    def run_then_edit(request: dict) -> dict:
        results = real_run(request)
        with session_factory() as db:
            sheet = db.get(DrawingSheet, sheet_id)
            sheet.document = {**sheet.document, "items": sheet.document["items"][:1]}
            db.commit()
        return results

    monkeypatch.setattr(server_index, "run_engine", run_then_edit)
    report = client.post(f"/drawings/{drawing['id']}/reindex").json()
    assert (report["indexed"], report["skipped"]) == (0, 1)
    assert [entry["sheet_id"] for entry in report["stale_sheets"]] == [sheet_id]
    assert _index_tags(client, sheet_id) == []

    # The next run sees the new document and stores its result.
    monkeypatch.setattr(server_index, "run_engine", real_run)
    report = client.post(f"/drawings/{drawing['id']}/reindex").json()
    assert (report["indexed"], report["stale_sheets"]) == (1, [])
    assert _index_tags(client, sheet_id) == ["HV-FAKE"]


def test_request_holds_what_the_browser_would(
    client: TestClient, session_factory: sessionmaker[Session], fake_engine, tmp_path: Path
) -> None:
    """The gathered inputs: only referenced parts and symbols, siblings as context."""
    seen = tmp_path / "request.json"
    fake_engine(
        ECHO_ENGINE.replace(
            "request = json.load(sys.stdin)",
            f"request = json.load(sys.stdin)\nopen({str(seen)!r}, 'w').write(json.dumps(request))",
        )
    )
    project_id = _project(client)
    with session_factory() as db:
        used = Part(part_number="HV-1", description="Hand valve", part_type="valve")
        unused = Part(part_number="HV-2", description="Other valve", part_type="valve")
        symbol = PidSymbolDef(name="Filter", svg="<rect/>", ports=[], category="inline")
        other_symbol = PidSymbolDef(name="Unused", svg="<rect/>", ports=[])
        db.add_all([used, unused, symbol, other_symbol])
        db.add(TagScheme(project_id=project_id, scheme={"kind": "structured"}))
        db.add(
            Requirement(
                project_id=project_id,
                key="REQ-1",
                title="Relief",
                text="Relief on every volume",
                requirement_type="design",
                constraint={"kind": "relief_required", "values": []},
            )
        )
        db.commit()
        part_id, symbol_id = used.id, symbol.id
    document = _panel()
    document["items"][0]["partId"] = part_id
    document["items"][1]["symbol"] = {"library": "custom", "key": symbol_id, "version": 1}
    settings_cli = settings.engine_cli
    settings.engine_cli = ""  # create without the background task
    try:
        drawing = _drawing(client, project_id, document)
        second = client.post(f"/drawings/{drawing['id']}/sheets", json={}).json()
    finally:
        settings.engine_cli = settings_cli
    first_id = drawing["sheets"][0]["id"]
    with session_factory() as db:
        db.add(DrcWaiver(sheet_id=first_id, key="open_port:hv:in", reason="capped"))
        db.commit()

    report = client.post(f"/projects/{project_id}/reindex").json()
    assert (report["stale"], report["indexed"]) == (1, 1)
    request = json.loads(seen.read_text())
    context = request["context"]
    assert [part["id"] for part in context["parts"]] == [part_id]
    assert [(entry["id"], entry["svg"]) for entry in context["customSymbols"]] == [(symbol_id, "")]
    assert context["tagScheme"] == {"kind": "structured"}
    assert [entry["key"] for entry in context["requirements"]] == ["REQ-1"]
    (drawing_in,) = request["drawings"]
    assert drawing_in["frameTemplate"] == "fsdp-standard"
    assert [(sheet["sheetId"], sheet["compute"]) for sheet in drawing_in["sheets"]] == [
        (first_id, True),
        (second["id"], False),
    ]
    assert drawing_in["sheets"][0]["waivers"] == [{"key": "open_port:hv:in", "reason": "capped"}]
    assert drawing_in["sheets"][0]["document"] == document
    # Stored as a save would: the change log names the server run.
    changes = client.get("/changes", params={"limit": 5}).json()
    assert any("Re-indexed sheet 1" in change["summary"] for change in changes)


# --- Engine failures: reported per sheet, sheets stay stale ----------------------------------


def _stale_drawing(client: TestClient) -> tuple[str, str, str]:
    """A drawing with one stale sheet, created while the engine is off."""
    project_id = _project(client)
    drawing = _drawing(client, project_id, _panel())
    return project_id, drawing["id"], drawing["sheets"][0]["id"]


def _failed(client: TestClient, project_id: str, sheet_id: str) -> str:
    response = client.post(f"/projects/{project_id}/reindex")
    assert response.status_code == 200, response.text
    report = response.json()
    assert (report["stale"], report["indexed"], report["failed"]) == (1, 0, 1)
    assert [entry["sheet_id"] for entry in report["stale_sheets"]] == [sheet_id]
    assert _sheet(client, sheet_id)["index_stale"] is True
    assert _index_tags(client, sheet_id) == []
    (error,) = report["errors"]
    assert error["sheet_id"] == sheet_id and error["sheet_no"] == 1
    return error["message"]


def test_engine_timeout(client: TestClient, fake_engine) -> None:
    project_id, _drawing_id, sheet_id = _stale_drawing(client)
    fake_engine("import time\ntime.sleep(30)\n", timeout=0.5)
    assert "timed out after 0.5 s" in _failed(client, project_id, sheet_id)


def test_engine_non_zero_exit_logs_stderr(
    client: TestClient, fake_engine, caplog: pytest.LogCaptureFixture
) -> None:
    project_id, _drawing_id, sheet_id = _stale_drawing(client)
    fake_engine("import sys\nsys.stderr.write('boom: out of cheese\\n')\nsys.exit(3)\n")
    with caplog.at_level(logging.WARNING, logger="app.services.server_index"):
        message = _failed(client, project_id, sheet_id)
    assert "exited with code 3" in message and "out of cheese" in message
    assert "out of cheese" in caplog.text


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("print('not json at all')", "not valid JSON"),
        ("print('{\"protocol\": 99, \"results\": []}')", "unexpected shape"),
        ("print('[]')", "unexpected shape"),
        ("print('{\"protocol\": 1, \"results\": []}')", "no result for the sheet"),
    ],
)
def test_engine_bad_output(client: TestClient, fake_engine, source: str, expected: str) -> None:
    project_id, _drawing_id, sheet_id = _stale_drawing(client)
    fake_engine(source)
    assert expected in _failed(client, project_id, sheet_id)


def test_engine_result_must_pass_the_save_schemas(client: TestClient, fake_engine) -> None:
    project_id, _drawing_id, sheet_id = _stale_drawing(client)
    fake_engine(ECHO_ENGINE.replace('"kind": "symbol"', '"kind": "gremlin"'))
    message = _failed(client, project_id, sheet_id)
    assert "failed validation" in message and "kind" in message


def test_engine_per_sheet_error_does_not_stop_the_others(client: TestClient, fake_engine) -> None:
    project_id, drawing_id, first_id = _stale_drawing(client)
    second = client.post(
        f"/drawings/{drawing_id}/sheets", json={"document": _panel()}
    ).json()
    fake_engine(
        ECHO_ENGINE.replace(
            "        results.append({",
            "        if sheet['sheetNo'] == 1:\n"
            "            results.append({'sheetId': sheet['sheetId'], 'ok': False,"
            " 'error': 'bad geometry'})\n"
            "            continue\n"
            "        results.append({",
        )
    )
    report = client.post(f"/projects/{project_id}/reindex").json()
    assert (report["stale"], report["indexed"], report["failed"]) == (2, 1, 1)
    assert report["errors"][0]["message"] == "bad geometry"
    assert _sheet(client, first_id)["index_stale"] is True
    assert _sheet(client, second["id"])["index_stale"] is False


def test_missing_bundle_or_node(
    client: TestClient, fake_engine, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project_id, _drawing_id, sheet_id = _stale_drawing(client)
    fake_engine(ECHO_ENGINE)
    monkeypatch.setattr(settings, "engine_node", str(tmp_path / "no-such-node"))
    assert "could not be started" in _failed(client, project_id, sheet_id)
    monkeypatch.setattr(settings, "engine_cli", str(tmp_path / "missing.mjs"))
    assert client.get("/engine/status").json() == {"enabled": True, "available": False}
    assert "bundle not found" in _failed(client, project_id, sheet_id)


def test_oversized_request_is_refused(
    client: TestClient, fake_engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, _drawing_id, sheet_id = _stale_drawing(client)
    fake_engine(ECHO_ENGINE)
    monkeypatch.setattr(server_index, "MAX_REQUEST_BYTES", 100)
    assert "the limit is 100" in _failed(client, project_id, sheet_id)


def test_background_failure_is_best_effort(
    client: TestClient, fake_engine, session_factory: sessionmaker[Session]
) -> None:
    fake_engine("import sys\nsys.exit(1)\n")
    project_id = _project(client)
    # The request succeeds; the sheet is simply still stale.
    drawing = _drawing(client, project_id, _panel())
    sheet_id = drawing["sheets"][0]["id"]
    assert _sheet(client, sheet_id)["index_stale"] is True
    with session_factory() as db:
        assert db.scalars(select(SheetItem).where(SheetItem.sheet_id == sheet_id)).all() == []
    fake_engine(ECHO_ENGINE)
    copied = client.post(f"/drawings/{drawing['id']}/copy")
    assert copied.status_code == 201, copied.text
    assert _index_tags(client, copied.json()["sheets"][0]["id"]) == ["HV-FAKE"]
    # Only the copy was scheduled; the source waits for its own trigger.
    assert _sheet(client, sheet_id)["index_stale"] is True
