# AuditX — Test Strategy

| Item | Value |
|---|---|
| Product | AuditX: multi-tenant reconciliation, AI Auto-Healer, maker-checker, forensic ledger agent |
| Scope | `auditx-backend` (FastAPI, Celery, PostgreSQL) and `auditx-frontend` (Next.js) |
| Test levels | Unit · Integration · API (black box) · UI end-to-end (black box) · Regression · Ad-hoc / exploratory |
| Automation | `pytest` (backend), `@playwright/test` (UI), GitHub Actions (`.github/workflows/auditx-ci.yml`) |
| Related documents | [USE_CASES.md](USE_CASES.md) · [BUSINESS_TEST_CASES.md](BUSINESS_TEST_CASES.md) · [TEST_REPORT.md](TEST_REPORT.md) |

## 1. What matters most (risk-based priorities)

AuditX moves money decisions, so testing effort follows business risk:

| Risk | Why it matters | Where it is tested |
|---|---|---|
| **Wrong money maths** | A wrong variance means a missed leak or a false alarm in the books | Unit (cents, rounding, currency parsing), Integration (planted scenario), Regression (multi-seed planted-vs-found) |
| **Cross-tenant data leak** | One company seeing another's ledger ends the business | API tenant-isolation tests, agent sandbox `OR 1=1` tests, guard white-box tests |
| **Segregation of duties broken** | A maker approving their own write-off defeats the audit control | Integration + API maker-checker tests, UI flow UC-05/06 |
| **Agent writes or escapes its sandbox** | An LLM generating `DELETE` or reading `users` | Guard unit tests, read-only sandbox, statement timeout, prompt-injection tests |
| **Ingestion of messy files** | Real ERP/bank/courier exports are dirty | Parser unit tests (formats), integration (BOM, `;`, chunks), ad-hoc (UTF-16, binary, huge values) |
| **Recovery counted wrongly** | Money "recovered" that never came back, or counted twice, misstates the books | Integration (part payment in data, data match plus recorded payment), API (overpayment refused), UI UC-15/16 |
| **Account takeover** | Weak sessions, never-expiring tokens | Tampered/expired/no-`exp` JWT, password change revokes sessions, invite token single-use |

## 2. Test levels and techniques

### 2.1 Unit tests — white box (`tests/unit`, marker `unit`)
Each pure function is tested branch by branch, from the code:
* **Parser** — currency cleaning (symbols, `Rs.`, European `1.234,56`, `(12.50)`, trailing minus, scientific notation), half-cent rounding, transformation rules, date parsing, column resolution, chunk transforms for all four file types, bank fingerprints, merge SQL.
* **Reconciliation** — the gateway classifier and its tolerance, bank reference/amount matching, settlement keyword filter, COD parcel aggregation.
* **Auto-Healer** — every branch of `evaluate`, `evaluate_bank`, `evaluate_cod` (statement coverage of the rule book).
* **Security** — SQL guard allow/deny table, every heuristic SQL template passes the guard, every tenant table is shadowed in the sandbox (computed from the DDL so new tables cannot be forgotten), password hashing, tokens, mailer escaping.

Techniques: equivalence partitioning and boundary values (tolerance ±0.01, `0.005`, `MAX_ABS_AMOUNT`), decision tables (approval policy), branch coverage.

### 2.2 Integration tests (`tests/integration`, marker `integration`)
Real PostgreSQL (`auditx_test`) with the real DDL. A hand-built company (`build_company`) plants **exactly 13 known anomalies** across the gateway, bank and COD legs; the test asserts every one is found with the right type, amounts and sign, and nothing else. Also: idempotent re-ingestion, re-runs without duplicates, approvals state machine, and the agent sandbox (read-only, timeout, row cap, temp-view cleanup).

### 2.3 API tests — black box (`tests/api`, marker `api`)
Only HTTP requests and responses, no internal imports: status codes (202/401/403/404/409/410/415/422), validation, authorisation per role, tenant isolation, background job lifecycle, invitations, passwords, agent.

### 2.4 UI end-to-end — black box (`auditx-frontend/e2e`)
Playwright drives Chromium against a running stack. Each spec registers a **fresh company through the public API** and uploads a known dataset, so runs are repeatable and independent of demo data. Covers the business use cases UC-01…UC-11.

### 2.5 Regression (`tests/regression`, marker `regression`)
* One pinned test per defect (DEF-01 … DEF-08 and earlier development bugs).
* **Planted-vs-found** whole-system test: the seeder plants thousands of rows with a known mix of 16 anomaly kinds for three random seeds; after reconciliation + Auto-Healer every planted anomaly must be found once under the right root cause and nothing else (no false positives).

### 2.6 Ad-hoc / exploratory
A time-boxed session with "what if" inputs: odd encodings, binary files, huge / scientific amounts, over-long identifiers, NUL bytes, SQL-injection strings, XSS strings, forged / expired / claim-less JWTs, concurrent double approval, prompt injection. Every bug found becomes a regression test. Results are in the test report.

## 3. Environments and data

| Environment | How |
|---|---|
| Backend tests | PostgreSQL 16 database **`auditx_test`** (the suite refuses any other name), Celery in eager mode, no OpenAI key, no SMTP |
| UI tests | Any running stack: `docker compose up` or `uvicorn` + `celery` + `next start`; `E2E_BASE_URL`, `E2E_API_URL` |
| Test data | Created per test; `TRUNCATE organizations CASCADE` before each backend test; unique company per UI spec |

## 4. How to run

```bash
# backend (from auditx-backend/)
createdb auditx_test                      # once
pip install -r requirements-dev.txt
pytest                                    # everything
pytest -m unit                            # fast, no database needed
pytest -m "integration or api"            # needs PostgreSQL
pytest -m regression                      # pinned defects + planted-vs-found
pytest --cov=app --cov-report=term-missing

# UI (from auditx-frontend/, with the stack running)
npm ci && npx playwright install chromium   # skip install where a browser is preinstalled
npx playwright test                       # report in e2e-report/
```

## 5. Entry and exit criteria

* **Entry:** code builds, migrations (`init_db`) apply on an empty database.
* **Exit for a release:** 100% of automated tests pass; no open High/Critical defects; every fixed defect has a regression test; coverage of `app/services` ≥ 85%.

## 6. Defect severity

| Severity | Meaning |
|---|---|
| Critical | Data loss, cross-tenant exposure, money moved wrongly with no trace |
| High | Wrong financial result or security weakness with a realistic path |
| Medium | A feature fails for a class of valid input; a 500 instead of a clear error |
| Low | Cosmetic, accessibility, misleading message |
