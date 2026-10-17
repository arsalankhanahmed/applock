# AuditX — Enterprise B2B Pitch Deck Framework

A 16-slide template with a speaker script for each slide. It is written for CFOs, Financial Controllers, Heads of
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

**On slide:** diagram: `ERP / Storefront CSV` + `Gateway settlement CSV` + `Courier COD report` + `Bank statement`
→ **Universal Parser** → PostgreSQL
(tenant-scoped) → **Reconciliation Engine** (gateway, bank and COD legs) → `discrepancy_logs` → **Auto-Healer** → Dashboard + Forensic Agent

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

## Slide 8 — Leg 1: Orders ↔ Gateway

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

## Slide 9 — Leg 2: Settlements ↔ Bank

**On slide:** *Paid out is not the same as banked.*
- Gateway payouts (daily) and courier remittances (weekly CPR batches) → bank statement credits
- Matched by reference, then by exact amount within 10 days
- **Not deposited** (still missing after 7 days) → payment-trace request drafted
- **Deposit mismatch** → bank charges auto-heal with a journal entry; larger gaps go to a person
- **Unidentified credit** → allocate it or park it in suspense

*Demo benchmark:* 139 settlement batches, 134 matched (110 by reference, 24 by amount), 6 of 6 planted breaks found.

**Script:**
"The gateway telling you it paid out is not the same as the money sitting in your bank. Every payout and every
courier remittance is expected to land as one bank credit. AuditX matches them by the reference in the
narration, and by amount when the bank truncates it. You get three lists: money that never arrived, money that
arrived short, and money nobody can explain. Loans and interest are ignored, so the list stays clean."

---

## Slide 10 — Leg 3: COD ↔ Couriers

**On slide:** *Find the cash couriers still hold.*
| Break | What it means |
|-------|---------------|
| Not remitted | Delivered, cash collected, unpaid after 10 days |
| Short remittance | Rider short-collected, or the courier deducted |
| Overcharges | Charge far above that courier's usual rate |
| Return still booked | Parcel came back, the ERP still shows a sale |
| Lost or stuck | Reported lost, or in transit for 21+ days |
| Never dispatched | COD order no courier ever received |
| Parcel not in ERP | Cash collected for a sale never booked |

*Demo benchmark:* 6,449 COD orders, 298 of 298 planted COD breaks found. TCS, Leopards, PostEx and Trax
reports are mapped once; every finding carries the claim amount and next steps, and a person approves each one.

**Script:**
"For brands that sell cash on delivery, the biggest leak isn't the gateway, it's the courier. AuditX reads each
courier's parcel report and checks every COD order: dispatched, delivered, cash returned, right amount.
The courier ledger on the dashboard shows how much cash each courier is holding right now and how much of it is
overdue. Nothing here is auto-resolved: every finding is money to recover, so your team approves the claim."

**Discovery hook:** "What share of your orders is COD, and which couriers do you use?"

---

## Slide 11 — AI Auto-Healer

**On slide:** *It doesn't just flag. It explains, proposes the journal entry and closes the loop.*
| Pattern | Category | Confidence | Action |
|---------|----------|-----------|--------|
| Variance < $0.50 | `FX_ROUNDING_ERROR` | 91–99% | Adjusting JE to FX differences |
| Exactly $5.00 short | `PROMO_CODE_UNSYNCED` | 93% | Patch order total + discount JE |
| Variance = gateway fee | `GATEWAY_FEE_NETTING` | 90% | Reclassify net → gross |
| `#0001003` vs `1003` | `ORDER_ID_FORMAT_DRIFT` | 95% | Remap reference |
| Charged twice | `DUPLICATE_CAPTURE` | 88% | Refund (human approval) |
| Variance ≥ 20% of order | `POTENTIAL_FRAUD_OR_MANIPULATION` | escalated | Forensic review |

