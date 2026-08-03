# FSDP Gap Analysis — Bugs, Usability, Deployment, and Authentication

Date: 2026-08-03
Scope: full backend + frontend code review, live bug verification against the API, and deployment/auth readiness assessment for (1) a Vercel demo and (2) an internal server behind Tailscale.

Verification state at time of analysis: backend `pytest` 7/7 passing, `ruff` clean, frontend `vitest` passing, `tsc && vite build` succeeding. The suite being green does **not** reflect product health — the bugs below were all confirmed live against the real API or by direct code-path analysis.

---

## 1. Executive Summary

The MVP foundation is solid (clean FastAPI/SQLAlchemy layering, normalized diagram model, React Flow editor), but there are three blockers between the current state and "usable internally at Amphora, demoable on Vercel":

1. **The digital-thread core is broken by a critical bug:** every save of a P&ID graph destroys all component→node bindings (verified). Placement of catalog parts on diagram nodes — the central value proposition — does not survive the normal edit-save loop.
2. **There is zero authentication.** Every endpoint (including all DELETEs) is anonymous. A public Vercel demo in this state would expose full destructive CRUD to the internet. Auth is a prerequisite for the demo, not a follow-up.
3. **Nothing is deployable as-is.** No Dockerfiles for api/web, no Vercel config, no SPA rewrites, no migrations-on-boot, dependencies pinned to `latest` (non-reproducible builds, React 19 running against the deprecated `reactflow` v11 package that peer-supports only React 17/18).

Recommended order of attack (detail in §9): fix the P0 data-integrity bugs (≈1–2 days) → add cookie-based JWT auth (≈2–3 days) → containerize + deploy (Vercel frontend + hosted backend/Neon for the demo; docker-compose + Tailscale Serve internally, ≈1–2 days) → then iterate on the P&ID/BoM usability backlog.

---

## 2. Verified Bugs (confirmed live against the API)

Each was reproduced against the running app with foreign-key enforcement on (matching Postgres behavior).

### B1 — CRITICAL: Saving a diagram graph severs every component→node binding
- **Where:** `backend/app/api/routes.py:263-278` (`update_diagram_graph`), `backend/app/models.py:156` (`node_id` FK `ondelete="SET NULL"`).
- **What happens:** the endpoint bulk-deletes all `DiagramNode`/`DiagramEdge` rows and re-inserts fresh rows with new UUIDs. The FK from `component_instances.node_id` gets nulled (Postgres) for every placed component — even when the graph content is unchanged.
- **Repro:** save graph → place component on node (node_id set) → save graph again → `GET /diagrams/{id}/components` shows `node_id: null`.
- **Impact:** the P&ID→component→BoM thread only survives until the next save. Requirements traceability to positioned hardware silently degrades. The existing test doesn't catch it because it places the component *after* the last graph save.
- **Fix direction:** upsert by `(diagram_id, external_id)` — update existing node rows in place, insert new ones, delete only rows whose `external_id` disappeared, and re-link components via `properties.node_external_id`.

### B2 — HIGH: Duplicate node `external_id` in a save payload returns an unhandled 500
- **Where:** `routes.py:263-278`; unique constraint `uq_node_external_id` (`models.py:117`).
- **What happens:** `IntegrityError` propagates as `500 Internal Server Error`; the save fails and the user gets a raw error with no way to recover. Directly reachable from the UI via F1 below.
- **Fix direction:** validate payload for duplicate external ids (422), catch `IntegrityError` globally (409), and fix the frontend id generation.

### B3 — HIGH: Deleting a catalog part leaves phantom BoM rows and unresolved components
- **Where:** `routes.py:343-348` (`delete_part`), `models.py:157` (`part_id` `ondelete="SET NULL"`), `services/bom.py:14-26`.
- **What happens:** parts can be deleted while placed on diagrams; component instances silently lose their part reference and subsequent BoM snapshots emit rows with `part_number: null`, `qualification_status: "unresolved"`.
- **Fix direction:** block delete when the part is referenced (409 with usage list — the change-impact service already computes this), or require an explicit force/obsolete workflow. Parts used in engineering data should be *obsoleted*, not deleted.

### B4 — MEDIUM: Blank/whitespace `part_number` accepted (create and update)
- **Where:** `routes.py:281-295`, `326-340`; no validation in `schemas.py:48-67`.
- Projects and systems validate blank names; parts, diagrams, and requirements do not. `"  "` is a legal part number today.

