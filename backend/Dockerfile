FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Cairo backs the sheet export service (SVG -> PDF/PNG).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcairo2 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY . .
# /app/var holds uploaded catalog documents and generated safety review packages;
# compose mounts a named volume there so they survive image rebuilds.
RUN pip install --no-cache-dir . \
    && useradd --create-home appuser \
    && mkdir -p /app/var/catalog-files /app/var/safety-packages \
    && chown -R appuser:appuser /app

USER appuser
EXPOSE 8000

CMD ["./docker-entrypoint.sh"]
