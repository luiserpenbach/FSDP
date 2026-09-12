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
- Frontend: React, TypeScript, Vite, React Flow.
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
- `diagrams`: saved P&ID graph documents with revision and graph JSON.
- `diagram_nodes`: normalized graph nodes for queryable diagram structure.
- `diagram_edges`: normalized graph edges and line-like attributes.
- `parts`: internal or vendor catalog parts.
- `component_instances`: part usage on a diagram, optionally bound to a persisted diagram node.
- `requirements`: project-level requirements.
- `trace_links`: typed links between requirements, components, and other object types. Link types are validated (`related_to`, `satisfied_by`, `verified_by`, `traces`, `applies_to`, `derives`, `mitigates`, `controls`, `causes`, `evidenced_by`, `verifies`).
- `requirement_history`: one row per changed requirement field, with the revision and actor.
- `requirement_evidence`: proof attached to a requirement (`drc` rows are mirrored from saved sheets; `analysis`, `document`, `test`, `inspection`, `waiver` are recorded by people). `requirements.verification_status` rolls up from these rows.
- `hazards`: project hazard log entries with initial and residual ratings, operating modes, status (`open`, `accepted`, `closed`), and the fault-tolerance requirement. Controls are `mitigates` (requirement → hazard) and `controls` (sheet_item → hazard) trace links.
- `safety_settings`: one JSON row per project (rating scales, risk matrix, fault-tolerance policy, operating modes, hazard categories, flags).
- `bom_snapshots`: generated BoM rows for a diagram at a point in time.
- `change_events`: simple audit/change records used by change impact views.

Important modeling choices:

- `Diagram.graph` stores the full React Flow payload for round-tripping the editor state.
- `DiagramNode` and `DiagramEdge` store normalized graph data for BoM, traceability, and later analysis.
- `ComponentInstance.node_id` binds a placed component to an actual `DiagramNode`.
- `Part.metadata_` maps to the database column named `metadata` to avoid colliding with SQLAlchemy's reserved `metadata` attribute.

### Services

Service modules live in `backend/app/services/`.

- `bom.py`: rolls component instances up into BoM snapshot rows.
- `traceability.py`: returns trace links for an object in either source or target direction.
- `change_impact.py`: identifies linked objects, affected components, and affected BoM snapshots.
- `catalog.py`: contains early catalog-quality warnings for missing qualification data.
- `hazards.py`: hazard keys, the computed control state of a hazard (every control verified, hardware controls covered by a requirement, independent controls at or above the policy), risk matrix counts, and the safety-critical flag on requirements.
- `verification.py`: evidence roll-up, DRC evidence mirrored from sheet saves, derivation cycle checks, and requirement history.
- `requirements_io.py`: CSV/XLSX import with header aliases and mapping, export rows, and the coverage report.
- `safety_settings.py`: defaults (MIL-STD-882 style I–IV × A–E matrix, fault tolerance 2 for I and II) merged with the stored per-project row.

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

Diagrams:

- `POST /systems/{system_id}/diagrams`
- `GET /systems/{system_id}/diagrams`
- `GET /diagrams/{diagram_id}`
- `PUT /diagrams/{diagram_id}`
- `DELETE /diagrams/{diagram_id}`
- `PUT /diagrams/{diagram_id}/graph`

Parts:

- `POST /parts`
- `GET /parts`
- `GET /parts/{part_id}`
- `PUT /parts/{part_id}`
- `DELETE /parts/{part_id}`

Components:

- `POST /diagrams/{diagram_id}/components`
- `GET /diagrams/{diagram_id}/components`
- `PUT /components/{component_id}`
- `DELETE /components/{component_id}`

Requirements:

