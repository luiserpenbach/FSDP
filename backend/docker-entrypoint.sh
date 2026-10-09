#!/bin/sh
set -e

echo "Running database migrations..."
alembic upgrade head

# Hosts without a shell (e.g. Render's free plan) can load the demo data at boot;
# the seed is idempotent and skips when the demo project already exists.
if [ "${FSDP_SEED_DEMO:-false}" = "true" ]; then
  echo "Seeding demo data..."
  python -m app.seed
fi

echo "Starting API..."
# Platforms such as Render and Railway assign the port through $PORT.
exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --proxy-headers \
  --forwarded-allow-ips="*"
