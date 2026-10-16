# AuditX — Deployment & Operations Manual

AuditX is a multi-tenant B2B platform that reconciles ERP / storefront orders against payment-gateway
captures, auto-heals known break patterns, and lets auditors interrogate the ledger in plain English.

| Layer     | Technology                                               | Location            |
|-----------|----------------------------------------------------------|---------------------|
| API       | Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2          | `auditx-backend/`   |
| Compute   | Celery 5 workers, Redis 7 broker                          | `auditx-backend/app/workers` |
| Database  | PostgreSQL 16 (UUID PKs, tenant-scoped `org_id` on every table) | `app/database.py` |
| Frontend  | Next.js 14 App Router, TypeScript, Tailwind CSS           | `auditx-frontend/`  |
| Runtime   | Docker / docker compose (4 containers)                    | `auditx-backend/docker-compose.yml` |

---

## 1. Directory structure

```
auditx-backend/
├── Dockerfile                 # python:3.12-slim, non-root, healthcheck
├── docker-compose.yml         # api + worker + db (Postgres 16) + redis (Redis 7)
├── start.sh                   # ROLE=api | worker | all entrypoint
├── requirements.txt
├── .env.example
└── app/
    ├── main.py                # FastAPI gateway: auth, mappings, 202 job endpoints, dashboard, agent
    ├── database.py            # engine, sessions, idempotent DDL migration + data dictionary seed
    ├── config.py              # environment-driven settings
    ├── models/schemas.py      # Pydantic request / response schemas
    ├── services/
    │   ├── parser.py          # chunked universal CSV parser -> COPY bulk load
    │   ├── reconciliation.py  # Pandas full outer join engine -> discrepancy_logs
    │   ├── auto_healer.py     # AI Auto-Healer rule-book + JSONB fix proposals
    │   └── ai_agent.py        # Chat-with-your-Ledger SQL agent + guard + sandbox
    ├── workers/tasks.py       # Celery app + ingestion / reconciliation tasks
    └── utils/seeder.py        # mock data generator with anomaly injection
auditx-frontend/
├── app/
│   ├── layout.tsx, globals.css, page.tsx (redirects to /dashboard), icon.svg
│   └── dashboard/
│       ├── page.tsx           # command center: metrics, tracking matrix, forensic chat
│       ├── loading.tsx        # route-level loader
│       └── error.tsx          # route-level error boundary
├── package.json, tsconfig.json, tailwind.config.ts, postcss.config.mjs, next.config.mjs
└── .env.example
render.yaml                    # one-click Render blueprint for the API (free plan)
```

## 2. Data model

All tables use `UUID` primary keys (`gen_random_uuid()`, built into PostgreSQL 13+) and every tenant table
carries `org_id UUID NOT NULL REFERENCES organizations ON DELETE CASCADE`.

| Table | Purpose | Key constraints |
|-------|---------|-----------------|
| `organizations` | Tenant root | `brand_currency` ISO-4217 check |
| `users` | Tenant users (PBKDF2-SHA256 hashes) | `email UNIQUE`, role check (`OWNER/ADMIN/ANALYST/AUDITOR/VIEWER`) |
| `data_dictionary_master` | Canonical fields every client file maps onto | `UNIQUE(core_table_name, standard_field_name)` |
| `client_field_mappings` | Tenant header → canonical field (+ transformation rule) | `UNIQUE(org_id, standard_field_id)` |
| `ecom_orders` | ERP / storefront orders | `UNIQUE(org_id, source_order_number)` |
| `gateway_transactions` | Gateway captures | `UNIQUE(org_id, source_transaction_id)`, index `(org_id, source_order_number)` |
| `discrepancy_logs` | Reconciliation findings + AI verdicts | `issue_type` / `status` checks, `resolved_at` required when resolved |
| `audit_jobs` | Tenant-scoped background job ledger | `status` check |

Migrations are idempotent (`CREATE ... IF NOT EXISTS`) and serialised with a PostgreSQL advisory lock, so
several API replicas can boot at once. Run them explicitly with `python -m app.database`; the API also runs
them on startup.

