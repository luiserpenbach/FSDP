# Build context: the repository root, because the image bundles the schematic
# engine from frontend/ (docker build -f backend/Dockerfile .). docker-compose.yml
# and render.yaml are set up that way.

# Stage 1: bundle the engine CLI (frontend/src/engine/cli.ts) into one file. The
# API runs it under Node to index and check sheets without a browser.
FROM node:22-bookworm-slim AS engine

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/vite.engine.config.ts frontend/tsconfig.json ./
COPY frontend/src ./src
RUN npm run build:engine

# Stage 2: the API.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    FSDP_ENGINE_CLI=/opt/fsdp/engine-cli.mjs

WORKDIR /app

# Cairo backs the sheet export service (SVG -> PDF/PNG).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcairo2 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Node for the engine bundle: the official binary only needs glibc and libstdc++,
# which the Debian base image has. The bundle has no dependencies (no node_modules).
# The last command fails the build if Node or the bundle does not run here.
COPY --from=engine /usr/local/bin/node /usr/local/bin/node
COPY --from=engine /build/dist-engine/engine-cli.mjs /opt/fsdp/engine-cli.mjs
RUN node --version \
    && echo '{"drawings":[]}' | node /opt/fsdp/engine-cli.mjs | grep -q '"results":\[\]'

COPY backend/ .
RUN pip install --no-cache-dir . \
    && useradd --create-home appuser \
    && chown -R appuser:appuser /app

USER appuser
EXPOSE 8000

CMD ["./docker-entrypoint.sh"]