### B5 — MEDIUM: Duplicate component tags allowed on the same diagram
- **Where:** no uniqueness constraint on `component_instances.tag` per diagram (`models.py:151-164`).
- Two components tagged `V-1` on one diagram are accepted; BoM `component_tags` roll-up and future auto-tagging both need per-diagram tag uniqueness.

### B6 — MEDIUM: Trace links accept nonexistent objects (and duplicates)
- **Where:** `routes.py:483-491` (`create_trace_link`) — no existence check on `source_id`/`target_id`, no dedup, and links are never cleaned up when endpoints of the link are deleted.
- **Impact:** requirements-coverage numbers built on this table will be wrong; impact analysis reports links to deleted objects. 100% traceability is a stated PRD success metric — the substrate must be trustworthy.

### B7 — MEDIUM: Negative/zero component quantity accepted
- **Where:** `schemas.py:149-162` (`quantity: int = 1`, no bounds). `quantity: -5` is accepted and subtracts from BoM roll-ups. Needs `ge=1`.

### B8 — MEDIUM: Audit trail records no deletions, has no actor, and cannot be read
- **Where:** all `delete_*` handlers in `routes.py` skip `record_change`; `ChangeEvent.actor`/`payload` are never populated; there is **no GET endpoint** for change events anywhere.
- **Impact:** the change log is write-only dead weight. For an engineering-record tool, deletion is precisely the event you must audit. Actor stamping is blocked on auth (§6).

### B9 — LOW: BoM CSV export has no `Content-Disposition`
- **Where:** `routes.py:537-556`. Browsers receive un-named `text/csv`; downloads get random names, some browsers render inline. Also no CSV-injection guard (`=`, `+`, `-`, `@` prefixes) for Excel consumers, and the export omits material/pressure/mass columns engineers will expect.

### B10 — LOW: Blank diagram name accepted; duplicate diagram names allowed within a system
- **Where:** `routes.py:218-229`. Inconsistent with project/system name validation.

### B11 — LOW: Blank requirement key accepted
- **Where:** `routes.py:421-441`; only uniqueness is checked, `key: ""` passes.

---

## 3. Frontend Bugs (verified by code-path analysis)

### F1 — HIGH: Node id generation collides after any deletion → unsavable diagram
- **Where:** `frontend/src/App.tsx:597-611` — `id = `${kind}-${nodes.length + 1}``.
- **Repro:** add valve (`valve-4`), add valve (`valve-5`), delete `valve-4`, add valve → generates `valve-5` again. Duplicate React Flow ids corrupt selection/rendering, and saving hits B2's 500 — the user **cannot save the diagram** from that point.
- **Fix direction:** `crypto.randomUUID()` (or kind + uuid suffix) for node ids; tags/labels carry the human-readable naming, not ids.

### F2 — HIGH: Unsaved diagram work is silently discarded
- **Where:** `App.tsx:362-380` — switching diagram/system/project reloads the canvas with no dirty-check; there is also no `beforeunload` guard. One misclick in the "Open diagram" select throws away edits.

### F3 — HIGH: Saving an emptied diagram resurrects the starter template
- **Where:** `App.tsx:373-374` — `diagram.graph.nodes?.length ? diagram.graph.nodes : starterNodes`. A deliberately emptied (or new empty) diagram renders the 3 demo starter nodes with the dirty flag clean; the next save persists demo content into a real engineering document. Additionally `submitDiagram` (`App.tsx:559-568`) saves whatever is currently on canvas into every newly created diagram.

### F4 — MEDIUM: Clicking a node marks the diagram dirty
- **Where:** `App.tsx:442-456` — every `NodeChange`/`EdgeChange`, including `select` changes, sets `graphDirty`. "Unsaved changes" appears from pure inspection; users lose trust in the dirty indicator, and needless revision bumps occur on save (each save increments `revision`, B1 then severs bindings). Filter to `position`/`dimensions`/`add`/`remove` change types.

### F5 — HIGH (data quality): Every new part is auto-marked qualified/preferred
- **Where:** `App.tsx:535` — `submitPart` hardcodes `qualification_status: "preferred", certification_status: "qualified"`.
- **Impact:** defeats the entire qualification/procurement-readiness model; every part entered through the UI looks flight-ready. The backend's `qualification_warnings` service (`backend/app/services/catalog.py`) is dead code — never exposed by any route.

### F6 — MEDIUM: Pressure rating `""` becomes `0`, non-numeric becomes `null` silently
- **Where:** `App.tsx:535,544` — `Number(partForm.pressure_rating_bar)`; `Number("") === 0` stores a false engineering value (0 bar rating ≠ unrated), and `NaN` serializes to `null` with no user feedback.

