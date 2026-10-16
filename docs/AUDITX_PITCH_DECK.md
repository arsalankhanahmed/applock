# AuditX — Enterprise B2B Pitch Deck Framework

A 14-slide template with a speaker script for each slide. It is written for CFOs, Financial Controllers, Heads of
Revenue Assurance, Internal Audit Directors and Big 4 / premium audit-firm partners.

**How to use it:** keep slide text to the headline plus 3 bullets. The script is what you *say*. Square-bracketed
items like **[Prospect]** are filled in per meeting from your discovery call. Every number marked *Demo benchmark*
comes from the bundled seeder run (`--orders 20000 --fx-noise-rate 0.01`) and can be reproduced live.

Running time: 25 minutes plus 10 minutes of live demo plus Q&A.

---

## Slide 1 — Title

**On slide:** AuditX · *Autonomous Revenue Assurance for the Multi-Channel Enterprise* · [Prospect logo] · [Date]

**Script:**
"Thank you for the time, [Name]. In the next half hour I want to show you three things: where cash is quietly
leaking between your storefront, your payment gateways and your ERP; why your current close process can't see
it; and how AuditX finds it, explains it and fixes most of it before your team opens a spreadsheet."

---

## Slide 2 — The Executive Problem

**On slide:** *Every order travels through 3+ systems. None of them agree.*
- Storefront / ERP says what you *sold*
- Gateway says what you *collected*
- Bank says what you *received*

**Script:**
"[Prospect] runs [SAP / Dynamics 365 / a custom ERP] alongside [Shopify / Magento] and [Stripe / Adyen /
Razorpay / PayPal]. Each system is right on its own terms, but the joins between them are where money disappears:
an order shipped with no capture, a capture with no order, a discount the gateway honoured that the ERP never
booked. At your volume, a fraction of a percent of mismatches is a material number."

**Discovery hook:** "How many orders per month, and how many payment providers?"

---

## Slide 3 — Why It Stays Invisible

**On slide:** *Month-end sampling cannot catch transaction-level leakage.*
- Reconciliation is manual, sampled and late (T+30)
- Exports are dirty: `Rs. 1,00,000.00`, `(12.50)`, `1.234,56-`, `#0001003` vs `1003`
- Tools match totals, not orders, so offsetting errors cancel out

**Script:**
"Your team reconciles batch totals. When one order is $5 short and another is $5 over, the totals tie and
both errors survive. Meanwhile analysts spend days cleaning CSVs before they can even start. The audit finding
arrives a quarter after the money is gone."

---

## Slide 4 — The Cost of Doing Nothing

**On slide:** *Leakage compounds: lost cash + audit exposure + analyst hours.*
| Driver | [Prospect] estimate |
|--------|---------------------|
| Monthly GMV | [ ] |
| Orders / month | [ ] |
| Analyst hours on reconciliation / month | [ ] |
| Last audit findings on revenue cut-off | [ ] |

**Script:**
"Let's put your numbers on the table rather than mine. If even [x]% of [GMV] is unmatched, that's [value] a
month, before you count the [hours] your team spends finding it and the audit fees spent re-testing it."

---

## Slide 5 — Introducing AuditX

**On slide:** *Continuous, order-level, three-way reconciliation, with an AI that fixes what it finds.*
1. **Universal Ingestion**: any ERP or gateway export, mapped once
2. **Reconciliation Engine**: every order, every capture, every tenant isolated
3. **AI Auto-Healer**: known break patterns resolved with an audit trail
4. **Chat-with-your-Ledger**: auditors ask questions in plain English

**Script:**
"AuditX sits beside your systems, not in place of them. You map your columns once. From then on every file
(daily, hourly, or a 500 MB year-end dump) is reconciled order by order, and every break is classified, scored
and either healed or routed to a human with a proposed fix."

---

## Slide 6 — How It Works (Architecture)

**On slide:** diagram: `ERP / Storefront CSV` + `Gateway settlement CSV` → **Universal Parser** → PostgreSQL
(tenant-scoped) → **Reconciliation Engine** → `discrepancy_logs` → **Auto-Healer** → Dashboard + Forensic Agent