- `POST /requirements`
- `GET /projects/{project_id}/requirements` (filters: `category`, `verification_status`, `safety_critical`, `parent_id`, `q`)
- `GET /requirements/{requirement_id}`
- `PUT /requirements/{requirement_id}` (writes `requirement_history`, bumps `revision`)
- `DELETE /requirements/{requirement_id}`
- `GET /requirements/{requirement_id}/history`
- `GET/POST /requirements/{requirement_id}/evidence`, `PUT/DELETE /evidence/{evidence_id}`
- `POST /projects/{project_id}/requirements/import` (multipart CSV/XLSX, `mapping`, `dry_run`, `update_existing`)
- `GET /projects/{project_id}/requirements/export?format=csv|xlsx`
- `GET /projects/{project_id}/requirements/coverage`
- `GET /projects/{project_id}/verification-matrix?format=json|csv|xlsx`

Safety (`backend/app/api/safety_routes.py`):

- `GET/PUT /projects/{project_id}/safety-settings`
- `GET /projects/{project_id}/sheet-items?q=&category=` (picker for hardware controls)
- `GET/POST /projects/{project_id}/hazards`, `GET /projects/{project_id}/hazards/matrix`
- `GET/PUT/DELETE /hazards/{hazard_id}`
- `POST /hazards/{hazard_id}/controls`, `DELETE /hazards/{hazard_id}/controls/{link_id}`
- `POST /hazards/{hazard_id}/derive-requirement`
- `POST /hazards/{hazard_id}/accept`

Traceability:

- `POST /trace-links`
- `GET /objects/{object_type}/{object_id}/trace`

BoM:

- `POST /diagrams/{diagram_id}/bom`
- `GET /diagrams/{diagram_id}/bom`
- `GET /projects/{project_id}/bom`
- `GET /bom/{snapshot_id}/csv`

Change impact:

- `GET /changes/impact?object_type=...&object_id=...`

### Validation and Error Handling

Current explicit validations:

- Duplicate project names return `409`.
- Duplicate part numbers return `409`.
- Duplicate requirement keys within a project return `409`.
- Component placement validates that the selected graph node exists in the target diagram.
- Component updates validate that selected nodes belong to the component's diagram.

Future validation should add stronger field constraints, engineering-unit validation, and object-type validation for trace links.

## Frontend

### Entry Points

- `frontend/src/main.tsx` mounts the React app and imports React Flow styles.
- `frontend/src/App.tsx` contains the current MVP workspace.
- `frontend/src/api.ts` wraps backend HTTP calls.
- `frontend/src/types.ts` defines frontend data types aligned with backend responses.
- `frontend/src/styles.css` contains layout and interaction styling.

### MVP Workspace Flow

The current page supports this workflow:

1. Create, select, update, or delete a project.
2. Create, select, update, or delete a fluid system under the active project.
3. Create, open, rename, delete, edit, and save a P&ID diagram graph.
4. Add graph nodes and lines with React Flow.
5. Create, select, update, or delete catalog parts.
6. Place a selected part onto a selected diagram node as a component instance.
7. Create, select, update, or delete requirements.
8. Link a selected requirement to a selected component.
9. Generate BoM snapshots and download CSV.
10. Inspect basic change impact for the selected component or part.

### Diagram Persistence

React Flow nodes and edges are saved through:

```text
PUT /diagrams/{diagram_id}/graph
```

The backend stores:

- `Diagram.graph`: full editor payload used to restore the React Flow canvas.
- `DiagramNode`: normalized nodes.
- `DiagramEdge`: normalized edges.

When a user selects an existing diagram in the frontend, the app fetches the diagram and restores `graph.nodes` and `graph.edges` into React Flow state.

### Component Placement

The frontend sends `properties.node_external_id` when placing a part on a graph node. The backend resolves that external graph id to the persisted `DiagramNode.id` and stores it in `ComponentInstance.node_id`.

This means placed components are tied to queryable diagram nodes, not only to frontend-only graph ids.

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
- End-to-end API workflow for project/system/diagram/part/component/BoM.
- Duplicate validation and delete flow.

