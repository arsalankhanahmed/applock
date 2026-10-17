# AuditX — Deployment & Operations Manual

AuditX is a multi-tenant B2B platform that reconciles three money trails, auto-heals known break patterns,
and lets auditors interrogate the ledger in plain English:

| Leg | Compares | Catches |
|-----|----------|---------|
| **Gateway** | prepaid ERP / storefront orders ↔ payment-gateway captures | missing payments, untracked revenue, amount mismatches |
| **Bank** | gateway payouts + courier COD remittances ↔ bank statement credits | payouts never banked, short deposits, unidentified credits |
| **COD** | cash-on-delivery orders ↔ courier parcel reports (TCS, Leopards, PostEx, Trax, …) | cash not remitted, short remittance, rider short collection, courier overcharges, returns still booked as sales, lost / stuck parcels |

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
    │   ├── reconciliation.py  # orchestrator + gateway leg (Pandas full outer join) -> discrepancy_logs
    │   ├── bank_reconciliation.py # bank leg: settlement batches <-> statement credits
    │   ├── cod_reconciliation.py  # COD leg: COD orders <-> courier parcel reports
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
| `ecom_orders` | ERP / storefront orders, `payment_method` `PREPAID` or `COD` | `UNIQUE(org_id, source_order_number)` |
| `gateway_transactions` | Gateway captures, with the `payout_reference` they were paid out in | `UNIQUE(org_id, source_transaction_id)`, indexes on order and payout |
| `bank_transactions` | Bank statement lines (credit positive, debit negative) | `UNIQUE(org_id, bank_reference)`; a stable fingerprint is generated when the bank gives no reference |
| `courier_remittances` | One row per COD parcel: status, cash collected, charges, net remitted, remittance (CPR) number | `UNIQUE(org_id, tracking_number)`; re-uploads **update** a parcel (latest report wins) |
| `discrepancy_logs` | Findings + AI verdicts; `channel` = `GATEWAY` / `BANK` / `COD`; `order_amount` = expected, `gateway_amount` = received | `issue_type` / `channel` / `status` checks, `resolved_at` required when resolved |
| `resolution_requests` | Maker-checker trail: every proposed resolution (AI or person), its decision, maker and checker, notes; the finding is snapshotted so the trail survives reconciliation | one `PENDING` request per finding; `log_id` set to NULL (not deleted) if the finding is rebuilt |
| `approval_policies` | One row per tenant: what the AI and people may resolve without a checker | mode / amount checks |
| `audit_jobs` | Tenant-scoped background job ledger | `job_type` / `status` checks |