### F7 — MEDIUM: Component placement fights the save lifecycle
- **Where:** `App.tsx:253` (`selectedNodeId` initialized to hardcoded `"valve-1"`), `App.tsx:613-622`, backend `routes.py:361-375`.
- Placement binds to *persisted* diagram nodes, so placing a part on a just-added node fails with "Selected diagram node does not exist" until the user saves first — nothing in the UI explains this ordering. The local label update after placement isn't persisted unless the user separately saves (and saving then triggers B1, unbinding the component just placed). The core workflow contradicts itself.

### F8 — HIGH (P&ID data): Line engineering data is placeholder junk
- **Where:** `App.tsx:306-313` — every edge is saved with `fluid: "TBD"`, `flow_direction: "forward"`; there is no UI to edit edge label, fluid, pressure, temperature, diameter, or material even though `DiagramEdge` models all of them. The "Line Metadata" panel (`App.tsx:814-821`) shows only bend coordinates. P&ID line data — half of what a P&ID *is* — is effectively not captured.

### F9 — LOW: API errors shown as raw JSON text
- **Where:** `frontend/src/api.ts:23-26` — `throw new Error(await response.text())` surfaces `{"detail":"..."}` strings to users. Parse `detail`; map validation errors to fields.

### F10 — LOW: Assorted UX debt
- Fake, non-functional search box in the header (`AppShell.tsx:61`).
- One global `busy` flag disables every button in the app during any request; no request cancellation → stale responses can win races when switching projects quickly.
- `componentTag` state is shared between the Diagrams inspector and the Requirements trace panel and gets overwritten by selection-sync effects while typing.
- Diagram name field doubles as "create name" and "rename target" (`App.tsx:770-775`).
- Dirty badge shows "Unsaved changes" when no diagram is open (nothing to save to).
- No React error boundary — any render error white-screens the app.
- Node deletion only via Backspace; no visible affordance. Rotation rotates the glyph only (handles/edges unaffected) — cosmetic.

### F11 — MEDIUM (build integrity): dependency pinning
- **Where:** `frontend/package.json` — `react`, `reactflow`, `vite`, `typescript`, `@vitejs/plugin-react` all `"latest"`; several belong in `devDependencies`. Currently resolves to React 19.2 + `reactflow` 11.11.4 — a **deprecated package** (superseded by `@xyflow/react`) whose peer range is React 17/18. TypeScript resolves to 6.0.3. Builds are non-reproducible and can break on any `npm install`. Pin exact/caret versions and plan the `@xyflow/react` v12 migration.

---

## 4. P&ID Usability Gaps (Amphora day-1 needs vs. current state)

The editor is a working graph sketchpad, but not yet a P&ID tool:

| Gap | Current state | Needed for internal use |
|---|---|---|
| Symbol library | 6 generic kinds rendered as a letter glyph | ISA-style symbol set for valves (ball/check/relief/solenoid), regulators, PT/TC sensors, filters, orifices, tanks, pumps; distinct shapes, not letters |
| Line data | Hardcoded `TBD` (F8) | Editable fluid, pressure, temp, diameter, material, line number per edge |
| Tagging | Free-text tag, duplicates allowed (B5) | Auto-tagging per type (`V-1`, `PT-2`…), uniqueness enforced, tag shown on canvas |
| Node labels | Not editable (only overwritten by part placement) | Inline rename; label + tag + part number displayed |
| Placed-part visibility | Nothing on canvas indicates a node has a component/part bound | Badge/color on bound nodes; click-through to part |
| Editing ergonomics | No undo/redo, no copy/paste, no multi-select actions, no snap-to-grid | At minimum undo/redo (React Flow supports this via state history) and grid snapping |
| Save model | Manual save + dirty flag with F2/F3/F4 issues | Autosave or save-on-navigate + optimistic revisioning |
| Diagram export | None | PNG/SVG export (PRD Epic 1 lists diagram export; needed for reviews) |
| Revisions | `revision` int increments per save; old graphs overwritten | Keep revision snapshots (cheap: store graph JSON per revision) to support reviews/baselines |

## 5. BoM & Procurement Gaps

