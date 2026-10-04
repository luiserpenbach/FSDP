# FSDP Implementation Guide

## Repository Structure

```text
FSDP/
  backend/
    alembic/                 Database migrations
    app/
      api/routes.py          FastAPI route handlers
      core/config.py         Runtime settings
      db.py                  SQLAlchemy engine/session dependency
      main.py                FastAPI app entry point
      models.py              SQLAlchemy domain model
      schemas.py             Pydantic request/response schemas
      services/              BoM, traceability, catalog, and impact services
    tests/                   Backend unit and API workflow tests
  frontend/
    src/
      App.tsx                MVP workspace UI
      api.ts                 Frontend API client
      types.ts               Frontend domain types
      styles.css             Application styles
      engine/                Schematic engine (paper-space P&ID document model, tools, renderer)
      components/schematic/  React host for the engine (SVG viewport)
      pages/DraftingPage.tsx Drafting page (preview editor built on the engine)
  docs/
    architecture.md          Architecture overview
    implementation.md        Current implementation guide
    requirements.md          Product requirements and MVP scope
  infra/
    README.md                Infrastructure notes
  docker-compose.yml         Local PostgreSQL service
  README.md                  Project entry point and local setup
```

## Runtime Architecture

FSDP is currently implemented as a split web application:

- Backend: FastAPI, SQLAlchemy, Alembic, PostgreSQL.
- Frontend: React, TypeScript, Vite; Drafting runs on the in-house schematic engine in `frontend/src/engine/`.
- Local infrastructure: Docker Compose for PostgreSQL.

```mermaid
flowchart LR
  Browser[Browser] --> Frontend[React Vite App]
  Frontend --> ApiClient[API Client]
  ApiClient --> Backend[FastAPI]
  Backend --> Services[Domain Services]
  Services --> Database[(PostgreSQL)]
  Backend --> OpenApi[OpenAPI Docs]
```

The backend owns all persisted domain objects and business rules. The frontend currently provides a single MVP workspace that exercises the connected design workflow.

## Backend

### Entry Points

- `backend/app/main.py` creates the FastAPI app, configures CORS, registers routes, and exposes `/health`.
- `backend/app/api/routes.py` contains the current REST API.
- `backend/app/db.py` provides SQLAlchemy session management through FastAPI dependency injection.
- `backend/app/core/config.py` reads settings from environment variables with the `FSDP_` prefix.

Default database URL:

```text
postgresql+psycopg://fsdp:fsdp@localhost:5432/fsdp
```

Override with:

```powershell
$env:FSDP_DATABASE_URL = "postgresql+psycopg://user:password@host:5432/database"
```

### Data Model

The current relational model is defined in `backend/app/models.py`.

Core tables:

- `projects`: top-level engineering project.
- `fluid_systems`: project-owned fluid systems.
- `drawings`, `drawing_sheets`, `drawing_revisions`: controlled P&ID drawings authored in Drafting (see "Schematic Engine" below).
- `diagrams`, `diagram_nodes`, `diagram_edges`, `component_instances`: legacy diagrams from the retired React Flow editor. Read-only: kept so Drafting can convert them and so old BoMs and trace links stay readable.
- `parts`: internal or vendor catalog parts.
- `requirements`: project-level requirements.
- `trace_links`: typed links between requirements, components, and other object types.
- `bom_snapshots`: generated BoM rows for a drawing (or, as history, a legacy diagram) at a point in time.
- `change_events`: simple audit/change records used by change impact views.

Important modeling choices:

- `Diagram.graph` keeps the legacy React Flow payload that Drafting's converter reads; no endpoint writes legacy diagrams any more.
- `Part.metadata_` maps to the database column named `metadata` to avoid colliding with SQLAlchemy's reserved `metadata` attribute.

### Services

Service modules live in `backend/app/services/`.

- `bom.py`: rolls a drawing's sheet index up into BoM snapshot rows.
- `traceability.py`: returns trace links for an object in either source or target direction.
- `change_impact.py`: identifies linked objects, affected components, and affected BoM snapshots.
- `catalog.py`: contains early catalog-quality warnings for missing qualification data.

