FROM python:3.12.8-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN addgroup --system veritybench && adduser --system --ingroup veritybench veritybench

COPY requirements.lock pyproject.toml README.md ./
COPY src ./src
COPY migrations ./migrations
COPY alembic.ini ./

RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -r requirements.lock \
    && python -m pip install --no-cache-dir --no-deps -e . \
    && mkdir -p /data \
    && chown -R veritybench:veritybench /app /data

FROM base AS worker

# The worker is the only application container that talks to the Docker
# daemon. The API image deliberately does not contain the Docker client.
RUN apt-get update \
    && apt-get install --no-install-recommends -y docker.io \
    && rm -rf /var/lib/apt/lists/*

USER veritybench
ENV DATABASE_URL=sqlite:////data/veritybench.db

CMD ["python", "-m", "veritybench.worker"]

FROM base AS api

USER veritybench
ENV DATABASE_URL=sqlite:////data/veritybench.db

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

CMD ["uvicorn", "veritybench.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