| Gap | Current state | Needed |
|---|---|---|
| Snapshot history | Only latest snapshot shown; history endpoint exists but unused | List snapshots with revision/status/date; open any |
| Project-level BoM | Endpoint `GET /projects/{id}/bom` exists; **no UI calls it** (`api.ts:116` unused) | Project BoM roll-up across systems/diagrams |
| BoM status workflow | Always `draft`; no transition endpoint | draft → released with actor + timestamp (needs auth) |
| Quantity editing | UI always places qty 1; no edit field | Quantity editing; or derive qty from node instances |
| Procurement readiness | `qualification_warnings` service is dead code | Endpoint + UI: flag unqualified/unrated/material-missing parts per BoM (PRD Epic 7) |
| Export | CSV, 7 columns, no filename (B9) | Filename header, more columns (material, pressure rating, mass, Cv), mass/cost roll-up, XLSX |
| Diff | None | Revision-to-revision BoM diff (added/removed/qty-changed) — high review value, cheap to build on stored rows |
| Snapshot concurrency | Revision computed read-then-write; duplicate revisions possible under concurrency | Unique constraint on `(diagram_id, revision)` + retry |
| BoM correctness | Includes components whose node was deleted from the canvas (loose diagram↔component coupling, worsened by B1) | Reconcile component instances against live nodes at save/BoM time; warn on orphans |

## 6. Security & Authentication Gaps (blocking for both deployments)

Current state: **no authentication or authorization of any kind.**

- No user model, no login, no session/JWT machinery, no auth dependencies in `pyproject.toml`, no protected routes, no login UI.
- All destructive endpoints (project/system/diagram/part deletes) are anonymous.
- `ChangeEvent.actor` is always `NULL` — no accountability trail (B8).
- `/docs` + `/openapi.json` are public; `/health` does not check the DB.
- CORS: `allow_credentials=True` with wildcard methods/headers; origins default to `http://localhost:5173` and must be overridden via `FSDP_CORS_ORIGINS` (JSON list format, e.g. `FSDP_CORS_ORIGINS='["https://fsdp-demo.vercel.app"]'`) — currently undocumented.
- Secrets: DB password `fsdp` hardcoded in `docker-compose.yml`; no `.env.example`; no secret-key setting exists yet for signing tokens.
- No rate limiting, no security headers, no request logging.
- The BoM CSV link is a plain `<a href>` to the API origin — with header-token auth it would break. This pushes the design toward **httpOnly cookie sessions** (works for `<a>` downloads) or short-lived signed URLs.

**Recommended auth design (works for both Vercel demo and Tailscale internal):**
1. App-level email+password auth: `users` table (Alembic migration), `argon2`/`bcrypt` hashing, login endpoint issuing a JWT in an httpOnly, `SameSite=Lax`, `Secure` cookie; FastAPI dependency enforcing it on every router; seeded admin via env var.
2. Same-origin serving (frontend + `/api` behind one host — see §7) so cookies flow without CORS gymnastics and the CSV link keeps working.
3. Stamp `actor` into every `record_change` from the authenticated user; add roles later (admin/engineer/viewer) — the dependency seam makes this cheap.
4. Internal deployment can add Tailscale as a second factor: the service is only reachable on the tailnet, and `tailscale serve` injects `Tailscale-User-Login` identity headers which can auto-provision/match app users later (or run `tsidp` as an OIDC IdP). Do **not** rely on network position alone — keep app auth so the demo and internal builds share one code path.

## 7. Deployment Readiness

Current state: only a Postgres `docker-compose.yml` exists. No Dockerfile for the API, none for the frontend, no CI, no Vercel config, no environment documentation.

### 7.1 Vercel demo — gaps and recommended shape

Gaps today:
- `BrowserRouter` deep links (e.g. `/diagrams`) will 404 on Vercel without SPA rewrites (`vercel.json` missing).
- `VITE_API_BASE_URL` is baked at build time; unset means the demo calls `localhost:8000`.
- FastAPI is a long-running ASGI app with SQLAlchemy pooling + Alembic migrations — it *can* run as a Vercel Python function, but pooling/cold-start/migration ergonomics are poor.
- No hosted Postgres, no seed data for a compelling demo.

Recommended architecture (least drift with the later internal deployment):
- **Frontend on Vercel** (static Vite build) with `vercel.json`: SPA fallback rewrite, plus a rewrite proxying `/api/:path*` to the backend host → same-origin cookies, no CORS in production, CSV downloads work.
- **Backend as a container** on Fly.io/Railway/Render (one small instance), `alembic upgrade head` on boot; **Neon** (or Supabase) Postgres with the pooled connection string. The same image later runs on the internal server.
- Prefix API routes under `/api` (or add a root_path) to make proxying clean; keep `/health` for probes and extend it to ping the DB.
- Auth from §6 enabled from day one — a demo without it is a public writable database. Seed script for demo data (one project, a helium press system, a saved P&ID, ~10 parts, requirements, one released BoM) so the demo lands.
- Pure-Vercel alternative (backend as Vercel Python function + Neon) is workable if a single deploy target is a hard requirement, but accept cold starts and migration-runner awkwardness.