### API Summary

The backend exposes OpenAPI documentation at:

```text
http://localhost:8000/docs
```

Implemented endpoint groups:

Projects:

- `POST /projects`
- `GET /projects`
- `GET /projects/{project_id}`
- `PUT /projects/{project_id}`
- `DELETE /projects/{project_id}`

Fluid systems:

- `POST /projects/{project_id}/systems`
- `GET /projects/{project_id}/systems`
- `PUT /systems/{system_id}`
- `DELETE /systems/{system_id}`

Drawings, sheets, revisions, lists, and DRC: see "Schematic Engine" below; `GET /projects/{project_id}/sheet-items` lists the tagged items of a project's saved sheets (trace-link targets).

Legacy diagrams (read-only; converted into drawings on the Drafting page):

- `GET /systems/{system_id}/diagrams`
- `GET /projects/{project_id}/diagrams` (every system, without graphs)
- `GET /diagrams/{diagram_id}`
- `GET /diagrams/{diagram_id}/schematic`
- `GET /diagrams/{diagram_id}/components`
- `DELETE /diagrams/{diagram_id}` (clean-up after conversion)

Parts:

- `POST /parts`
- `GET /parts`
- `GET /parts/{part_id}`
- `PUT /parts/{part_id}`
- `DELETE /parts/{part_id}`

Requirements:

- `POST /requirements`
- `GET /projects/{project_id}/requirements`
- `PUT /requirements/{requirement_id}`
- `DELETE /requirements/{requirement_id}`

Traceability:

- `POST /trace-links` (new links to legacy `diagram`/`component` objects are refused)
- `DELETE /trace-links/{link_id}`
- `GET /objects/{object_type}/{object_id}/trace`

BoM:

- `POST /drawings/{drawing_id}/bom`
- `GET /drawings/{drawing_id}/bom`
- `GET /diagrams/{diagram_id}/bom` (legacy history)
- `GET /projects/{project_id}/bom`
- `PUT /bom/{snapshot_id}/status` (drawing BoMs; legacy snapshots are read-only)
- `GET /bom/{snapshot_id}/readiness`, `/diff`, `/csv`, `/xlsx`

Change impact:

- `GET /changes/impact?object_type=...&object_id=...`

### Validation and Error Handling

Current explicit validations:

- Duplicate project names return `409`.
- Duplicate part numbers return `409`.
- Duplicate requirement keys within a project return `409`.
- Trace links validate that both endpoints exist and belong to the same project (catalog parts are shared).

Future validation should add stronger field constraints, engineering-unit validation, and object-type validation for trace links.

## Frontend

### Entry Points

- `frontend/src/main.tsx` mounts the React app and imports the fonts and styles.
- `frontend/src/App.tsx` contains the current MVP workspace.
- `frontend/src/api.ts` wraps backend HTTP calls.
- `frontend/src/types.ts` defines frontend data types aligned with backend responses.
- `frontend/src/styles.css` contains layout and interaction styling.

### MVP Workspace Flow

The current page supports this workflow:

1. Create, select, update, or delete a project.
2. Create, select, update, or delete a fluid system under the active project.
3. Create drawings on the Drafting page (or convert a legacy diagram), draw sheets, and save them.
4. Draw or import custom symbols from the Drafting library panel.
5. Create, select, update, or delete catalog parts, and assign them to drawing items.
6. Create, select, update, or delete requirements.
7. Trace a requirement to a tagged drawing item or a whole drawing.
8. Generate drawing BoM snapshots and download CSV/XLSX.
9. Inspect the change impact of a part or requirement and open affected tags in Drafting.

### Legacy Diagrams

Diagrams drawn in the retired React Flow editor are import-only. The Drafting page lists every legacy diagram of the project (`GET /projects/{project_id}/diagrams`), converts the selected one with `engine/convert.ts` (from its stored schematic document when present, else from `Diagram.graph`), and creates a drawing whose first sheet records `source_diagram_id`. A one-time hint names unconverted diagrams; converted ones can be deleted from the convert form. Their components, trace links, and diagram BoM snapshots remain readable history.

