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

Search:

- `GET /search?q=...&project_id=...&limit=...`: tags, line numbers, drawings, parts,
  requirements, systems, and projects across all projects. Hits are ranked exact, then
  prefix, then substring; `project_id` only orders hits of that project first; `limit`
  caps hits per kind. Each hit carries the ids needed to open it (project, drawing,
  sheet, item). The frontend's Ctrl+K palette is built on it.

Reuse:

- `POST /drawings/{drawing_id}/copy` with optional `project_id`, `system_id`, `number`,
  `title`: copies a drawing (released ones included) with all sheets into a new draft at
  its first revision, in the same or another project. Tags, part assignments, and line
  data are copied; approvals, revision history, DRC waivers, and trace links are not.
  Sheets with content are flagged stale so they are re-indexed and re-checked against
  the destination project's tag scheme, line classes, and requirements: by the server
  right after the copy when `FSDP_ENGINE_CLI` is set, else when the copy is opened.

Server-side index (see "Server-side index and DRC" below):

- `GET /engine/status`: `{enabled, available}` — whether this server runs the engine
  itself (`FSDP_ENGINE_CLI` set, bundle present).
- `POST /projects/{project_id}/reindex` (writers): re-indexes and re-checks every stale
  sheet of the project's unreleased drawings; returns `drawings`, `stale`, `indexed`,
  `skipped`, `failed`, `errors` (per sheet), and the `stale_sheets` that remain.
- `POST /drawings/{drawing_id}/reindex` (writers): the same for one drawing; 409 for a
  released drawing. Both return 503 when the engine is not configured.

Project access (see `backend/app/core/access.py`):

- `GET /projects/{project_id}/access`: the restriction, the members, and what the caller
  may do (`can_write`, `can_manage`).
- `PUT /projects/{project_id}/access` (`restricted`), `PUT` and `DELETE
  /projects/{project_id}/members/{user_id}` (`role`: viewer, engineer, owner): owners and
  administrators only. A members-only project keeps at least one owner.
- `GET /users/directory`: active accounts, for picking members (writers).
- Every data route is checked by one router-level dependency, `enforce_project_access`,
  which resolves the project from the path parameter names (`project_id`, `system_id`,
  `drawing_id`, `sheet_id`, `revision_id`, `requirement_id`, `snapshot_id`,
  `line_class_id`, `diagram_id`, `link_id`). **A new route for a project-owned object
  must use one of these names or register its own with `register_path_resolver`**;
  handlers that take a project in the body, or return rows from several projects, call
  `require_project_write` / `hidden_project_ids` themselves. A project the caller may not
  see answers 404.

Lineage:

- `GET /drawings/{drawing_id}/lineage`: the source a drawing was copied from (omitted if
  deleted or not visible to the caller; the number and revision at the time of the copy
  stay on the drawing) and the copies taken of it.
- `GET /drawings/{drawing_id}/lineage/diff`: added, removed, and changed items and lines
  of a copy against its source as both stand now, matched by sheet number and document
  id, with the sheets whose index is stale named.

Paging:

- `GET /parts` accepts `limit` (up to 2000), `offset`, and `sort` (a column name, `-` for
  descending) next to its filters and reports the number of matches in `X-Total-Count`.
- `GET /changes` accepts `limit`, `offset`, and `project_id`, with `X-Total-Count`.

Single sign-on:

- `GET /auth/config` (public): whether SSO is on and what the button says.
- `GET /auth/sso/login` redirects to the provider (authorization code flow with PKCE,
  state, and nonce held in a short-lived signed cookie); `GET /auth/sso/callback` verifies
  the ID token against the provider's keys, issuer, audience, and nonce, matches or
  creates the account by verified email, and starts the same cookie session as a
  password sign-in. Failures return to the frontend with `?sso_error=`.

API tokens and sign-in:

