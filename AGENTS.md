# AGENTS.md

## Cursor Cloud specific instructions

FSDP is a split web app: a FastAPI backend (`backend/`, needs PostgreSQL) and a
React/Vite frontend (`frontend/`). Standard commands live in `README.md` and
`docs/implementation.md` (note: those docs show PowerShell/Windows syntax — the
Linux equivalents are below). The Cloud update script already creates
`backend/.venv` and installs `frontend/node_modules`, so you normally only need
to start services.

### PostgreSQL (must be started each session)
PostgreSQL 16 is installed and a `fsdp` role + `fsdp` database already exist
(password `fsdp`), matching the default `FSDP_DATABASE_URL`. The server does NOT
auto-start on VM boot — start it before running the backend:

```bash
sudo pg_ctlcluster 16 main start
```

Apply migrations after the DB is up (safe to re-run): from `backend/`,
`.venv/bin/alembic upgrade head`.

### Backend (FastAPI, port 8000)
Run from `backend/` using the venv. The first admin user is bootstrapped at
startup from `FSDP_ADMIN_EMAIL` / `FSDP_ADMIN_PASSWORD` (idempotent), so set them:

```bash
cd backend
export FSDP_ADMIN_EMAIL=admin@example.com FSDP_ADMIN_PASSWORD=dev-admin-password-123 FSDP_SECRET_KEY=dev-local-secret-key
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Health check: `curl http://localhost:8000/health` → `{"status":"ok","database":"ok"}`.
OpenAPI docs at `http://localhost:8000/docs`.

### Frontend (React/Vite, port 5173)
Run `npm run dev` from `frontend/`. In dev mode the client talks to the backend
directly at `http://localhost:8000` (see `frontend/src/api.ts`); no proxy is used
locally, so the backend must be running for login and data to work.

### Lint / test / build
- Backend tests use in-memory SQLite and need NO running PostgreSQL. Gotcha: run
  them as `.venv/bin/python -m pytest` (not bare `pytest`) — the `tests` package
  is only importable when cwd is on `sys.path`, which `python -m` provides.
- Backend lint: `.venv/bin/ruff check .` (from `backend/`).
- Frontend: `npm run lint`, `npm test` (vitest), `npm run build` (from `frontend/`).