## Current Limitations

- The frontend is still a single-page MVP workspace, not a production navigation model.
- There is no authentication, authorization, or role-based approval workflow.
- Change impact is shallow and only follows direct trace links plus part/component BoM usage.
- Diagram symbols are generic React Flow nodes, not a full P&ID symbol library.
- Engineering analysis modules are not implemented yet; FMEA worksheets and engine-derived safety analyses are the next phases of [safety-requirements-implementation-plan.md](safety-requirements-implementation-plan.md).
- Configuration baselines, branches, and releases are not implemented yet.
- Certification package generation is not implemented beyond BoM CSV export and future-oriented stubs.

## Recommended Next Implementation Areas

1. Add pressure-drop analysis for simple incompressible line networks.
2. FMEA worksheets bound to sheet items (safety plan phase B).
3. Add trapped-volume detection from valve states and graph connectivity.
4. Add relief valve sizing with stored assumptions and calculation reports.
5. Engine-derived safety analyses and the drafting safety overlay (safety plan phase C).
6. Add release/baseline snapshots for diagrams, BoMs, requirements, and analyses.

## Schematic Engine (Drafting page)

The Drafting page is the first slice of the [P&ID professional upgrade plan](pid-professional-upgrade-plan.md). It is built on a framework-free TypeScript engine in `frontend/src/engine/`:

- **Document** (`types.ts`): JSON schema v1 in paper-space millimetres. Items are symbols (library references pinned to a version), lines (orthogonal polylines), equipment boundaries, labels, and review notes. Connectivity is derived from geometry: a line end on a port or on another line is connected (`connectivity.ts`), and junction dots are computed, never drawn.
- **Commands** (`commands.ts`, `store.ts`): every edit is a serialisable command with an exact inverse; the store keeps undo/redo and dirtiness. Drags coalesce into one undo step.
- **Renderer** (`render.ts`): one renderer produces SVG markup for the canvas and for export at paper size (`renderDocumentSvg`), so the screen and the file never drift.
- **Editor** (`editor.ts`): tool state machines for select/move, wire, place, label, equipment, and note, driven by pointer events in mm and a KiCad-style key map (W wire, R rotate, X mirror, Esc cancel, Ctrl+D duplicate, arrows nudge).
- **Converter** (`convert.ts`): turns a legacy React Flow `graph` into a document on first open; item ids are preserved so component bindings keep lining up.

**Drawings** (`backend/app/api/drawing_routes.py`, migration `0008`): a drawing (`/projects/{id}/drawings`) has a number, up to three title lines, size, units, status, frame template, title-block fields, and general notes; it owns numbered sheets (`/drawings/{id}/sheets`, each with a schematic document) and revisions (`/drawings/{id}/revisions`). Frame templates (`frontend/src/engine/frames.ts`) bind those rows into the title block, revision table, notes block, and proprietary notice when the sheet renders.

**Symbol library** (`frontend/src/engine/builtinSymbols.ts`, `library.ts`): 104 built-in ISA/ISO symbols with typed ports, legend text, and tag letters; valve bodies accept a composed actuator (`SymbolItem.actuator`) whose signal port joins the body's ports through `registry.portsOf`. Custom symbols from `/symbols` carry `category`, `legend`, and `tag_prefix` (migration `0009`). The Drafting page's library panel browses, searches, previews, and places symbols.

**Tag schemes** (`frontend/src/engine/tags.ts`, `GET/PUT /projects/{id}/tag-scheme`): per-project simple (`HV-12`) or structured (`PT 3222`) tags; the editor suggests, validates, and renumbers tags; the Settings page edits the scheme. The frame renderer can print a symbol legend and the ISA letter table when the drawing enables them.