- `GET /auth/tokens`, `POST /auth/tokens` (`name`, optional `expires_in_days`),
  `DELETE /auth/tokens/{token_id}`: personal access tokens for scripts and integrations.
  The secret (`fsdp_pat_...`) is returned once and stored only as a SHA-256 hash. Send
  it as `Authorization: Bearer <token>`; the request then runs as the token's owner with
  that user's role, and stops working when the token is revoked or expires, or the user
  is deactivated.
- `POST /auth/login` locks an account for `FSDP_LOGIN_LOCK_MINUTES` after
  `FSDP_LOGIN_MAX_FAILURES` consecutive failures (429 while locked). An admin password
  reset or reactivation lifts the lock.

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
npm run lint
npm run build
npm run build:engine   # bundles the engine CLI to dist-engine/engine-cli.mjs
```

`backend/tests/test_server_index.py` runs the real engine when Node and
`frontend/dist-engine/engine-cli.mjs` exist (build it first; the tests are skipped
otherwise, and CI builds it and sets `FSDP_REQUIRE_ENGINE=1` so they cannot skip there).

Current backend tests cover:

- BoM rollup.
- Traceability lookup.
- Change impact lookup.
- Catalog warnings.
- Legacy diagram reads, the removed write endpoints, and the demo seed (`test_legacy_diagrams.py`).
- Duplicate validation and delete flow.

## Current Limitations

Status as of 2026-11. The single-project workflow (draft, check, release, BoM, change
impact) is complete; the gaps below are what stands between it and use by a large
organization with many projects and hundreds of engineers.

- **Single tenant.** One organization per deployment; SSO is OpenID Connect only (no
  SAML), and accounts are not provisioned or removed by SCIM. Group claims from the
  identity provider are not mapped to roles or project membership.
- **Access is per project, not per drawing or per field.** The shared parts catalog and
  symbol library are visible to every signed-in user.
- **The parts catalog is still held in the browser.** It is fetched in pages of 1,000 and
  the API sorts and pages (`limit`, `offset`, `sort`), but the catalog grid, the part
  pickers in Drafting, and the DRC work on the whole list in memory. A catalog well beyond
  roughly 50k parts needs the grid and pickers to query the server instead.
- **Search is a substring scan** (`ILIKE`) across seven tables. Add trigram indexes
  (`pg_trgm`) or a search service before the index tables reach millions of rows.
- **One editor per sheet at a time.** Saves are versioned, so a second writer gets a
  conflict rather than overwriting, but there is no presence, locking, or merge.
- **The server-side index is opt-in and partial.** With `FSDP_ENGINE_CLI` set, new,
  copied, and revised drawings are indexed and checked by the server; sheets flagged
  stale by a part or requirement change still wait for `POST /projects/{id}/reindex`
  (the "Re-index project" action) or for someone to open the drawing. Without the
  setting everything is computed in the browser, as before.
- **Lineage compares, it does not merge.** A copy records its source and can be
  compared with it, but changes are carried over by hand; there is no "update from
  template".
- **Tag uniqueness is per drawing**, not per project.
- **Sign-in lockout is per account**, with no per-IP throttling; put the API behind a
  rate-limiting proxy when it is exposed to the internet.
- Engineering analysis (pressure drop, relief sizing, trapped volume), hazards, and
  certification packages are not implemented.

## Recommended Next Implementation Areas

1. Map identity-provider groups to project membership; SCIM provisioning.
2. A server-backed catalog grid and part pickers (the API already pages and sorts).
3. Re-index on the server after part and requirement changes too, and make the engine
   the default, so lists, search, and checks never depend on a browser.
4. Apply selected changes from a template to its copies.
5. Pressure-drop analysis for simple incompressible line networks.
6. Hazard objects linked to components, lines, and requirements.
7. Trapped-volume detection from valve states and graph connectivity.
8. Relief valve sizing with stored assumptions and calculation reports.

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

### Release workflow

A drawing and its current revision move through three states, changed only by explicit actions (`PUT /drawings/{id}` with a different `status` is refused with 422):

| State | Actions (writers) | Endpoint | Stamps |
|---|---|---|---|
| `draft` | Submit for review, Release | `POST /drawings/{id}/submit`, `/release` | `submitted_by/at` on submit |
| `in_review` | Withdraw (back to draft), Release | `POST /drawings/{id}/withdraw`, `/release` | |
| `released` | Start new revision (optional label and description; the label defaults to the next letter, `-`→`A`→`B`, `Z`→`AA`) | `POST /drawings/{id}/revise` | `drawn_by/date` on the new revision |

- **Signatures are server-stamped.** Release records `approved_by/at/date` from the signed-in user; `checked_by`/`approved_by` in revision requests are rejected (422). The Drafting revision table shows the drawn / submitted / approved stamps read-only.
- **Release gate.** `POST /release` returns 409 with `detail.reasons` (`{code, sheet_id, sheet_no, count?, message}`) while any sheet's index is stale (`index_stale`) or has open (unwaived) DRC errors (`drc_errors`). Drafting lists the reasons; clicking one opens the sheet (and brings its DRC panel into view), and stale sheets offer "Re-index now".
- **Released drawings are locked.** Sheet create/update/delete, drawing metadata, revisions, and waivers return 409 until a new revision is started. Release stores an immutable snapshot of every sheet (document, index rows, DRC findings and waivers) on the revision, served by `GET /revisions/{id}/snapshot`; Drafting's "View" opens it read-only with a sheet preview and SVG download.
- **Read-only editing.** For released drawings and for viewers the canvas runs the editor in read-only mode (`Editor.setReadOnly`, `SchematicCanvas readOnly`): every document command, undo/redo, paste, and drawing tool is dropped, while select, pan, zoom, find, copy, and measure keep working. The inspector, toolbar, and drawing form are disabled, and released drawings show a "Released — start a new revision to edit" banner.

**Staleness.** A sheet's stored index and DRC are stale when its document changed without them (a new or converted sheet with content), when an assigned part changes, or when a project requirement changes (`app/services/sheet_index.py`). List, BoM, and verification-matrix responses carry `stale_sheets`, BoM snapshots record the sheets that were stale when they were generated, and exports print a warning row. When the server runs the engine itself (`FSDP_ENGINE_CLI`, see "Server-side index and DRC" below) it refreshes new, copied, and revised drawings on its own and any project on request. Otherwise, and for whatever is still stale, when a writer opens a drawing that is not released, Drafting re-indexes its stale sheets in the background (`components/schematic/useStaleReindex.ts`): one sheet at a time, from the stored document, through the same `computeSheetPayload` (`engine/sheetPayload.ts`, over `deriveSheetData` in `engine/derived.ts`) that save uses (registry, tag scheme, parts, requirement constraints, waivers, reserved tags and connector targets from the other sheets), then `PUT /sheets/{id}` with document, index, and DRC. The run stops when the drawing changes, and the open sheet is left alone while it has unsaved edits (its save indexes it). Saves are versioned (`DocumentStore.markSaved(version)`), so edits made while a save is in flight stay unsaved.

### Server-side index and DRC

The index rows and DRC results are always computed by the TypeScript engine; the server
can run that same engine under Node, so a sheet does not have to wait for a browser.

- **One function.** `computeSheetPayload` (`frontend/src/engine/sheetPayload.ts`) turns
  plain data — the sheet document, the drawing's frame template and other sheets, custom
  symbol rows, the stored tag scheme, parts, requirements with constraints, waivers —
  into the `index` and `drc` of `PUT /sheets/{id}`. It is a thin adapter over
  `deriveSheetData` and has no DOM, React, or network dependency. The Drafting page's
  save and background re-index call it, and so does the server, through the CLI.
  Custom symbols need a DOM parser only to sanitize their SVG for painting
  (`sanitizeSvgInner` returns `""` without one); the index and DRC read their ports,
  category, tag prefix, and size, so under Node they are registered without markup.
- **CLI.** `frontend/src/engine/cli.ts` reads one JSON request on stdin
  (`engineRequest.ts`: `{context: {customSymbols, tagScheme, parts, requirements},
  drawings: [{frameTemplate, sheets: [{sheetId, sheetNo, document, waivers, compute}]}]}`)
  and writes `{protocol, results: [{sheetId, ok, index, drc, counts} | {sheetId, ok:
  false, error}]}` on stdout. A sheet that fails reports its error and the others go on;
  exit code 2 means the request itself was unreadable. `npm run build:engine`
  (`vite.engine.config.ts`) bundles it into one dependency-free file,
  `frontend/dist-engine/engine-cli.mjs` (about 100 kB, Node 18 or later).
- **Service.** `backend/app/services/server_index.py` gathers the request from the
  database (all sheets of the drawing, the project's tag scheme and requirements, the
  parts and custom symbols the documents reference, the sheet's waivers), runs
  `node <bundle>` with `subprocess` (argument list, no shell, a minimal environment, a
  timeout, a 32 MB request cap, stderr logged; one engine process at a time per API
  process), validates each result through `SheetIndexIn` / `DrcIn`, and stores it with
  `replace_sheet_index` / `replace_sheet_drc`, clearing `index_stale` and setting
  `indexed_at` as a save does. It writes a change-log entry ("Re-indexed sheet … on the
  server"). The stored document is not rewritten.
- **Safety.** Released drawings are never touched. No transaction is open while Node
  runs; the write then takes row locks on the drawing and its sheets and stores a sheet
  only if it is still stale, its `updated_at` is the one read before the run, and no
  sheet document of the drawing changed. Otherwise the sheet is counted as `skipped`
  and left to whoever changed it (a save indexes it; anything else leaves it stale for
  the next run). `PUT /sheets/{id}` takes the same row lock, so a save and a server
  re-index of one sheet never interleave.
- **Triggers.** `POST /projects/{project_id}/reindex` and `POST
  /drawings/{drawing_id}/reindex`; and, as FastAPI background tasks with a database
  session of their own, after creating a drawing or sheet from a document (conversion
  included), `POST /drawings/{id}/copy`, `POST /drawings/{id}/revise`, and a
  `PUT /sheets/{id}` that stores a document without its index (an API client). The
  background runs are best effort: a failure is logged and the sheet stays stale.
- **Browser.** The Drafting page's background re-index refetches each sheet and skips
  one the server has refreshed meanwhile, so the two do not rewrite each other's work.
  Where a page warns about stale sheets (BoM page), writers get "Re-index project",
  hidden when `GET /engine/status` reports the engine off.
- **Configuration** (`backend/app/core/config.py`): `FSDP_ENGINE_CLI` (path to the
  bundle; empty, the default, turns all of the above off), `FSDP_ENGINE_NODE` (default
  `node`), `FSDP_ENGINE_TIMEOUT_SECONDS` (default 60, per drawing). The API Docker image
  builds the bundle, ships Node, and sets `FSDP_ENGINE_CLI`.
- **Parity tests.** `frontend/src/engine/cli.bundle.test.mjs` builds the bundle, runs it
  under Node, and compares with the same request computed in jsdom (as in the browser);
  it also keeps `frontend/src/engine/testdata/engine-parity.json` (request and expected
  response) in step. `backend/tests/test_server_index.py` loads that request into a
  database, runs the real engine through the service, and expects the stored rows to
  equal the expected response; fake CLI scripts cover timeout, non-zero exit, bad JSON,
  per-sheet errors, and schema violations.
- **Not covered.** Sheets flagged stale by part or requirement changes are not
  re-indexed automatically (use the endpoint); line classes are not an engine input
  (neither the index nor the DRC reads them today).

**BoM release.** `PUT /bom/{id}/status` with `released` is refused (409, `detail.issues`) while readiness has blocking issues: rows without a catalog part, obsolete or restricted parts, or a snapshot generated from stale sheets. It stamps `released_by/at`; released BoMs are immutable (no return to draft; generate a new snapshot instead). The BoM page lists a drawing's snapshots, splits readiness into blocking issues and warnings, diffs two snapshots of the same drawing, and exports CSV and XLSX (`GET /bom/{id}/xlsx`, with a header block for project, drawing, revision, and status). Legacy diagram BoMs stay visible there as read-only history.