Enumerations (issue types, job types, dictionary tables) live in named check constraints that the migration
drops and re-adds, so upgrading an existing database only needs `python -m app.database`.

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
| POST | `/ingest/{ecom_orders\|gateway_transactions\|courier_remittances\|bank_transactions}` | Multipart upload, streamed to disk in 1 MB blocks → **202 Accepted** |
| POST | `/reconciliation/run` | `{"auto_heal": true}` → **202 Accepted**; runs all three legs |
| GET | `/jobs`, `/jobs/{job_id}` | Job status and result payloads |
| GET | `/discrepancies` | Filters: `status`, `channel`, `issue_type`, `auto_resolved`, `search`, `sort`, `limit`, `offset` |
| POST | `/discrepancies/{log_id}/resolve` | Maker step: propose a resolution with a note; resolves at once or goes to `PENDING_APPROVAL` per policy |
| GET | `/approvals` | Approval queue; filters `status` (`PENDING` default), `proposed_by_type` (`AI` / `USER`) |
| POST | `/approvals/{request_id}/approve` / `reject` | Checker step (OWNER / ADMIN / AUDITOR, never the maker); reject needs a `note` |
| POST | `/approvals/{request_id}/withdraw` | Maker takes back their own pending request |
| POST | `/approvals/bulk-approve` | `{"request_ids": [...]}`; each request is checked on its own, failures listed |
| GET / PUT | `/approval-policy` | Read / change the tenant's approval policy (PUT: OWNER / ADMIN) |
| GET / POST | `/users` | List team members / add one (OWNER / ADMIN), e.g. an AUDITOR to act as checker |
| PATCH / DELETE | `/users/{user_id}` | Change a member's role or name, reset their password / remove them (OWNER / ADMIN) |
| POST | `/me/password` | Change your own password (`current_password`, `new_password`); returns a fresh token |
| POST / GET | `/invites` | Invite by email (OWNER / ADMIN) / list pending invites (`include_closed` for history) |
| POST / DELETE | `/invites/{invite_id}/resend`, `/invites/{invite_id}` | New link + email / revoke |
| GET / POST | `/invites/token/{token}`, `/invites/token/{token}/accept` | Public: show an invite / accept it with `full_name` + `password` (signs the person in) |
| GET | `/dashboard/metrics` | KPIs, per-channel and per-issue exposure, root causes, per-courier COD ledger |
| GET | `/recovery/summary`, `/recovery/claimable` | Recovered this month / to date, open claims, and open findings owed by a courier, gateway or bank (grouped by counterparty) |
| GET / POST | `/claims` | List claims (`status=OPEN` or a claim status) / draft one from `log_ids` of one counterparty (OWNER / ADMIN / ANALYST) |
| GET | `/claims/{claim_id}`, `/claims/{claim_id}/letter` | Claim with items, timeline and letter / the letter as subject, text and print-ready HTML |
| POST | `/claims/{claim_id}/submit` | Mark as sent; `{"send_email": true, "counterparty_contact": "..."}` emails the letter |
| POST | `/claims/{claim_id}/payments` | `{"amount", "reference", "received_on"}`; refused above the outstanding balance |
| POST | `/claims/{claim_id}/reject` / `write-off` / `cancel` | Counterparty refused (needs `note`) / stop chasing the balance (needs `note`) / drop a draft |
| GET | `/couriers/scorecard?days=90`, `/couriers/scorecard.csv` | Per-courier grade and score, delivery success, days to remit, on-time %, charges, money owed and claims (any role; `days` 7–730) |
| GET / PUT | `/alerts/settings` | Optional WhatsApp / email digest settings (off by default) and what the server can send (OWNER / ADMIN) |
| GET / POST | `/alerts/recipients` | List / add a recipient: `name`, `channel` (`WHATSAPP` or `EMAIL`), `address` (E.164 phone or email), `consent: true` (OWNER / ADMIN) |
| PATCH / DELETE | `/alerts/recipients/{recipient_id}` | Pause / resume (`active`) or remove a recipient |
| GET | `/alerts/preview` | What the next digest would say (any role) |
| POST | `/alerts/test` | Send the digest now to all active recipients, or one `recipient_id`; works while alerts are off |
| GET | `/alerts/deliveries` | Recent sends with status and error; addresses are masked |
| POST | `/internal/alerts/run-due` | Cron hook for hosts without a Celery worker; header `X-Cron-Token: $ALERTS_CRON_TOKEN` (404 when unset) |
| POST | `/agent/query` | `{"question": "..."}` → SQL, rows, narrative |

## 4. Bank and COD reconciliation

### 4.1 Bank leg

Every **settlement batch** is expected to land in the bank as one credit:

* a gateway payout = all captures sharing a `payout_reference` (expected amount = sum of `net_amount`);
* a courier remittance = all parcels sharing a `remittance_reference` / CPR number (sum of `net_remitted`).

Matching runs in two passes against statement credits: first by **reference** (the payout or CPR number
appears in the narration or bank reference), then by **exact amount within `BANK_MATCH_WINDOW_DAYS`** of the
batch closing, for banks that truncate narrations.