### 7.2 Internal server + Tailscale — gaps and recommended shape

- Extend `docker-compose.yml` with `api` (backend image, migrations on boot) and `web` (nginx/Caddy serving the built frontend and proxying `/api` → api) services; Postgres volume already defined.
- Join the host to the tailnet; expose via **`tailscale serve`** (TLS with tailnet certs, tailnet-only by default; identity headers available). No public exposure; Funnel stays off.
- Move secrets to `.env` (+ committed `.env.example`): `FSDP_DATABASE_URL`, `FSDP_SECRET_KEY`, `FSDP_CORS_ORIGINS`, admin bootstrap credentials.
- Nightly `pg_dump` backup cron to off-box storage — this will hold real engineering data; there is currently **no backup story**.
- Basic observability: request logging, error reporting (e.g. Sentry), `/health` with DB check for uptime monitoring.

### 7.3 CI (missing entirely)

No `.github/workflows`. Add one workflow running: `ruff check`, `pytest`, `tsc -b`, `vitest run`, `vite build` on PRs; optionally build/push the backend image on `main`. All four commands already pass locally, so this is ~an hour of work that permanently guards the fixes above.

## 8. Testing Gaps

- 7 backend tests / 1 frontend smoke test; no coverage of: graph re-save with placed components (would have caught B1), duplicate external ids (B2), part-in-use deletion (B3), validation (B4–B7, B10–B11), CSV export contents, change-impact edge cases.
- Frontend has no tests for the diagram editor logic (id generation F1, dirty tracking F4, load/save round-trip F2/F3) — the highest-risk code in the app.
- Tests run on SQLite while prod is Postgres (JSONB vs JSON drift in migration `0001`); at minimum run CI tests against a Postgres service container.
- No E2E happy-path (create project → system → diagram → place part → BoM → CSV). One Playwright spec would protect the entire demo path.

## 9. Prioritized Roadmap

### Phase 0 — Data-integrity bug fixes (highest urgency, ≈1–2 days)
1. B1 upsert-by-`external_id` graph save preserving component bindings (+ regression test).
2. F1 UUID node ids; B2 IntegrityError handler (409/422 instead of 500).
3. F3 respect intentionally-empty diagrams (drop starter-node fallback on load; new diagrams start blank); F2 dirty-check before diagram switch + `beforeunload`.
4. F4 dirty flag only on real mutations.
5. B3 block/obsolete referenced part deletion; B7 `quantity >= 1`; B4/B10/B11 blank-name validation parity; B5 per-diagram tag uniqueness; B6 trace-link target validation.
6. F5 stop hardcoding qualification status (default `unqualified`, editable); F6 numeric field parsing.
7. B9 CSV `Content-Disposition` + richer columns.

### Phase 1 — Authentication (≈2–3 days)
Users table + migration, password hashing, cookie JWT sessions, auth dependency across routers, login page + session handling + 401 redirect in frontend, actor stamping in `record_change`, `.env.example` + secret settings, delete auditing (closes B8), read endpoint for change history.

### Phase 2 — Deployability (≈1–2 days)
Backend Dockerfile (+migrations on boot), compose `api`/`web` services, `/api` route prefix, `vercel.json` (SPA rewrite + API proxy), Neon + backend host for demo, seed-data script, GitHub Actions CI, pinned frontend dependencies, health check with DB ping, Tailscale serve runbook in `infra/`, pg_dump backup cron.

### Phase 3 — P&ID/BoM usability for real internal work (iterative)
Line metadata editing (F8) → auto-tagging + tag uniqueness UX → symbol library → placement flow rework (bind by `external_id` at save; placed-part badges on canvas) → BoM history/project BoM/status workflow/procurement readiness endpoint (revive `qualification_warnings`) → BoM diff → undo/redo → diagram PNG/SVG export → trace-link management UI → `@xyflow/react` v12 migration.

---

## Appendix — How the bugs were verified

B1–B11 were reproduced with a scripted client against the live FastAPI app (in-memory SQLite with `PRAGMA foreign_keys=ON` to match Postgres FK semantics), asserting on actual API responses and DB state. F-series findings were verified by code-path analysis of `App.tsx`/`api.ts` (and F11 against the installed lockfile versions). The regression tests recommended in Phase 0 should encode the same scenarios.