- FastAPI async gateway; heavy jobs on Celery workers (202 Accepted, never blocks)
- Streamed, chunked parsing: memory stays flat for 500 MB+ exports
- Every row carries `org_id`; every query is tenant-filtered

**Script (for the IT / security stakeholder):**
"Uploads stream to disk in one-megabyte blocks and are parsed in chunks of 100,000 rows straight into PostgreSQL
via COPY, so file size doesn't threaten stability. Every table is keyed by organisation. The application never
issues a query without the tenant filter."

---

## Slide 7 — Universal Data Dictionary

**On slide:** *Map once. Ingest forever.*
| Your column | AuditX standard field | Rule |
|-------------|----------------------|------|
| `Sales Document` (SAP VBELN) | `source_order_number` | |
| `Net Value` | `total_amount` | currency cleaner |
| `Created On` | `ordered_at` | `date_format:%d.%m.%Y %H:%M:%S` |
| `Processing Fee` | `fee_amount` | `abs` |

**Script:**
"We don't ask you to change your ERP exports. Your SAP headers, your Dynamics field names, your gateway's naming
are mapped once to our canonical dictionary, with transformation rules for prefixes, cents, signs and date
formats. Currency noise like rupee symbols, accounting brackets, European decimals and Indian lakh grouping is
cleaned automatically."

---

## Slide 8 — The Three Leakage Vectors

**On slide:**
| Vector | Meaning | Business risk |
|--------|---------|---------------|
| **Missing Payment** | Order booked, no capture | Shipped goods never paid for |
| **Untracked Revenue** | Capture with no order | Unbooked revenue, diversion, tax exposure |
| **Amount Mismatch** | Both exist, values differ | Discount abuse, fee netting, FX, manipulation |

*Demo benchmark:* 20,000 orders reconciled in **under 1 second**; 1,203 breaks detected; **100% of injected
anomalies found**.

**Script:**
"A full outer join on order reference splits every break into one of three buckets. In our benchmark we injected
a known 5% anomaly mix plus FX noise into 20,000 orders. AuditX found every single one, in under a second."

---

## Slide 9 — AI Auto-Healer

**On slide:** *It doesn't just flag. It explains, proposes the journal entry and closes the loop.*
| Pattern | Category | Confidence | Action |
|---------|----------|-----------|--------|
| Variance < $0.50 | `FX_ROUNDING_ERROR` | 91–99% | Adjusting JE to FX differences |
| Exactly $5.00 short | `PROMO_CODE_UNSYNCED` | 93% | Patch order total + discount JE |
| Variance = gateway fee | `GATEWAY_FEE_NETTING` | 90% | Reclassify net → gross |
| `#0001003` vs `1003` | `ORDER_ID_FORMAT_DRIFT` | 95% | Remap reference |
| Charged twice | `DUPLICATE_CAPTURE` | 88% | Refund (human approval) |
| Variance ≥ 20% of order | `POTENTIAL_FRAUD_OR_MANIPULATION` | escalated | Forensic review |

*Demo benchmark:* **46% of all breaks auto-healed**, each with gateway API evidence and a balanced journal entry.

**Script:**
"Low-risk, high-confidence patterns are resolved autonomously, and every resolution carries the evidence trail,
the confidence score and the double-entry journal it proposes. Anything touching customer money, such as refunds or
suspected manipulation, is never auto-resolved. It goes to a human with the work already done."

---

## Slide 10 — Chat-with-your-Ledger

**On slide:** *"Which orders over $500 have no payment?" → answer in seconds, with the SQL shown.*
- Natural language → one read-only PostgreSQL query
- Every query shown to the auditor: fully explainable
- Locked down: blacklisted DDL/DML, tenant-shadowed read-only sandbox, timeouts, row caps

**Script:**
"Your auditors don't wait for IT to write a report. They ask. The agent compiles the question to SQL, and the
SQL is always visible, which matters to an auditor. Under the hood it can only read, only one statement, only your
organisation's rows. Even a deliberately malicious prompt can't reach another tenant's data: the database itself
hides it."

---

## Slide 11 — Live Demo (10 minutes)

