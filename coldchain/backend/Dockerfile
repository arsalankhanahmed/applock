FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY tools ./tools

# SQLite lives here unless DATABASE_URL points at PostgreSQL; mount a volume to keep it.
RUN mkdir -p /data
ENV DATABASE_URL=sqlite:////data/coldchain.db
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