| Finding | Meaning | Auto-Healer |
|---------|---------|-------------|
| `SETTLEMENT_NOT_DEPOSITED` | batch older than `SETTLEMENT_LAG_DAYS` (vs. the last statement date) with no credit | `GATEWAY_PAYOUT_NOT_RECEIVED` / `COURIER_REMITTANCE_NOT_RECEIVED`: request a payment trace |
| `DEPOSIT_MISMATCH` | credit found, amount differs | under $0.50: `FX_ROUNDING_ERROR` (auto); ≤ 0.5% and ≤ $25: `BANK_CHARGES_DEDUCTED` (auto, journal to bank charges); else `UNEXPLAINED_SETTLEMENT_SHORTFALL` / `SETTLEMENT_OVER_DEPOSIT` |
| `UNMATCHED_DEPOSIT` | a credit whose narration names a gateway or courier but matches no batch | `UNIDENTIFIED_SETTLEMENT_CREDIT`: allocate or park in suspense |

Credits that don't look like settlements (loans, profit on deposit, capital) are ignored and counted in the
report. Without a bank statement the leg is skipped, so nothing is flagged by mistake.

### 4.2 COD leg

Orders marked `COD` are taken out of the gateway leg and compared with the courier's parcel report instead.
"Today" is the latest date in the tenant's own courier data, so results don't drift with the wall clock.

| Finding | Meaning | Auto-Healer |
|---------|---------|-------------|
| `COD_PARCEL_UNTRACKED` | COD order older than `COD_DISPATCH_SLA_DAYS` that no courier has | `COD_ORDER_NOT_DISPATCHED` |
| `COD_ORDER_NOT_BOOKED` | courier delivered and collected cash for an order the ERP doesn't have | `UNBOOKED_COD_SALE` + journal |
| `COD_NOT_REMITTED` | delivered, no remittance after `COD_REMITTANCE_SLA_DAYS` | `COURIER_REMITTANCE_OVERDUE`: raise a claim |
| `COD_REMITTANCE_SHORTFALL` | remitted less than order total minus charges | `RIDER_SHORT_COLLECTION` (cash collected < order) or `COURIER_UNEXPLAINED_DEDUCTION` |
| `COURIER_OVERCHARGE` | charge above `COURIER_OVERCHARGE_RATIO` × that courier's median charge | `EXCESS_COURIER_CHARGES`: dispute the invoice |
| `RETURNED_ORDER_BOOKED` | parcel returned but the ERP still carries the sale | `REVENUE_NOT_REVERSED_ON_RETURN` + sales-return journal |
| `PARCEL_LOST_OR_STUCK` | courier reports lost, or in transit longer than `PARCEL_STUCK_DAYS` | `PARCEL_LOST_IN_TRANSIT` (loss claim) / `PARCEL_STUCK_IN_TRANSIT` |

COD findings are never auto-resolved: each one is money to recover from a courier or a booking to change, so a
person approves it.

### 4.3 Uploading courier reports and bank statements

* **Courier report** columns: tracking number, order reference, courier, status, COD amount, delivery charges,
  net payable, CPR / remittance number, booking / delivery / payment dates. Courier wording such as
  "Delivered", "Returned to Shipper", "RTO", "Out for delivery" or "Lost" is normalised automatically.
  Upload the latest report whenever you like: parcels update in place.
* **Bank statement** columns: value date, narration, and either one signed amount column or separate
  Debit / Credit columns. A reference column is optional.

Timing thresholds are environment settings: `SETTLEMENT_LAG_DAYS` (7), `BANK_MATCH_WINDOW_DAYS` (10),
`COD_DISPATCH_SLA_DAYS` (7), `COD_REMITTANCE_SLA_DAYS` (10), `PARCEL_STUCK_DAYS` (21),
`COURIER_OVERCHARGE_RATIO` (1.5).

### 4.4 Maker-checker approvals

No single person, and not the AI, can close a finding that changes the books on their own:

1. **Maker** proposes. A person presses **Resolve** with a note, or the Auto-Healer produces a fix it would
   apply. A `resolution_requests` row is written and the finding moves to `PENDING_APPROVAL`.
