# AuditX Backend

FastAPI + PostgreSQL + Celery/Redis services for AuditX: universal ERP/gateway file parser, reconciliation
engine, AI Auto-Healer and the Chat-with-your-Ledger forensic agent.

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec api python -m app.utils.seeder --orders 20000 --fx-noise-rate 0.01 --reconcile
open http://localhost:8000/docs
```

Full deployment manual: [`../docs/AUDITX_MANUAL.md`](../docs/AUDITX_MANUAL.md)