*Demo benchmark:* **46% of gateway breaks get an AI fix**, each with gateway API evidence and a balanced journal entry.
Under the default maker-checker policy, sub-$1 rounding posts instantly and the rest wait for one-click checker
approval (single or bulk). Courier claims always go to a person.

**Script:**
"Low-risk, high-confidence patterns get a ready-made fix; your approval policy decides what posts by itself
and what waits for a checker's one-click approval. Every resolution carries the evidence trail,
the confidence score and the double-entry journal it proposes. Anything touching customer money, such as refunds or
suspected manipulation, is never auto-resolved. It goes to a human with the work already done."

---

## Slide 11A — Recovery & Claims: from "we found it" to "we got it back"

**On slide:** *Every rupee a courier, gateway or bank owes becomes a claim, and AuditX tracks it until the cash is back.*

| Step | What AuditX does |
|------|------------------|
| 1. Claimable | Lists money owed per counterparty, e.g. TCS Rs 2.3 lakh, Leopards Rs 80k, Payment gateway Rs 45k |
| 2. Claim | One click builds `CLM-0007` with a claim letter (orders, CN numbers, dates, total, due date), ready to email or print |
| 3. Track | Records each payment against the claim; overpayment is impossible |
| 4. Auto-detect | When the courier's next report shows the order remitted, the claim is credited by itself |
| 5. Close | Recovered or written-off findings close through maker-checker, so the audit trail stays complete |

**Headline tile (example):** *"Rs 4,80,000 recovered this month · 86% of amounts claimed."*

**Script:**
"Most tools stop at the exception report. Your team then spends a week on emails and spreadsheets chasing
couriers. AuditX writes the claim letter for you and follows the money. When TCS finally pays, the next
reconciliation notices and closes the claim. The number on this tile is the money AuditX put back in your
account this month, and it is usually many times the subscription fee."

---

## Slide 11B — WhatsApp Alerts (optional add-on)

**On slide:** *The owner doesn't open the dashboard; AuditX comes to them.*

> *AuditX alert · Karachi Traders:* TCS holds PKR 230,000 COD for 41 orders, oldest delivered 18 days ago |
> 2 payouts worth PKR 85,000 not fully in the bank | 3 fixes waiting for a checker | Recovered this month: PKR 480,000 *(example)*

* Daily or every Monday, at the client's chosen hour and time zone, on WhatsApp or email.
* Off by default and switched on per client, so it can be sold as an add-on.
* Opt-in consent recorded for every number; delivery log with masked numbers.
* Works with the WhatsApp Business Cloud API or Twilio.

**Script:**
"Most business owners live on WhatsApp, not in dashboards. Every morning at nine they get one message saying
which courier is sitting on their cash and what is waiting for approval, and they tap the link if they want
details. That message is what makes AuditX a daily habit."

---

## Slide 12 — Chat-with-your-Ledger

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

## Slide 13 — Live Demo (10 minutes)

**Run-sheet:**
1. Dashboard: open leakage, not banked, COD with couriers (30 s)
2. **Courier COD ledger**: which courier holds the most cash, and how much is overdue (1 min)
3. Expand a **PROMO_CODE_UNSYNCED** row: show the transform, journal entry and gateway evidence (2 min)
4. Upload the prospect-style dirty SAP CSV or courier report → show the 202 job → re-run reconciliation (3 min)
5. Chat: *"Which payouts never reached the bank?"* → **view SQL** (2 min)
6. Resolve a finding manually with an audit note (1 min)

**Script cue:** "Let me stop describing it and show you, on data shaped like yours."

---

## Slide 14 — Built for Auditors (Big 4 / Premium Firms)

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

## Slide 15 — Commercial Model & Pilot

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

## Slide 16 — The Ask & Next Steps

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
| "We can't let AI change our books." | "It can't on its own. Maker-checker is built in: the AI and your analysts propose, a second person approves, and the maker can never approve their own fix. You set the limit below which anything may post automatically, and every step is logged." |
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
