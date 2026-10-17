# AuditX — Playwright UI automation

Black-box tests that drive a real Chromium browser through the AuditX dashboard, exactly as a user would.

## What is tested

| Spec | Use case | Scenario |
|---|---|---|
| `auth.spec.ts` | UC-01 | Wrong password shows one generic error |
| | UC-01 | Owner signs in, sees the command center, signs out (also on mobile) |
| | UC-01 | Session survives a page reload |
| | UC-02 | Changing the password keeps this session and kills the old token |
| `dashboard.spec.ts` | UC-04 | Metrics show the 4 planted findings and 1 awaiting approval |
| | UC-04 | Tracking matrix filters by status, channel, issue type and search |
| | UC-04 | Expanding a finding shows the AI's proposed fix |
| | UC-08 | Forensic chat answers with tenant-scoped, read-only SQL |
| | UC-08 | A prompt-injection question cannot change data |
| `maker-checker.spec.ts` | UC-05 | Analyst's resolution goes to a checker, not straight to resolved |
| | UC-06 | Auditor approves → finding resolved |
| | UC-06 | Auditor rejects the AI fix with a reason → finding reopens |
| `team.spec.ts` | UC-09 | Owner invites an auditor by link; invitee joins; link works only once |
| | UC-10 | Member added with a temporary password must choose their own |
| | UC-11 | Analysts don't get team-management controls |

Use cases and business test cases: `docs/testing/USE_CASES.md`, `docs/testing/BUSINESS_TEST_CASES.md`.

## Test data (`e2e/test-data/`)

Each spec registers a **brand-new company** through the API, adds its users, uploads these four files and runs reconciliation, so every run starts clean and never touches real data.

| File | Contents |
|---|---|
| `01_erp_orders.csv` | 5 ERP orders: 3 card (O1, O2, O4) and 2 cash-on-delivery (C1, C2) |
| `02_gateway_transactions.csv` | 3 gateway captures in payout `po_A`: O1 is correct, O3 has no ERP order, O4 is 5.00 short |
| `03_courier_remittances.csv` | TCS parcels: C1 remitted (CPR-1), C2 delivered but never remitted, T9 still in transit |
| `04_bank_statement.csv` | Bank credits for payout `po_A` (209.80) and courier remittance CPR-1 (57.50) |
| `users.csv` | The 5 test users, their roles and passwords |
| `expected_results.csv` | What AuditX must find and why: 4 findings, 4 clean matches |

**Expected findings:** O2 *Missing Payment* 55.00 · O3 *Untracked Revenue* 42.00 · O4 *Amount Mismatch* 5.00 (AI fix waits for a checker) · C2 *COD Not Remitted* 70.00.

## How to run

```bash
# 1. Start AuditX (from the repo root): docker compose up   — or uvicorn + celery + next start
# 2. From auditx-frontend/
npm ci
npx playwright install chromium                    # once
npx playwright test                                # all specs, desktop + mobile
npx playwright test e2e/maker-checker.spec.ts      # one spec
npx playwright test --headed                       # watch the browser
E2E_EVIDENCE=1 npx playwright test                 # screenshot + video + trace of every test
npx playwright show-report e2e-report              # open the HTML report
```

| Variable | Default | Meaning |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:3000` | Dashboard URL |
| `E2E_API_URL` | `http://localhost:8000` | API URL used to create test companies |
| `E2E_CHROMIUM_PATH` | — | Use an existing Chromium binary |
| `E2E_EVIDENCE` | — | Record screenshots, videos and traces for every test |