**Lines, nozzles, connectors** (`frontend/src/engine/lines.ts`, `connectors.ts`): lines carry class, conditions, and inline annotations that follow the line; crossings between unconnected lines render as hops; equipment boundaries expose nozzles as ports; off-page connectors resolve to the sheet and zone of their pair across the drawing's sheets. Project line classes live in `line_classes` (`/projects/{id}/line-classes`, CSV import) and are managed on the Settings page.

**Sheet index and lists** (`sheet_items`, `sheet_lines`, migration `0011`; `frontend/src/engine/index.ts`, `lists.ts`; `app/services/sheet_index.py`, `lists.py`): saving a sheet sends normalized item and line rows built by the engine (zone, tag, category, assigned part, DNP/spares, connected line data; line from/to, conditions, lengths, connections). `GET /drawings/{id}/lists/{kind}` and `GET /projects/{id}/lists/{kind}` serve the instrument index, line list, valve list, equipment list, and tie-in list as JSON, CSV, or XLSX (`?format=`) with a drawing header and zone column. The Drafting page's lists drawer shows the live lists, locates rows on the sheet, and exports.

**Drawing BoM and parts** (`POST /drawings/{id}/bom`, `app/services/bom.py`; `components/schematic/AssignPartModal.tsx`, `engine/parts.ts`): BoM snapshots from the sheet index roll tagged items up by assigned part (`SymbolItem.partId`), list DNP items without counting them, add spares, and add tubing/fitting/tee bulk rows from lines; readiness issues carry codes and severities. Parts are assigned from the inspector with warn-only checks; the canvas shows part badges (not exported) and the catalog's where-used panel lists drawing placements. XLSX export uses openpyxl.

**Design rule checks and requirements** (`frontend/src/engine/drc.ts`, `sizes.ts`, `drcSheet.ts`; `components/schematic/DrcPanel.tsx`; `app/services/drc.py`, migration `0012`): the engine checks connectivity, tags, line data, port sizes, spec continuity, part status and rating, relief coverage of isolable volumes, and requirement constraints (`requirements.constraint`). Findings carry a stable key; saving a sheet stores them and the per-item requirement checks (`drc_results`, `drc_requirement_checks`); waivers by key live in `drc_waivers` (`PUT/DELETE /sheets/{id}/drc/waivers`). `GET /sheets/{id}/drc`, `GET /drawings/{id}/drc`, and `GET /projects/{id}/verification-matrix` serve counts, findings, and the requirement verdicts; trace links accept `drawing`, `sheet_item`, and `sheet_line` targets. The PDF export accepts extra SVG pages (merged with pypdf) for the findings sheet.

**Export** (`POST /sheets/{id}/export`): the browser renders the sheet SVG with the shared renderer and the server converts it with Cairo (`app/services/export.py`) to PDF at paper size or PNG at a DPI; the image installs `libcairo2`.

Legacy persistence: `GET/PUT /diagrams/{id}/schematic` stores a schematic document on a classic diagram (`diagrams.schematic`, migration `0007`); "Convert diagram" on the Drafting page uses it as the source when present, else converts the React Flow `graph`.

Tests: `npx vitest run src/engine` covers geometry, library grid conformance, undo/redo (including a randomised inverse property), connectivity, routing, snapping, hit testing, conversion, rendering, frame templates, and the editor tools; `src/pages/DraftingPage.test.tsx` covers opening a sheet with a bound title block, saving, converting a diagram, and exporting; `backend/tests/test_schematic.py` and `test_drawings.py` cover the API including PDF/PNG export.

## Safety Phase A (hazard log, evidence, requirements)

Implemented from [safety-requirements-implementation-plan.md](safety-requirements-implementation-plan.md) (migration `0013`):