### Transformation rules (`client_field_mappings.transformation_rule`)

Pipe-separated operations applied after the column is renamed:

| Op | Example | Effect |
|----|---------|--------|
| `trim`, `upper`, `lower` | `trim\|upper` | String normalisation |
| `strip_prefix:X`, `strip_suffix:X` | `strip_prefix:#` | Remove literal prefix / suffix |
| `multiply:N`, `divide:N` | `divide:100` | Cents → units, unit conversion |
| `negate`, `abs` | `abs` | Sign fixes, e.g. fees exported as `(1.40)` |
| `date_format:FMT` | `date_format:%d.%m.%Y %H:%M:%S` | Strict date parsing (SAP style) |
| `dayfirst` | `dayfirst` | Ambiguous `03/04/2026` read as 3 April |
| `default:V` | `default:USD` | Fill blank values |

Currency cleaning handles `$1,299.00`, `Rs. 4,500`, `Rs.1,00,000.00`, `(12.50)`, `1.234,56-`, `€ 1.234,56`,
`2 500,00`, `USD 99`.

## 3. API reference (prefix `/api/v1`)

Interactive OpenAPI docs: `http://localhost:8000/docs`.

| Method | Path | Notes |
|--------|------|-------|
| POST | `/auth/register` | Creates organisation + OWNER, returns JWT |
| POST | `/auth/login` | Returns JWT (`org` claim drives tenant isolation) |
| GET | `/me` | Current user + organisation |
| GET | `/data-dictionary` | Canonical fields |
| GET / PUT | `/mappings` | Read / upsert tenant header mappings (OWNER/ADMIN) |
| POST | `/ingest/{ecom_orders\|gateway_transactions}` | Multipart upload, streamed to disk in 1 MB blocks → **202 Accepted** |
| POST | `/reconciliation/run` | `{"auto_heal": true}` → **202 Accepted** |
| GET | `/jobs`, `/jobs/{job_id}` | Job status and result payloads |
| GET | `/discrepancies` | Filters: `status`, `issue_type`, `auto_resolved`, `search`, `sort`, `limit`, `offset` |
| POST | `/discrepancies/{log_id}/resolve` | Manual resolution with audit note |
| GET | `/dashboard/metrics` | KPI aggregates for the command center |
| POST | `/agent/query` | `{"question": "..."}` → SQL, rows, narrative |

## 4. Security model of the Forensic Agent

1. **Master prompt** locks the model to one read-only `SELECT` over a fixed schema and requires
   `org_id = :org_id` on every table reference.
2. **`guard_sql`** rejects: more than one statement, anything not starting with `SELECT` / `WITH`, the tokens
   `DROP DELETE TRUNCATE INSERT ALTER UPDATE MERGE CREATE GRANT REVOKE COPY CALL DO EXECUTE SET ... INTO`,
   schema-qualified names (`public.`, `pg_catalog.`), `pg_*` / `dblink` / `set_config` functions, references
   to `users`, `email`, `password_hash`, unknown bind parameters, and any query without the tenant predicate.
   Oversized `LIMIT`s are clamped to `AGENT_MAX_ROWS`.
3. **Sandboxed execution**: inside one transaction AuditX creates `TEMP VIEW`s named after every tenant table,
   filtered to the caller's `org_id` (PostgreSQL resolves `pg_temp` before `public`), switches the transaction
   to `READ ONLY`, applies `statement_timeout`, runs the query through Pandas and **always rolls back**. Even an
   `OR 1=1` that slips past the prompt only ever sees the caller's rows.
4. Without `OPENAI_API_KEY`, a deterministic intent router generates the SQL. It goes through the same guard.

## 5. Local sandbox launch (zero cost)

### 5.1 Prerequisites

* Docker Desktop (or Docker Engine + compose plugin)
* Python 3.12+ (only for running outside Docker)
* Node.js 18.17+ (20 LTS recommended)

### 5.2 Option A: full stack in Docker (recommended)

