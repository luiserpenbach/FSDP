# Fluid Systems Development Platform

FSDP is a greenfield web platform for connected fluid-system design data. The MVP implements a thin digital thread: projects, fluid systems, controlled P&ID drawings (the Drafting editor), component catalog selection, requirements traceability, BoM snapshots, and change impact.

## Documentation

- [Product requirements](docs/requirements.md): original user requirements, product goals, epics, MVP scope, deferred scope, and current implementation coverage.
- [Architecture](docs/architecture.md): high-level system architecture and digital-thread model.
- [Implementation guide](docs/implementation.md): repository structure, backend API, data model, frontend workflow, and verification commands.
- [Gap analysis](docs/gap-analysis.md): verified bugs, P&ID/BoM usability gaps, authentication and deployment readiness (Vercel demo, internal server + Tailscale), and prioritized roadmap.
- [Codebase review (2026-10)](docs/codebase-review.md): verified bugs, simplification plan, canonical workflow and feature scope, and the "better than Excel" bar with a phased plan.
- [Part catalog concept](docs/part-catalog-concept.md): proposed fully featured Parts Catalog (object model, P&ID/BoM thread, UX, phases). Not yet implemented.
- [P&ID professional upgrade plan](docs/pid-professional-upgrade-plan.md): plan to grow the original Diagrams editor (since retired in favour of Drafting) into an AutoCAD/KiCad-grade P&ID tool (schematic engine, sheets and title blocks, ISA symbol library, first-class lines, tag schemes, vector/DXF export, generated lists, DRC, revision control). Phases 0–3 (engine, drawings and sheets, title blocks, PDF/PNG export, symbol library, tag schemes, first-class lines and connectors) are delivered; later phases are not.

## Stack

- Backend: FastAPI, SQLAlchemy, Alembic, PostgreSQL
- Frontend: React, TypeScript, Vite; the Drafting editor runs on an in-house SVG schematic engine (`frontend/src/engine`)
- Local infrastructure: Docker Compose PostgreSQL

## Authentication

All API routes (except `/health` and `/auth/login`) require a signed-in user. Sessions are
JWTs stored in an httpOnly cookie; the frontend shows a login page until a session exists.

- Configure the backend via environment variables with the `FSDP_` prefix
  (see `backend/.env.example`). Set a strong `FSDP_SECRET_KEY`: the API refuses to
  start with the built-in default unless `FSDP_ALLOW_INSECURE_SECRET=true` (local
  development only). Set `FSDP_SESSION_COOKIE_SECURE=true` when serving over HTTPS.
- The first admin account is created automatically at startup from
  `FSDP_ADMIN_EMAIL` / `FSDP_ADMIN_PASSWORD` (idempotent; skipped if unset).
- Admins manage further accounts via `POST /auth/users`, `GET /auth/users`, and
  `PUT /auth/users/{id}` (roles: `admin`, `engineer`, `viewer`).
- Every create/update/delete is recorded in the change log with the acting user;
  recent changes are visible on the Reviews page and via `GET /changes`.

## Current MVP Capabilities

- Sign in/out with per-user accounts (admin/engineer/viewer; viewers are read-only) and
  an actor-stamped change history; admins manage accounts from the Settings page.
- Create, select, update, and delete projects and fluid systems.
- Draft P&IDs in paper space on the Drafting page, the single P&ID editor: controlled drawings with numbers,
  titles, sheets, and revisions; frames with zones, a bound title block, revision
  table, general notes, proprietary notice, and generated symbol and instrument
  letter legends; a 104-symbol ISA/ISO library with composable actuators and
  instrument bubble styles; per-project tag schemes with suggestion, validation,
  and renumbering; lines with classes, conditions, inline spec labels and
  markers, crossing hops, and a line legend; equipment nozzles; off-page
  connectors that resolve to sheet and zone; align, distribute, copy/paste,
  find, and measure; wires that connect by geometry with derived junctions;
  undo/redo; connectivity and tag checks; and PDF, PNG, and SVG export at paper
  size. Writers draw or import (SVG, including Inkscape files) custom symbols with
  connection ports from the library panel.
- Diagrams from the retired Diagrams editor are import-only: Drafting lists every
  legacy diagram of the project, grouped by system, and converts them into drawings
  (a hint shows while some are unconverted); converted diagrams can be deleted.
- Create, select, update, and delete catalog parts with qualification/certification
  status tracking, and assign them to symbols and equipment on drawings.
- Find Swagelok tube fittings on the Fitting Selector page from a plain description
  ("3/8 tube to 1/4 male NPT elbow") or an ordering number, with specs, a generated
  product illustration, and a link to the swagelok.com product page; build a per-project
  fitting list (CSV/XLSX export) and add its fittings to the parts catalog.
- Create, select, update, and delete requirements; trace them to tagged drawing items
  or whole drawings. Links made to legacy components show read-only.
- Generate drawing BoM snapshots with history, release workflow, revision diffs,
  procurement-readiness checks, project-wide roll-up, and CSV/XLSX export. Legacy
  diagram BoMs remain as read-only history.
- Inspect the change impact of a part or requirement on drawings, tags, requirements,
  parts, and BoMs on the Reviews page, with links that open the drawing, sheet, and
  tag in Drafting.

## Running the Full Stack (Docker)

```bash
docker compose up -d --build
docker compose exec api python -m app.seed   # optional demo data
```

Serves the app at `http://localhost:8080` (frontend + same-origin `/api` proxy) with
migrations applied automatically. Configure secrets and the admin login via a `.env`
file next to `docker-compose.yml` (Compose refuses to start without `FSDP_SECRET_KEY`) — see [infra/README.md](infra/README.md), which also
documents the internal Tailscale deployment and the Vercel demo setup.

## Local Development

1. Start the database (Compose needs `FSDP_SECRET_KEY` set, e.g. in `.env`, even
   for the database alone):

   ```powershell
   docker compose up -d db
   ```

2. Run backend commands from `backend/`:

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -e ".[dev]"
   alembic upgrade head
   $env:FSDP_ALLOW_INSECURE_SECRET = "true"   # or set a real FSDP_SECRET_KEY
   $env:FSDP_ADMIN_EMAIL = "you@example.com"
   $env:FSDP_ADMIN_PASSWORD = "a-strong-local-password"
   uvicorn app.main:app --reload
   ```

   The admin variables seed your first login; afterwards create additional users
   from the API (`POST /auth/users`).

3. Run frontend commands from `frontend/`:

   ```powershell
   npm install
   npm run dev
   ```

The backend serves OpenAPI docs at `http://localhost:8000/docs`. The frontend expects the API at `http://localhost:8000` unless `VITE_API_BASE_URL` is set.

## Verification

Run backend checks from `backend/`:

```powershell
python -m pytest
python -m ruff check .
```

Run frontend checks from `frontend/`:

```powershell
npm test
npm run build
```