- **Hazard log** (`/safety`, `pages/SafetyPage.tsx`, `components/safety/`): overview tiles, an initial/residual risk matrix that filters the log, the hazard grid, and a drawer with fields, ratings, operating modes, controls (requirements via `mitigates`, drawing items via `controls`), derive-requirement, and acceptance. A hazard's `computed_status` is `controlled` only when every control is a verified or waived requirement (hardware controls count when a requirement applies to the item through a DRC check or a trace link) and the number of independent controls meets `fault_tolerance_required`.
- **Requirements** (`/requirements`, `pages/RequirementsPage.tsx`, `components/requirements/`): filters, a derivation tree, a coverage bar, a drawer with derivation, applicability, source reference, the constraint builder, trace links, evidence, and history; a verification matrix tab with method, owner, verification status, evidence counts, and mitigated hazards; a coverage tab (untraced requirements, safety-critical without evidence, hazards without controls, uncovered hardware controls); CSV/XLSX import with a dry run and column mapping; XLSX export of the list and the matrix.
- **Verification**: saving a sheet mirrors its requirement checks into `drc` evidence rows (`services/verification.py`), and `verification_status` rolls up as `planned`, `in_progress`, `verified`, `failed`, or `waived`.
- **Settings**: `pages/SafetySettingsPanel.tsx` edits the fault-tolerance policy, operating modes, hazard categories, defaults, and the RPN threshold.
- **Sheet index**: `replace_sheet_index` upserts by `(sheet, item_id)` / `(sheet, line_id)` so item and line ids survive saves and can be referenced by controls and trace links.

Tests: `backend/tests/test_safety_phase_a.py`, `frontend/src/pages/SafetyPage.test.tsx`, `frontend/src/pages/RequirementsPage.test.tsx`.

## Safety Phase B (FMEA worksheets)

Implemented from the plan (migration `0014`):

- **Failure-mode library** (`failure_modes`, `services/failure_modes.py`): seeded on first use with modes per item category and symbol key (valves, check valves, relief devices, filters, regulators, instruments, quick disconnects, pumps, tanks, lines); admins edit it on the Settings page (`pages/FailureModePanel.tsx`). Each mode carries default severity, local and end effect templates, detection hints, and a hazard suggestion.
- **Worksheets and rows** (`fmea_worksheets`, `fmea_rows`; `services/fmea.py`): a worksheet is bound to a drawing and its revision label; rows are bound to `(sheet_id, item_id)` so they follow the item through re-tagging. `POST /fmea/{id}/generate` creates one row per applicable failure mode for every tagged item in the chosen categories, skipping rows that already exist, and suggests the detecting instrument from the same line. `validate_row` enforces the S/O/D scale, requires a hazard above the hazard-severity floor, and requires a reason when detection is `none`.
- **Staleness on save** (`services/safety_sync.py`): saving a sheet compares the previous index with the new one and marks rows `retagged`, `part_changed`, `moved_volume`, or `deleted`; the engineer confirms each row from the grid, which clears the flag and records the new tag or part.
- **Release** (`fmea_releases`): the gate blocks stale rows, high-severity rows without a hazard, undetected rows without a reason, and open actions without an owner; release freezes the row views with the drawing revision label and needs the safety approver grant. `GET /fmea/{id}/diff?against=` compares the live rows with a release (added, removed, changed ratings and text).
- **Exports and comments**: XLSX/CSV (`services/lists.py`) and PDF (`services/svg_tables.py` pages through cairosvg); per-row comment threads with resolve.
- **Grid** (`components/safety/FmeaGrid.tsx`, `useFmeaRows.ts`, `RefPicker.tsx`, `FmeaTab.tsx`): keyboard-driven cells, bulk save with undo, hazard and requirement pickers, stale banner, gate summary, release, export, comments.

Tests: `backend/tests/test_safety_phase_b.py`, `frontend/src/components/safety/FmeaGrid.test.tsx`, the FMEA tab test in `SafetyPage.test.tsx`.

## Safety Phase C (engine analyses, drawing overlay)

Implemented from the plan (migration `0015`):

