FROM node:24-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
COPY shared/ /src/shared/
RUN npm run build

FROM python:3.14-slim
ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
WORKDIR /app

COPY backend/pyproject.toml backend/uv.lock ./
RUN --mount=from=ghcr.io/astral-sh/uv:0.11.14,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev

COPY backend/app ./app
COPY --from=frontend /src/frontend/dist ./static

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app && mkdir data && chown app data
USER app

ENV PATH=/app/.venv/bin:$PATH \
    SDI_STATIC_DIR=/app/static
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