## Local Development

Start PostgreSQL:

```powershell
docker compose up -d db
```

Run backend:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload
```

Run frontend:

```powershell
cd frontend
npm install
npm run dev
```

Default URLs:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:8000`
- Backend OpenAPI: `http://localhost:8000/docs`

## Verification

Backend:

```powershell
cd backend
python -m pytest
python -m ruff check .
```

Frontend:

```powershell
cd frontend
npm test
npm run build
```

Current backend tests cover:

- BoM rollup.
- Traceability lookup.
- Change impact lookup.
- Catalog warnings.
- Legacy diagram reads, the removed write endpoints, and the demo seed (`test_legacy_diagrams.py`).
- Duplicate validation and delete flow.

## Current Limitations

- The frontend is still a single-page MVP workspace, not a production navigation model.
- There is no authentication, authorization, or role-based approval workflow.
- Change impact is shallow and only follows direct trace links plus part/component BoM usage.
- Engineering analysis modules are not implemented yet.
- Configuration baselines, branches, and releases are not implemented yet.
- Certification package generation is not implemented beyond BoM CSV export and future-oriented stubs.

## Recommended Next Implementation Areas

1. Add pressure-drop analysis for simple incompressible line networks.
2. Introduce hazard objects linked to components, lines, and requirements.
3. Add trapped-volume detection from valve states and graph connectivity.
4. Add relief valve sizing with stored assumptions and calculation reports.
5. Add verification matrix views from requirements and trace links.
6. Add release/baseline snapshots for diagrams, BoMs, requirements, and analyses.

## Schematic Engine (Drafting page)

The Drafting page is the first slice of the [P&ID professional upgrade plan](pid-professional-upgrade-plan.md). It is built on a framework-free TypeScript engine in `frontend/src/engine/`:

- **Document** (`types.ts`): JSON schema v1 in paper-space millimetres. Items are symbols (library references pinned to a version), lines (orthogonal polylines), equipment boundaries, labels, and review notes. Connectivity is derived from geometry: a line end on a port or on another line is connected (`connectivity.ts`), and junction dots are computed, never drawn.
- **Commands** (`commands.ts`, `store.ts`): every edit is a serialisable command with an exact inverse; the store keeps undo/redo and dirtiness. Drags coalesce into one undo step.
- **Renderer** (`render.ts`): one renderer produces SVG markup for the canvas and for export at paper size (`renderDocumentSvg`), so the screen and the file never drift.
- **Editor** (`editor.ts`): tool state machines for select/move, wire, place, label, equipment, and note, driven by pointer events in mm and a KiCad-style key map (W wire, R rotate, X mirror, Esc cancel, Ctrl+D duplicate, arrows nudge).
- **Converter** (`convert.ts`): turns a legacy React Flow `graph` into a document when a legacy diagram is converted into a drawing; item ids are preserved.

**Drawings** (`backend/app/api/drawing_routes.py`, migration `0008`): a drawing (`/projects/{id}/drawings`) has a number, up to three title lines, size, units, status, frame template, title-block fields, and general notes; it owns numbered sheets (`/drawings/{id}/sheets`, each with a schematic document) and revisions (`/drawings/{id}/revisions`). Frame templates (`frontend/src/engine/frames.ts`) bind those rows into the title block, revision table, notes block, and proprietary notice when the sheet renders.

**Symbol library** (`frontend/src/engine/builtinSymbols.ts`, `library.ts`): 104 built-in ISA/ISO symbols with typed ports, legend text, and tag letters; valve bodies accept a composed actuator (`SymbolItem.actuator`) whose signal port joins the body's ports through `registry.portsOf`. Custom symbols from `/symbols` carry `category`, `legend`, and `tag_prefix` (migration `0009`). The Drafting page's library panel browses, searches, previews, and places symbols; writers create, edit, and delete custom symbols there in the symbol editor (`components/schematic/SymbolEditorModal.tsx`), which strips editor metadata such as Inkscape's `sodipodi:`/`inkscape:` markup (`engine/svgSanitize.ts`, mirroring the server's allowlist in `clean_symbol_svg`).

