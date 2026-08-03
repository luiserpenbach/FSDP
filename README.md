# Fluid Systems Development Platform

FSDP is a greenfield web platform for connected fluid-system design data. The MVP implements a thin digital thread: projects, fluid systems, a simple P&ID graph, component catalog selection, requirements traceability, BoM snapshots, and basic change impact.

## Documentation

- [Product requirements](docs/requirements.md): original user requirements, product goals, epics, MVP scope, deferred scope, and current implementation coverage.
- [Architecture](docs/architecture.md): high-level system architecture and digital-thread model.
- [Implementation guide](docs/implementation.md): repository structure, backend API, data model, frontend workflow, and verification commands.
- [Gap analysis](docs/gap-analysis.md): verified bugs, P&ID/BoM usability gaps, authentication and deployment readiness (Vercel demo, internal server + Tailscale), and prioritized roadmap.

## Stack

- Backend: FastAPI, SQLAlchemy, Alembic, PostgreSQL
- Frontend: React, TypeScript, Vite, React Flow
- Local infrastructure: Docker Compose PostgreSQL

## Authentication

All API routes (except `/health` and `/auth/login`) require a signed-in user. Sessions are
JWTs stored in an httpOnly cookie; the frontend shows a login page until a session exists.

- Configure the backend via environment variables with the `FSDP_` prefix
  (see `backend/.env.example`). At minimum set a strong `FSDP_SECRET_KEY` in any
  real deployment, and `FSDP_SESSION_COOKIE_SECURE=true` when serving over HTTPS.
- The first admin account is created automatically at startup from
  `FSDP_ADMIN_EMAIL` / `FSDP_ADMIN_PASSWORD` (idempotent; skipped if unset).
- Admins manage further accounts via `POST /auth/users`, `GET /auth/users`, and
  `PUT /auth/users/{id}` (roles: `admin`, `engineer`, `viewer`).
- Every create/update/delete is recorded in the change log with the acting user;
  recent changes are visible on the Reviews page and via `GET /changes`.

## Current MVP Capabilities

- Sign in/out with per-user accounts and an actor-stamped change history.
- Create, select, update, and delete projects and fluid systems.
- Create, reopen, rename, delete, edit, and save P&ID diagrams.
- Persist React Flow graph data and normalized diagram nodes/edges.
- Create, select, update, and delete catalog parts.
- Place selected parts onto persisted diagram nodes as component instances.
- Create, select, update, and delete requirements.
- Link requirements to components.
- Generate BoM snapshots and download CSV exports.
- Inspect basic change impact for selected parts and components.

## Local Development

1. Start the database:

   ```powershell
   docker compose up -d db
   ```

2. Run backend commands from `backend/`:

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -e ".[dev]"
   alembic upgrade head
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