2. **Checker** decides in the **Approvals** inbox: approve (finding → `RESOLVED`) or reject with a reason
   (finding → `UNRESOLVED`, reason kept). Checkers are OWNER, ADMIN or AUDITOR; **the maker can never decide
   their own request**, and only the maker can withdraw it.
3. Every step is recorded: who proposed, who decided, when, both notes, and the proposed fix itself.

The per-company **approval policy** (Approvals → Policy, owners and admins only) sets what skips the queue:

| Setting | Default | Meaning |
|---------|---------|---------|
| AI Auto-Healer mode | `THRESHOLD` | `AUTO`: AI fixes post immediately · `THRESHOLD`: AI fixes up to the limit post, larger ones wait · `ALWAYS_APPROVE`: every AI fix waits |
| AI auto-post limit | 1.00 | With `THRESHOLD`: sub-$1 rounding posts by itself; promo patches, fee reclassifications and bank-charge entries wait for a checker |
| Manual resolutions need a second person | on | People's resolutions wait for a checker |
| Manual auto-approve limit | 0 | Manual resolutions up to this amount skip the queue |

Fixes that skip the queue are still recorded, as requests approved by `policy:auto`. Pending findings count
as open leakage until approved. Re-running reconciliation keeps pending findings, and an AI fix a checker
rejected is not proposed again for the same finding.

The seeder creates a checker login next to the owner (`demo+checker@auditx.io`, same password, role
AUDITOR), so the workflow can be tried straight away. Add real team members from the **Team** panel.

### 4.5 Team members and roles

The **Team** panel (header link "Team") lists everyone in the company. Owners and admins can add members,
change roles, reset passwords and remove people:

| Role | Can do |
|------|--------|
| OWNER | Everything, including other owners, the approval policy and the team |
| ADMIN | Manage the team (not owners) and the approval policy; approve |
| ANALYST | Upload files, run reconciliation, propose fixes (maker) |
| AUDITOR | Approve or reject fixes (checker); can also propose |
| VIEWER | Read-only dashboard and chat |

Rules: only an owner can create, change or remove an owner; nobody can change their own role or remove
themselves; a company always keeps at least one owner.

**Adding someone** (Team → Add member), two ways:

* **Send email invite** (recommended). The person gets an email with a one-time link (valid
  `INVITE_EXPIRY_DAYS`, default 7) to `/invite`, where they choose their name and password and are signed in.
  Pending invites are listed under the team with **Resend** (new link, old one stops working) and **Revoke**.
  Only a SHA-256 hash of the link is stored. If email isn't configured or sending fails, the invite is still
  created and the link is shown once to copy and share yourself.
* **Set a temporary password.** The **Generate** button makes a strong one, shown once to share privately.
  The person must choose their own password at first sign-in; until then the API only allows `/me` and
  `/me/password`.

**Passwords.** Anyone can change their password from **Change password** in the header. Changing it, or an
admin resetting it, signs out every other session of that account (tokens issued before the change stop
working). An admin reset also makes the person choose a new password at next sign-in. Roles are read from the database
on every request, so a role change or removal takes effect immediately, even for someone already signed in.
A removed member's approval history stays, with their email on each request.

### 4.6 Sending invitation email

Set these on the API (and worker) service; any SMTP provider works:

| Variable | Example |
|----------|---------|
| `APP_BASE_URL` | `https://auditx.vercel.app` (links in emails point here) |
| `SMTP_HOST`, `SMTP_PORT` | `smtp.gmail.com`, `587` · `smtp-relay.brevo.com`, `587` · `smtp.office365.com`, `587` |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | the account, or an app password / SMTP key |
| `SMTP_FROM` | `AuditX <no-reply@yourcompany.com>` (must be a sender your provider allows) |
| `SMTP_STARTTLS` / `SMTP_SSL` | `true` / `false` for port 587; `false` / `true` for port 465 |