```bash
cd auditx-backend
cp .env.example .env                 # optional: add OPENAI_API_KEY
docker compose up -d --build         # api, worker, db, redis
docker compose ps                    # wait until api and worker show "healthy"
curl http://localhost:8000/health

# migrations run automatically on api start; to run them by hand:
docker compose exec api python -m app.database

# seed 20,000 orders with a 5% anomaly mix (+1% FX micro-variances) and reconcile
docker compose exec api python -m app.utils.seeder --orders 20000 --fx-noise-rate 0.01 --reconcile

# watch the Celery worker
docker compose logs -f worker
```

The seeder prints `demo@auditx.io / AuditX#Demo2026`.

### 5.3 Option B: Python virtualenv against Dockerised Postgres + Redis

```bash
cd auditx-backend
docker compose up -d db redis

python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                 # DATABASE_URL / REDIS_URL already point at localhost
mkdir -p uploads

python -m app.database               # structural migration + data dictionary seed
python -m app.utils.seeder --orders 20000 --fx-noise-rate 0.01 --reconcile

# terminal 1: API
uvicorn app.main:app --reload --port 8000
# terminal 2: worker
celery -A app.workers.tasks worker -Q default,ingest,reconcile --loglevel=INFO
```

### 5.4 Frontend

```bash
cd auditx-frontend
cp .env.example .env.local           # NEXT_PUBLIC_API_URL=http://localhost:8000
npm install
npm run dev                          # http://localhost:3000/dashboard
# production check
npm run typecheck && npm run lint && npm run build && npm start
```

### 5.5 Test the parser with dirty SAP / gateway exports

```bash
# writes sap_sales_orders.csv + gateway_settlements.csv, creates a new empty org with SAP-style
# header mappings, and an owner login for it
docker compose exec api python -m app.utils.seeder --orders 50000 --export-csv /data/uploads/samples \
  --export-only --company-name "Parser Pilot Co" --email parser@auditx.io --password 'Parser#Pilot2026'
docker compose cp api:/data/uploads/samples ./samples
```

Sign in as `parser@auditx.io`, then use **Upload ERP orders** / **Upload gateway file** in the dashboard
and press **Run reconciliation + auto-heal**, or use the API:

```bash
TOKEN=$(curl -s -X POST localhost:8000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"parser@auditx.io","password":"Parser#Pilot2026"}' | python -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -X POST localhost:8000/api/v1/ingest/ecom_orders -H "Authorization: Bearer $TOKEN" -F file=@samples/sap_sales_orders.csv
curl -X POST localhost:8000/api/v1/ingest/gateway_transactions -H "Authorization: Bearer $TOKEN" -F file=@samples/gateway_settlements.csv
curl -X POST localhost:8000/api/v1/reconciliation/run -H "Authorization: Bearer $TOKEN"
curl localhost:8000/api/v1/jobs -H "Authorization: Bearer $TOKEN"
```

Large files: the upload is streamed to disk in `UPLOAD_STREAM_BLOCK_BYTES` blocks, and the worker parses it in
`PARSER_CHUNK_ROWS` row chunks with a `COPY` per chunk, so memory stays flat for 500 MB+ exports.
Raise `MAX_UPLOAD_MB` if you need bigger files.

### 5.6 Reset

```bash
docker compose down -v               # removes pgdata, redisdata and uploads volumes
```

## 6. Production free-tier roadmap (Vercel + Render + Neon)

> Free-tier limits change often. Check each provider's pricing page before launch. As of this writing:
> Vercel **Hobby** is for personal, non-commercial use, so move to Pro once you bill customers. Render free web
> services **sleep after ~15 minutes idle** (the first request after that takes 30–60 s), have 512 MB RAM, no
> persistent disk and no free background workers. Neon free projects scale compute to zero when idle and
> have a small storage quota (about 0.5 GB).

### 6.1 Neon serverless PostgreSQL (database)