**Run-sheet:**
1. Dashboard: open leakage, auto-healed value, match rate (30 s)
2. Leak-state bars → click **Missing Payments** in the tracking matrix (1 min)
3. Expand a **PROMO_CODE_UNSYNCED** row: show the transform, journal entry and gateway evidence (2 min)
4. Upload the prospect-style dirty SAP CSV → show the 202 job → re-run reconciliation (3 min)
5. Chat: *"Show suspicious fraud risk items"* → **view SQL** (2 min)
6. Resolve a finding manually with an audit note (1 min)

**Script cue:** "Let me stop describing it and show you, on data shaped like yours."

---

## Slide 12 — Built for Auditors (Big 4 / Premium Firms)

**On slide:** *A force multiplier for every engagement team.*
- Multi-tenant: one workspace per client engagement, hard isolation
- 100% population testing instead of sampling
- Every AI decision: category, confidence, evidence, journal, timestamp
- Exportable evidence for working papers

**Script (audit-firm variant):**
"For an audit firm, AuditX turns revenue testing from sampling into full-population analytics. Each client
engagement is its own tenant. Your seniors spend their time on judgement, not on VLOOKUPs, and every exception in
the working papers comes with its evidence attached."

---

## Slide 13 — Commercial Model & Pilot

**On slide:**
| Tier | For | Basis |
|------|-----|-------|
| **Growth** | D2C / e-commerce brands | Monthly order volume band |
| **Enterprise** | SAP / Dynamics 365 / custom ERP groups | Entities + volume, SSO, SLA |
| **Partner** | Audit & advisory firms | Per engagement tenant, white-label option |

**Pilot offer:** 30 days · 2 data sources · historical 90-day lookback · success metric agreed up front
([recovered value] or [hours saved]).

**Script:**
"We'd like to prove value on your own data before you commit. Give us 90 days of history from two sources; we
agree today what success looks like; and in 30 days you'll see your actual leakage number."

---

## Slide 14 — The Ask & Next Steps

**On slide:**
1. Nominate a finance owner and an IT contact
2. Share two sample exports (we provide a secure upload workspace)
3. Pilot kickoff: [date] · Readout: [date + 30 days]

**Script:**
"The only thing we need from you today is a yes to the pilot and the two contacts. My team handles the mapping.
Your first reconciliation report will be in your inbox within a week."

---

## Appendix A — Objection Handling

| Objection | Response |
|-----------|----------|
| "Our ERP already reconciles." | "It reconciles to the bank in totals. AuditX reconciles every order to every capture, which is where offsetting errors hide." |
| "We can't let AI change our books." | "AuditX proposes journal entries with evidence. Auto-resolution covers only low-risk categories you approve, and everything is logged and reversible." |
| "Data security?" | "Tenant isolation at the database layer, read-only AI sandbox, no write access to your ERP, data stays in your chosen region." |
| "Integration effort?" | "CSV exports you already produce. Mapping is a one-time 30-minute session per source." |
| "We tried a reconciliation tool before." | "Totals-matching tools miss order-level breaks and stop at flagging. AuditX classifies, explains and fixes." |

## Appendix B — Discovery Questions

1. Which ERP(s), storefronts and payment providers, and how many entities / currencies?
2. Monthly order volume and GMV?
3. Who owns reconciliation today; how many hours per close?
4. Last audit findings related to revenue, cut-off or cash?
5. Known pain: discounts, refunds, chargebacks, FX, marketplace payouts?
6. What would make a 30-day pilot an unambiguous success?

## Appendix C — Technical Due-Diligence One-Pager

- **Stack:** Python 3.12 FastAPI, PostgreSQL 16, Celery + Redis, Next.js 14 (TypeScript, Tailwind), Docker
- **Isolation:** `org_id` on every table and query; JWT-scoped tenant claim; agent runs in tenant-shadowed,
  read-only, always-rolled-back transactions with statement timeouts
- **Scale:** streamed uploads, chunked parsing, COPY-based bulk loads, integer-cent arithmetic, idempotent loads
  (`ON CONFLICT DO NOTHING`)
- **Auditability:** `audit_jobs` ledger, AI category / confidence / fix JSON per finding, manual-resolution notes
  with user and timestamp
- **Deployment:** Docker compose locally; Vercel + Render + Neon for MVP; dedicated per-tenant databases for
  enterprise