For a zero-cost MVP, a Gmail account with an [app password](https://support.google.com/accounts/answer/185833)
or a free transactional-email plan (Brevo, Mailjet and similar offer small free daily quotas; check current
limits) is enough for team invites. For local testing, run a mail catcher such as Mailpit
(`docker run -p 8025:8025 -p 1025:1025 axllent/mailpit`) and set `SMTP_HOST=host.docker.internal`,
`SMTP_PORT=1025`, `SMTP_STARTTLS=false`; invites appear at `http://localhost:8025`.

### 4.7 Recovery & claims

Finding the leak is half the job; the **Recovery & Claims** panel gets the money back.

1. **Claimable** lists every open finding a counterparty owes, grouped by who owes it:
   * couriers: COD not remitted, short remittance, overcharged delivery, lost parcel;
   * the payment gateway: a payout never deposited or deposited short;
   * a courier remittance that never reached the bank, or bank charges.

   Customer-side and internal findings (missing payments, returns still booked, etc.) are never claimable.
2. **Create claim** turns the selected findings into a draft (`CLM-0001`, `CLM-0002`, …) with a claim letter
   built from the evidence: order, tracking number, delivery date, amount. The letter states the total, a due
   date (14 days by default) and asks for the claim number as the payment reference.
3. **Email letter** sends it to the counterparty over the same SMTP settings as invitations, with your address as
   Reply-To. **Mark as sent** is for letters you send yourself. **View letter**, **Copy letter** and
   **Print / PDF** are always available.
4. **Record payment** books each amount received, and a payment larger than the balance is refused.
   **Mark rejected** releases the findings so they can be claimed again or written off. **Write off balance**
   stops chasing the remainder.
5. **AuditX notices recovery by itself.** Every reconciliation re-checks open claims. When the courier's next
   report shows the order remitted, or the bank shows the payout, the claim is credited with a
   *"Payment seen in courier / bank data"* event. If only part was paid (an unpaid COD order becomes a smaller
   short remittance), only that part is credited. Recorded payments and data matches are both capped at the
   outstanding balance, so the same money is never counted twice.
6. **Closing goes through maker-checker.** When a claim is fully recovered or written off, each finding still
   open is submitted for resolution under the approval policy, as `RECOVERED_FROM_COUNTERPARTY` or `WRITE_OFF`,
   with the claim number and payment reference in the note. With the default policy a checker approves it.

While a finding is in an open claim it shows **Claimed · CLM-000n** in the tracking matrix and cannot be put in
a second claim. The headline tiles show money recovered this month, recovered to date (and as a % of amounts
claimed), the balance still out with counterparties, and what can be claimed now. The forensic agent answers
questions such as *"How much have we recovered from couriers?"* from the claim tables, which are tenant-isolated
like every other table.

Roles: OWNER, ADMIN and ANALYST run claims. AUDITOR and VIEWER can see them but not create or change them.

### 4.9 Courier scorecard

The **Courier Scorecard** panel compares every courier on the things that cost a COD business money, so a client
can decide who gets more parcels and negotiate rates with evidence.

| Measure | How it is worked out |
|---|---|
| Delivery success | delivered ÷ (delivered + returned + lost or stuck longer than `PARCEL_STUCK_DAYS`) |
| Days to remit | average (and 90th percentile) days from delivery to remittance |
| On time | remittances within `COD_REMITTANCE_SLA_DAYS` ÷ (all remittances + deliveries still unremitted past the SLA) |
| Avg charge / overcharged | average delivery charge on delivered parcels; parcels flagged `COURIER_OVERCHARGE` and the excess |
| Owes you | open COD findings the courier is responsible for (not remitted, short, overcharged, lost) |
| Claimed / recovered | from Recovery & Claims |

**Score (0–100)** is a weighted mix of five components:

| Component | Weight | How it scores |
|---|---|---|
| Remittance speed | 30% | 100 at ≤ 2 days, 0 at twice the SLA |
| Remitted on time | 20% | the on-time % |
| Delivery success | 20% | the delivery success % |
| Charge accuracy | 15% | −5 points per 1% of deliveries overcharged |
| Money not owed | 15% | −10 points per 1% of collected COD still owed |

A component with no data is left out, and the other weights are scaled up.

**Grades:** A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F below that. Couriers with fewer than 20 parcels are marked *low
volume*, and they only compete for the "best" badges when no courier has enough volume.

**The badges:** best overall, fastest to remit, best delivery rate, lowest charge.

The window covers parcels booked in the last 30, 90, 180 or 365 days, up to the **latest date in the courier
reports**. The scorecard therefore stays the same until new reports arrive, the same way the COD reconciliation
works. **Download CSV** exports the table, and the forensic agent answers questions like *"Which is the best
courier for us?"*.

### 4.8 WhatsApp alerts (optional, per client)

A short digest of what needs attention, sent on WhatsApp or by email every day or every Monday. It is
**off for every company** until its OWNER or ADMIN switches it on (*WhatsApp Alerts* panel), so it can be offered
on request or as a paid add-on.

The digest has four sections, each of which can be switched off:
* **COD stuck with couriers:** each courier holding cash for orders delivered more than *N* days ago (default 7).
  For example: *"TCS holds PKR 230,000 COD for 41 orders, oldest delivered 18 days ago"*.
* **Payouts not in the bank:** settlements never deposited, or deposited short.
* **Fixes waiting for a checker:** number of fixes, their value, and the age of the oldest.
* **Claims & recovery:** claims past their due date, money still claimable, and money recovered this month.

**Settings:**
* daily or weekly, the send hour and the time zone (default `Asia/Karachi`);
* a minimum amount, so small items don't create noise;
* whether to send an *"all clear"* message on quiet days.

**Recipients:** WhatsApp numbers in international format (`+923001234567`; `0092…` and spaces are accepted) or
email addresses. Adding one requires ticking *"They agreed to receive these alerts"*, because WhatsApp requires
opt-in. The time of consent is stored. Recipients can be paused or removed.

**Send test now** sends the current digest to the active recipients, even while alerts are off, and every send
appears in *Recent deliveries*. The delivery log stores masked addresses only, and the forensic agent cannot read
any alert table.

**Server setup** (once, by whoever hosts AuditX):

| `WHATSAPP_PROVIDER` | What you need |
|---|---|
| `meta` | A WhatsApp Business account on Meta's Cloud API: `WHATSAPP_META_TOKEN` (permanent system-user token), `WHATSAPP_META_PHONE_NUMBER_ID`, and an **approved message template** named `WHATSAPP_TEMPLATE_NAME` (default `auditx_daily_alert`) with three body parameters, e.g. *"AuditX alert for {{1}}: {{2}}. Details: {{3}}"* |
| `twilio` | `WHATSAPP_TWILIO_ACCOUNT_SID`, `WHATSAPP_TWILIO_AUTH_TOKEN`, `WHATSAPP_TWILIO_FROM` (your WhatsApp sender, e.g. the sandbox `+14155238886`), and for production a Content template `WHATSAPP_TWILIO_CONTENT_SID` with the same three variables |
| `log` | Nothing: messages go to the server log and the delivery log only. Use this for demos and testing |
| *(empty)* | WhatsApp is off on this server; the panel says so. Email alerts work wherever SMTP is set |

WhatsApp only delivers business-initiated messages through approved templates. Template parameters cannot
contain line breaks, so AuditX sends the digest as one line with ` | ` between items. Conversation-based pricing
applies on both providers, so check the current rates for your country.

**Scheduling:**
* With a worker, the Celery worker runs a scheduler (`celery … --beat`, enabled by `start.sh`) that checks every
  15 minutes. Run the scheduler in one worker only: set `CELERY_BEAT=false` on any extra replicas.
* On the free single-container plan there is no worker. Set `ALERTS_CRON_TOKEN` and have any cron service (for
  example a scheduled GitHub Actions workflow, or cron-job.org) call:

  ```bash
  curl -X POST -H "X-Cron-Token: $ALERTS_CRON_TOKEN" https://<your-api>/api/v1/internal/alerts/run-due
  ```
  every 15–30 minutes.

Each recipient gets at most one digest per day or week, however often the job runs. A failed send is retried on
later runs, up to `ALERTS_MAX_ATTEMPTS` (default 3).

## 5. Security model of the Forensic Agent

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

## 6. Local sandbox launch (zero cost)

### 6.1 Prerequisites

* Docker Desktop (or Docker Engine + compose plugin)
* Python 3.12+ (only for running outside Docker)
* Node.js 18.17+ (20 LTS recommended)

### 6.2 Option A: full stack in Docker (recommended)

```bash
cd auditx-backend
cp .env.example .env                 # optional: add OPENAI_API_KEY
docker compose up -d --build         # api, worker, db, redis
docker compose ps                    # wait until api and worker show "healthy"
curl http://localhost:8000/health

# migrations run automatically on api start; to run them by hand:
docker compose exec api python -m app.database

# seed 20,000 orders (35% COD) with gateway, courier and bank data, planted anomalies on every leg
# (+1% FX micro-variances), then reconcile
docker compose exec api python -m app.utils.seeder --orders 20000 --fx-noise-rate 0.01 --reconcile

# watch the Celery worker
docker compose logs -f worker
```

The seeder prints `demo@auditx.io / AuditX#Demo2026`.

### 6.3 Option B: Python virtualenv against Dockerised Postgres + Redis

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

### 6.4 Frontend

```bash
cd auditx-frontend
cp .env.example .env.local           # NEXT_PUBLIC_API_URL=http://localhost:8000
npm install
npm run dev                          # http://localhost:3000/dashboard
# production check
npm run typecheck && npm run lint && npm run build && npm start
```

### 6.5 Test the parser with dirty SAP / gateway / courier / bank exports

```bash
# writes sap_sales_orders.csv, gateway_settlements.csv, courier_cod_report.csv and bank_statement.csv,
# creates a new empty org with matching header mappings, and an owner login for it
docker compose exec api python -m app.utils.seeder --orders 50000 --export-csv /data/uploads/samples \
  --export-only --company-name "Parser Pilot Co" --email parser@auditx.io --password 'Parser#Pilot2026'
docker compose cp api:/data/uploads/samples ./samples
```

Sign in as `parser@auditx.io`, pick each file type in the upload menu, press **Upload file** for each of the
four CSVs, then press **Run reconciliation + auto-heal**. Or use the API:

```bash
TOKEN=$(curl -s -X POST localhost:8000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"parser@auditx.io","password":"Parser#Pilot2026"}' | python -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -X POST localhost:8000/api/v1/ingest/ecom_orders -H "Authorization: Bearer $TOKEN" -F file=@samples/sap_sales_orders.csv
curl -X POST localhost:8000/api/v1/ingest/gateway_transactions -H "Authorization: Bearer $TOKEN" -F file=@samples/gateway_settlements.csv
curl -X POST localhost:8000/api/v1/ingest/courier_remittances -H "Authorization: Bearer $TOKEN" -F file=@samples/courier_cod_report.csv
curl -X POST localhost:8000/api/v1/ingest/bank_transactions -H "Authorization: Bearer $TOKEN" -F file=@samples/bank_statement.csv
curl -X POST localhost:8000/api/v1/reconciliation/run -H "Authorization: Bearer $TOKEN"
curl localhost:8000/api/v1/jobs -H "Authorization: Bearer $TOKEN"
```

The seeder prints how many anomalies it planted per leg; the reconciliation job result
(`GET /jobs`) reports the findings per issue type, so you can check one against the other.

Seeder knobs: `--cod-share` (0.35), `--cod-anomaly-rate` (0.05), `--return-rate` (0.06),
`--bank-anomaly-rate` (0.05), `--anomaly-rate` (0.05, gateway), `--fx-noise-rate` (0).

Large files: the upload is streamed to disk in `UPLOAD_STREAM_BLOCK_BYTES` blocks, and the worker parses it in
`PARSER_CHUNK_ROWS` row chunks with a `COPY` per chunk, so memory stays flat for 500 MB+ exports.
Raise `MAX_UPLOAD_MB` if you need bigger files.

### 6.6 Reset

```bash
docker compose down -v               # removes pgdata, redisdata and uploads volumes
```

## 7. Production free-tier roadmap (Vercel + Render + Neon)

> Free-tier limits change often. Check each provider's pricing page before launch. As of this writing:
> Vercel **Hobby** is for personal, non-commercial use, so move to Pro once you bill customers. Render free web
> services **sleep after ~15 minutes idle** (the first request after that takes 30–60 s), have 512 MB RAM, no
> persistent disk and no free background workers. Neon free projects scale compute to zero when idle and
> have a small storage quota (about 0.5 GB).

### 7.1 Neon serverless PostgreSQL (database)

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

### 7.2 Render (FastAPI runtime)

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

### 7.3 Vercel (Next.js web nodes)

1. vercel.com → **Add New → Project** → import the repo.
2. **Root Directory**: `auditx-frontend`. The framework preset is detected as Next.js.
3. **Environment Variables**: `NEXT_PUBLIC_API_URL=https://auditx-api.onrender.com`.
4. Deploy. Add the resulting `https://<project>.vercel.app` to Render's `CORS_ORIGINS` and redeploy the API.

### 7.4 Keeping the MVP warm (optional, still free)

Render free services sleep when idle. Before demos, hit `/health` once. A free uptime monitor
(for example UptimeRobot every 10 minutes) avoids cold starts, but it uses up the monthly free instance hours,
so only enable it during pilot weeks.

### 7.5 Graduation path

| Trigger | Upgrade |
|---------|---------|
| First paying customer | Vercel Pro (commercial use), Render Starter (no sleep) |
| Files > 200 MB or long jobs | Render Background Worker with `ROLE=worker` + managed Redis |
| > 0.5 GB data | Neon Launch plan, or partition `ecom_orders` / `gateway_transactions` by `org_id` hash |
| Enterprise / Big 4 | Dedicated DB per tenant, SSO (SAML/OIDC), customer-managed keys, SOC 2 controls |

## 8. Production hardening checklist

* Set a strong `JWT_SECRET` (`python -c "import secrets; print(secrets.token_urlsafe(64))"`).
* Restrict `CORS_ORIGINS` to your exact frontend origin(s).
* Use a dedicated PostgreSQL role for the API with no superuser rights. The agent sandbox needs only
  `TEMP` privilege (granted to `PUBLIC` by default).
* Terminate TLS at the platform edge (Render / Vercel do this automatically).
* Back up PostgreSQL (Neon has point-in-time restore. Locally, use `pg_dump`).
* Monitor `audit_jobs` for `FAILED` rows and the Celery worker logs.

## 9. Automated testing

The full test pack is in [`docs/testing/`](testing/): [strategy](testing/TEST_STRATEGY.md), [use cases](testing/USE_CASES.md), [business test cases](testing/BUSINESS_TEST_CASES.md) and the latest [test report](testing/TEST_REPORT.md).

```bash
# Backend: unit, integration, black-box API and regression (~1 min)
createdb -U auditx auditx_test                 # once; the suite refuses any database not named auditx_test
cd auditx-backend && pip install -r requirements-dev.txt
pytest                                         # or: pytest -m unit | integration | api | regression
pytest --cov=app --cov-report=term-missing

# UI end-to-end (Playwright) against a running stack
cd auditx-frontend && npm ci && npx playwright install chromium
E2E_BASE_URL=http://localhost:3000 E2E_API_URL=http://localhost:8000 npx playwright test
```

GitHub Actions (`.github/workflows/auditx-ci.yml`) runs the backend suite against PostgreSQL, plus frontend typecheck, lint and build, on every push.