**Tag schemes** (`frontend/src/engine/tags.ts`, `GET/PUT /projects/{id}/tag-scheme`): per-project simple (`HV-12`) or structured (`PT 3222`) tags; the editor suggests, validates, and renumbers tags; the Settings page edits the scheme. The frame renderer can print a symbol legend and the ISA letter table when the drawing enables them.

**Lines, nozzles, connectors** (`frontend/src/engine/lines.ts`, `connectors.ts`): lines carry class, conditions, and inline annotations that follow the line; crossings between unconnected lines render as hops; equipment boundaries expose nozzles as ports; off-page connectors resolve to the sheet and zone of their pair across the drawing's sheets. Project line classes live in `line_classes` (`/projects/{id}/line-classes`, CSV import) and are managed on the Settings page.

**Sheet index and lists** (`sheet_items`, `sheet_lines`, migration `0011`; `frontend/src/engine/index.ts`, `lists.ts`; `app/services/sheet_index.py`, `lists.py`): saving a sheet sends normalized item and line rows built by the engine (zone, tag, category, assigned part, DNP/spares, connected line data; line from/to, conditions, lengths, connections). `GET /drawings/{id}/lists/{kind}` and `GET /projects/{id}/lists/{kind}` serve the instrument index, line list, valve list, equipment list, and tie-in list as JSON, CSV, or XLSX (`?format=`) with a drawing header and zone column. The Drafting page's lists drawer shows the live lists, locates rows on the sheet, and exports.

**Drawing BoM and parts** (`POST /drawings/{id}/bom`, `app/services/bom.py`; `components/schematic/AssignPartModal.tsx`, `engine/parts.ts`): BoM snapshots from the sheet index roll tagged items up by assigned part (`SymbolItem.partId`), list DNP items without counting them, add spares, and add tubing/fitting/tee bulk rows from lines; readiness issues carry codes and severities. Parts are assigned from the inspector with warn-only checks; the canvas shows part badges (not exported) and the catalog's where-used panel lists drawing placements. XLSX export uses openpyxl.

**Design rule checks and requirements** (`frontend/src/engine/drc.ts`, `sizes.ts`, `drcSheet.ts`; `components/schematic/DrcPanel.tsx`; `app/services/drc.py`, migration `0012`): the engine checks connectivity, tags, line data, port sizes, spec continuity, part status and rating, relief coverage of isolable volumes, and requirement constraints (`requirements.constraint`). Findings carry a stable key; saving a sheet stores them and the per-item requirement checks (`drc_results`, `drc_requirement_checks`); waivers by key live in `drc_waivers` (`PUT/DELETE /sheets/{id}/drc/waivers`). `GET /sheets/{id}/drc`, `GET /drawings/{id}/drc`, and `GET /projects/{id}/verification-matrix` serve counts, findings, and the requirement verdicts; trace links accept `drawing`, `sheet_item`, and `sheet_line` targets. The PDF export accepts extra SVG pages (merged with pypdf) for the findings sheet.

**Export** (`POST /sheets/{id}/export`): the browser renders the sheet SVG with the shared renderer and the server converts it with Cairo (`app/services/export.py`) to PDF at paper size or PNG at a DPI; the image installs `libcairo2`.

Legacy persistence: `GET /diagrams/{id}/schematic` reads a schematic document stored on a legacy diagram by earlier builds (`diagrams.schematic`, migration `0007`); "Convert diagram…" on the Drafting page uses it as the source when present, else converts the React Flow `graph`.

Tests: `npx vitest run src/engine` covers geometry, library grid conformance, undo/redo (including a randomised inverse property), connectivity, routing, snapping, hit testing, conversion, rendering, frame templates, and the editor tools; `src/pages/DraftingPage.test.tsx` covers opening a sheet with a bound title block, saving, converting a diagram, the symbol editor, deep links, and exporting; `backend/tests/test_drawings.py` and `test_legacy_diagrams.py` cover the API including PDF/PNG export.