- **Isolable volumes** (`engine/volumes.ts`, `sheet_volumes`): the engine walks process lines between isolating items (valves, check valves, regulators, disconnects) and sends the volumes with the sheet index; keys are a hash of the sorted line ids so they survive unrelated edits. Volumes record service, line numbers, isolating items, relief and vent coverage.
- **Analyses** (`analyses`, `services/analyses.py`): `trapped_volume`, `relief_scenario`, `single_point_failure`, `fault_tolerance`, and `manual`. Runs store scope, assumptions, result, verdict, and the sheet's document hash; saving the sheet marks analyses of that sheet outdated. `POST /analyses/{id}/attach-evidence` records the run as `analysis` evidence on the requirements it covers (refused while outdated).
- **Auto-hazards** (`safety_settings.auto_hazard`): a `relief_coverage` DRC finding creates a `trapped_fluid` hazard linked to the volume; the finding carries `hazard_id`, and waiving such a finding requires the hazard to be accepted or closed.
- **Drafting overlay** (`GET /sheets/{id}/safety-overlay`, `SchematicCanvas` safety layer, `components/schematic/SafetyPanel.tsx`): item badges for open and stale FMEA rows and hazard risk, volume shading, a Safety inspector panel listing the selected item's rows, hazards, and controls with "Add failure mode" and "Create hazard" from a relief finding. `/drafting?drawing=&sheet=&item=` locates an item from the Safety and Requirements pages.
- **Safety page tabs**: Analyses (run, re-run, attach as evidence, outdated markers) and Design rules (every open and waived finding across the project's drawings, grouped by rule, with the hazard a relief finding created).
- **Change impact** (`services/change_impact.py`): a part change now walks part → sheet items → FMEA rows → hazards → requirements → analyses; the Reviews page lists each.

Tests: `backend/tests/test_safety_phase_c.py`, `frontend/src/engine/volumes.test.ts`, the analyses and design rules tab tests in `SafetyPage.test.tsx`, the overlay cases in `DraftingPage.test.tsx`.

## Safety Phase D (review packages, approver grant, certification evidence)

Implemented from the plan (migration `0016`):

- **Review packages** (`safety_packages`, `services/safety_package.py`, `POST/GET /projects/{id}/safety/packages`, `GET /safety/packages/{id}/pdf|xlsx`): one PDF (cover with scope and summary, initial and residual risk matrices, hazard log, FMEA rows by RPN, verification matrix, open actions, design rule findings and waivers, change log since the previous package) and one XLSX with the same sections as sheets. Rendered server-side through `services/svg_tables.py` and cairosvg, stored under `FSDP_SAFETY_FILES_DIR` (default `var/safety-packages`). Scope defaults to every drawing and worksheet; the Reviews page (`components/reviews/PackagesPanel.tsx`) narrows it with checkboxes and shows the generation time. The plan's criterion (a package for one drawing and one worksheet in under a minute) is met: the backend test generates two packages in about four seconds including the API round-trips.
- **Approver grant** (`safety_settings.approvers`, `core/security.require_safety_approver`): admins always pass; engineers pass when the list is empty or names them by e-mail or id. Applied to hazard acceptance, worksheet release, and waivers of findings that carry a hazard. Admins pick approvers from the user list on the Settings page; others enter e-mails.
- **Certification evidence** (`GET /projects/{id}/certification/evidence`, `services/certification.py`, `pages/CertificationPage.tsx`): released worksheets (with whether the release is behind the drawing revision), accepted hazards, verified safety-critical requirements, analyses, packages, and the gaps: severity I–II hazards not accepted, safety-critical requirements not verified or waived, worksheets never released or released against an older drawing revision, outdated or failed analyses, open design rule errors, and no package.

Tests: `backend/tests/test_safety_phase_d.py`, `frontend/src/pages/CertificationPage.test.tsx`, `frontend/src/components/reviews/PackagesPanel.test.tsx`.

A manual walk-through for the whole safety feature set is in [safety-testing-guide.md](safety-testing-guide.md).
