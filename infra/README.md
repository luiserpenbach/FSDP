# FSDP Deployment

Two supported deployment shapes share one backend container image:

1. **Vercel demo** — frontend on Vercel, backend container on a small host, managed Postgres.
2. **Internal server behind Tailscale** — full stack via `docker-compose.yml`, reachable only on the tailnet.

Authentication is built in; both shapes require setting a strong `FSDP_SECRET_KEY` and the
bootstrap admin credentials. See `backend/.env.example` for every backend variable.

---

## 1. Full stack with Docker Compose (local or internal server)

```bash
# From the repository root. Compose reads variables from a .env file next to it.
cat > .env <<'EOF'
FSDP_DB_PASSWORD=<strong-db-password>
FSDP_SECRET_KEY=<output of: python -c "import secrets; print(secrets.token_urlsafe(48))">
FSDP_ADMIN_EMAIL=you@amphora.example
FSDP_ADMIN_PASSWORD=<strong-admin-password>
FSDP_SESSION_COOKIE_SECURE=true   # true whenever served over HTTPS (Tailscale serve is HTTPS)
EOF

docker compose up -d --build
docker compose exec api python -m app.seed   # optional demo data
```

- App: `http://localhost:8080` (nginx serving the frontend, proxying `/api` → backend).
- API direct (debugging): `http://127.0.0.1:8000` — bound to loopback only.
- Postgres: `127.0.0.1:5432` — loopback only.
- Migrations run automatically when the api container starts.
- Local frontend dev (`npm run dev` on :5173) still works against the compose db+api.

## 2. Internal server on Tailscale

On a Linux box (VM or bare metal) that will host FSDP for the team:

```bash
# 1. Join the tailnet
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 2. Clone the repo, create .env as above (FSDP_SESSION_COOKIE_SECURE=true), then:
docker compose up -d --build

# 3. Expose over HTTPS to the tailnet only (never use `tailscale funnel` for this).
sudo tailscale serve --bg --https=443 http://localhost:8080
```

The app is now at `https://<machine-name>.<tailnet>.ts.net` for tailnet members only,
with a valid TLS certificate managed by Tailscale. App-level login still applies on top
of network access — keep both layers.

### Backups

Engineering data lives in the Postgres volume. Install a nightly dump:

```bash
sudo tee /etc/cron.daily/fsdp-backup > /dev/null <<'EOF'
#!/bin/sh
set -e
BACKUP_DIR=/var/backups/fsdp
mkdir -p "$BACKUP_DIR"
cd /path/to/FSDP
docker compose exec -T db pg_dump -U fsdp fsdp | gzip > "$BACKUP_DIR/fsdp-$(date +%F).sql.gz"
find "$BACKUP_DIR" -name 'fsdp-*.sql.gz' -mtime +30 -delete
EOF
sudo chmod +x /etc/cron.daily/fsdp-backup
```

Copy the backup directory off-box (or to cloud storage) for real durability.

### Updating

```bash
git pull
docker compose up -d --build   # migrations run on api start
```

## 3. Vercel demo (frontend on Vercel, backend on a container host)

### 3.1 Database — Neon (or Supabase/RDS)

Create a Postgres database and note the **pooled** connection string. Convert it for
SQLAlchemy: `postgresql+psycopg://USER:PASSWORD@HOST/DBNAME?sslmode=require`.

### 3.2 Backend — Fly.io / Railway / Render (any container host)

Deploy `backend/` with its Dockerfile and set:

| Variable | Value |
| --- | --- |
| `FSDP_DATABASE_URL` | the SQLAlchemy URL above |
| `FSDP_SECRET_KEY` | strong random secret |
| `FSDP_SESSION_COOKIE_SECURE` | `true` |
| `FSDP_ADMIN_EMAIL` / `FSDP_ADMIN_PASSWORD` | demo admin login |
| `FSDP_CORS_ORIGINS` | `[]` (same-origin via the Vercel rewrite; no CORS needed) |

Migrations run on boot. Seed the demo data once:
`<host's exec/console> python -m app.seed`.

### 3.3 Frontend — Vercel

1. Import the GitHub repo in Vercel; set **Root Directory** to `frontend/`.
   Build command `npm run build`, output `dist` (auto-detected for Vite).
2. Edit `frontend/vercel.json`: replace `REPLACE-WITH-YOUR-BACKEND-HOST` with the
   backend host from 3.2. This proxies `/api/*` same-origin, so the session cookie
   and CSV downloads work without CORS.
3. Production builds default the API base to `/api` — no env var needed.
   (Set `VITE_API_BASE_URL` only to point somewhere else explicitly.)

Because the API requires login, the public demo URL exposes nothing without an
account — hand out demo credentials as needed, or create per-person accounts via
`POST /auth/users`.

## Notes

- `/docs` (OpenAPI) is currently public on the backend; if that matters for the demo
  host, restrict it at the platform level or gate it in a follow-up.
- The api container serves a single uvicorn process; raise `--workers` in
  `backend/docker-entrypoint.sh` if it ever becomes a bottleneck.
- CI (`.github/workflows/ci.yml`) runs ruff + pytest and lint + vitest + build on PRs.