1. Sign up at neon.tech → **Create project** (`auditx`, PostgreSQL 16, region closest to Render's region).
2. **Dashboard → Connection details**: copy the *pooled* connection string, e.g.
   `postgresql://auditx_owner:****@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`.
   The transaction-mode pooler is compatible with AuditX: each agent query, migration and bulk load runs in a single
   transaction.
3. Migrate and seed from your laptop (still $0):

```bash
cd auditx-backend && source .venv/bin/activate
export DATABASE_URL='postgresql://...-pooler.../neondb?sslmode=require'
python -m app.database
python -m app.utils.seeder --orders 20000 --fx-noise-rate 0.01 --reconcile
```

### 6.2 Render (FastAPI runtime)

Two zero-cost topologies:

| Mode | Settings | Trade-off |
|------|----------|-----------|
| **Eager (recommended for MVP)** | `CELERY_TASK_ALWAYS_EAGER=true`, `ROLE=api`, `WEB_CONCURRENCY=1` | No Redis needed. Jobs run in the API process right after the 202 response |
| **Embedded worker** | `ROLE=all`, `REDIS_URL` = Render Key Value (free) or Upstash Redis (free) internal URL, `CELERY_CONCURRENCY=1` | Real Celery queue in the same container; watch the 512 MB RAM ceiling |

Steps (blueprint):

1. Push this repository to GitHub.
2. Render → **New → Blueprint** → select the repo. Render reads `render.yaml` and creates `auditx-api`
   (Docker, free plan, health check `/health`).
3. Fill the secrets when prompted:
   * `DATABASE_URL` = Neon pooled URL
   * `CORS_ORIGINS` = `https://<your-app>.vercel.app`
   * `OPENAI_API_KEY` = optional
   `JWT_SECRET` is generated automatically.
4. Deploy, then open `https://auditx-api.onrender.com/health` and `/docs`.

Manual alternative: **New → Web Service** → Docker, *Dockerfile path* `auditx-backend/Dockerfile`,
*Docker build context* `auditx-backend`, instance type **Free**, health check `/health`, the same environment
variables as `render.yaml`. Render injects `PORT`, and `start.sh` binds to it.

Recommended free-tier tuning: `PARSER_CHUNK_ROWS=50000`, `MAX_UPLOAD_MB=200`, `AGENT_MAX_ROWS=500`.
Uploaded files are deleted after parsing, so the ephemeral disk is enough.

### 6.3 Vercel (Next.js web nodes)

1. vercel.com → **Add New → Project** → import the repo.
2. **Root Directory**: `auditx-frontend`. The framework preset is detected as Next.js.
3. **Environment Variables**: `NEXT_PUBLIC_API_URL=https://auditx-api.onrender.com`.
4. Deploy. Add the resulting `https://<project>.vercel.app` to Render's `CORS_ORIGINS` and redeploy the API.

### 6.4 Keeping the MVP warm (optional, still free)

Render free services sleep when idle. Before demos, hit `/health` once. A free uptime monitor
(for example UptimeRobot every 10 minutes) avoids cold starts, but it uses up the monthly free instance hours,
so only enable it during pilot weeks.

### 6.5 Graduation path

| Trigger | Upgrade |
|---------|---------|
| First paying customer | Vercel Pro (commercial use), Render Starter (no sleep) |
| Files > 200 MB or long jobs | Render Background Worker with `ROLE=worker` + managed Redis |
| > 0.5 GB data | Neon Launch plan, or partition `ecom_orders` / `gateway_transactions` by `org_id` hash |
| Enterprise / Big 4 | Dedicated DB per tenant, SSO (SAML/OIDC), customer-managed keys, SOC 2 controls |

## 7. Production hardening checklist

* Set a strong `JWT_SECRET` (`python -c "import secrets; print(secrets.token_urlsafe(64))"`).
* Restrict `CORS_ORIGINS` to your exact frontend origin(s).
* Use a dedicated PostgreSQL role for the API with no superuser rights. The agent sandbox needs only
  `TEMP` privilege (granted to `PUBLIC` by default).
* Terminate TLS at the platform edge (Render / Vercel do this automatically).
* Back up PostgreSQL (Neon has point-in-time restore. Locally, use `pg_dump`).
* Monitor `audit_jobs` for `FAILED` rows and the Celery worker logs.
