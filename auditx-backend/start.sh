#!/bin/sh
# Container entrypoint.
#   ROLE=api     (default) migrate + serve FastAPI
#   ROLE=worker  run the Celery compute worker
#   ROLE=all     API + Celery worker in one container (single free-tier web service with Redis)
set -e

ROLE="${ROLE:-api}"
WEB_CONCURRENCY="${WEB_CONCURRENCY:-2}"
CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-4}"

case "$ROLE" in
  api)
    python -m app.database
    exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers "$WEB_CONCURRENCY" --proxy-headers
    ;;
  worker)
    # --beat runs the 15-minute alert scheduler inside this worker; run it in exactly one worker
    # (CELERY_BEAT=false on extra replicas). Duplicate sends are prevented in the database anyway.
    BEAT_FLAG=""
    [ "${CELERY_BEAT:-true}" = "true" ] && BEAT_FLAG="--beat --schedule=/tmp/celerybeat-schedule"
    exec celery -A app.workers.tasks worker -Q default,ingest,reconcile $BEAT_FLAG \
      --loglevel=INFO --concurrency="$CELERY_CONCURRENCY" --max-tasks-per-child=50
    ;;
  all)
    python -m app.database
    celery -A app.workers.tasks worker -Q default,ingest,reconcile --beat --schedule=/tmp/celerybeat-schedule \
      --loglevel=INFO --concurrency="$CELERY_CONCURRENCY" --max-tasks-per-child=50 &
    exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 --proxy-headers
    ;;
  *)
    echo "Unknown ROLE '$ROLE' (expected api | worker | all)" >&2
    exit 1
    ;;
esac
