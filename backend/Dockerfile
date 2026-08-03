FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY . .
RUN pip install --no-cache-dir . \
    && useradd --create-home appuser \
    && chown -R appuser:appuser /app

USER appuser
EXPOSE 8000

CMD ["./docker-entrypoint.sh"]
