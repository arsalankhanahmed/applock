# AuditX — Use Cases

Actors: **Owner** (company account holder), **Admin**, **Analyst** (maker), **Auditor** (checker), **Viewer**, **Invitee**, **AI Auto-Healer** (system actor), **Forensic Agent** (system actor), **Courier / Gateway / Bank** (external data sources, via files, and the counterparties money is claimed back from).

Each use case lists its main flow, alternate and exception flows, and the business test cases that verify it ([BUSINESS_TEST_CASES.md](BUSINESS_TEST_CASES.md)).

---

### UC-01 Sign in / sign out
**Actor:** any member · **Pre:** account exists · **Post:** session stored in the browser

1. User opens `/dashboard`, enters work email and password, presses **Sign in**.
2. System checks credentials, issues a JWT (12 h), loads the command center.
3. User presses **Sign out**; session is cleared.

* **A1** Session survives a page reload.
* **E1** Wrong email *or* wrong password → the same message "Invalid email or password" (no account enumeration).
* **E2** Forged, expired or claim-less token → 401, user sees the login form.
* **E3** Member removed or demoted → their existing token stops working / loses rights on the next request.

Verified by: BTC-01, BTC-02, BTC-03, BTC-04

### UC-02 Change own password
**Actor:** any member · **Pre:** signed in

1. User opens **Change password**, enters current password and the new one twice.
2. System verifies the current password, enforces ≥ 10 characters and "different from current", stores the hash, and issues a new token.
3. All other sessions (older tokens) are signed out.

* **E1** Wrong current password → 400. **E2** New = current, or too short → 422. **E3** Passwords don't match → client-side error.

Verified by: BTC-05

### UC-03 Upload source files
**Actor:** Owner / Admin / Analyst · **Pre:** column mappings configured (defaults exist)

1. User selects the file type (orders, gateway, courier, bank) and uploads a CSV.
2. System stores it, answers **202 Accepted** with a job id, and parses it in the background in chunks.
3. Rows are cleaned (currency symbols, formats, dates), de-duplicated and upserted; the job reports rows read / inserted / rejected / duplicate.

* **A1** File uses `;` or tab delimiters, UTF-8 BOM or UTF-16 (Excel Unicode text).
* **E1** Not a CSV/TXT → 415. **E2** Empty → 422. **E3** A required column is missing → job FAILED with the column names.
* **E4** Bad rows (blank order no., unparseable or absurd amount, over-long id) are rejected individually; the rest load.
* **E5** Viewer or Auditor → 403.

Verified by: BTC-06, BTC-07, BTC-08, BTC-09

### UC-04 Run reconciliation and review findings
**Actor:** Owner / Admin / Analyst · **Pre:** data uploaded

1. User presses **Run reconciliation + auto-heal** (202, background job).
2. System runs three legs: gateway (orders ↔ captures), bank (payouts/remittances ↔ statement), COD (orders ↔ courier parcels).
3. Findings appear in the dashboard: metrics, leak-by-channel, root causes, courier ledger, tracking matrix.
4. User filters by status, channel, issue type, searches by order/reference, and expands a row to see the AI's proposed fix.

* **A1** Re-running never duplicates findings and keeps pending/resolved state.
* **A2** A leg with no data is skipped.

Verified by: BTC-10, BTC-11, BTC-12, BTC-13, BTC-14

### UC-05 Propose a resolution (maker)
**Actor:** Analyst (or any non-viewer) · **Pre:** an UNRESOLVED finding

1. User presses **Resolve** and enters a note.
2. Under the approval policy the finding becomes **PENDING_APPROVAL** and a request appears in the Approvals inbox, or is resolved at once if below the manual auto-approve limit.
3. The maker can **Withdraw** but never approve their own request.

Verified by: BTC-15, BTC-16

### UC-06 Approve or reject (checker)
**Actor:** Owner / Admin / Auditor, never the maker

1. Checker opens Approvals, reviews the proposed fix and evidence, presses **Approve** (or bulk-approves) or **Reject** with a reason.
2. Approve → the finding becomes RESOLVED with an audit trail. Reject → it re-opens UNRESOLVED; a rejected AI fix is never re-proposed.

* **E1** Deciding twice → 409. **E2** Reject without a reason → 422. **E3** Analyst/Viewer → 403. **E4** Another company's request → 404.

Verified by: BTC-17, BTC-18, BTC-19, BTC-20

### UC-07 Auto-Healer applies the approval policy
**Actor:** AI Auto-Healer · **Trigger:** after each reconciliation

1. For each finding, the rule-book classifies a root cause with confidence and builds a JSON fix (journal entry / data patch).
2. Policy `THRESHOLD` (default 1.00) auto-approves small fixes as `policy:auto`; larger ones go to a checker. `AUTO` / `ALWAYS_APPROVE` modes behave accordingly.

Verified by: BTC-21, BTC-22

### UC-08 Ask the forensic agent
**Actor:** any member · **Pre:** signed in

1. User types a question (or picks a suggestion).
2. Agent writes SQL (OpenAI, or the built-in router when no key), the guard checks it, the sandbox runs it read-only on tenant-only views with a timeout and row cap.
3. User sees a narrative, the result table and can **view SQL**.

* **E1** Unsafe SQL (writes, other tables, missing tenant filter) → refused (422). **E2** Prompt injection cannot change or leak data.

Verified by: BTC-23, BTC-24, BTC-25

### UC-09 Invite a member by email link
**Actor:** Owner / Admin → Invitee

1. Admin opens **Team → Add member → Send email invite**, enters email and role.
2. System creates a single-use, 7-day token (stored hashed) and emails the link (or shows it for copying if email is not configured).
3. Invitee opens the link, sees company and role, chooses a name and password, and lands signed in.

* **A1** Resend rotates the link; Revoke kills it. **E1** Used / revoked / expired link → clear message (409/404/410).
* **E2** Admin cannot invite an Owner; Analyst cannot invite; existing account → 409.

Verified by: BTC-26, BTC-27, BTC-28

### UC-10 Add a member with a temporary password
**Actor:** Owner / Admin → new member

1. Admin chooses **Set a temporary password** (or Generate) and adds the member; the password is shown once.
2. On first sign-in the member must choose their own password before anything else.

Verified by: BTC-29

### UC-11 Manage roles and access
**Actor:** Owner / Admin

1. Change a member's role, reset their password, or remove them.
2. Owner account cannot be demoted or removed; Admin cannot touch the Owner; other roles see no management controls.

Verified by: BTC-30, BTC-31

### UC-12 Configure the approval policy
**Actor:** Owner / Admin

1. Opens **Policy**, sets Auto-Healer mode and limit, and whether manual resolutions need approval and up to what amount.
2. Values are validated (modes, non-negative amounts) and recorded with who changed them.

Verified by: BTC-22, BTC-32

### UC-13 Tenant isolation (cross-cutting)
Every read and write is scoped to the caller's company: lists, jobs, approvals, team, invites, agent answers.

Verified by: BTC-33, BTC-34

### UC-14 Claim money back from a counterparty
**Actor:** Owner / Admin / Analyst · **Pre:** reconciliation found money a courier, gateway or bank owes

1. User opens **Recovery & Claims → Claimable**, which lists the open findings grouped by counterparty (e.g. TCS, Payment gateway).
2. User un-ticks anything not to claim and presses **Create claim**.
3. System creates a draft `CLM-000n` with a claim letter (items, evidence, total, due date) and locks the findings to this claim. The matrix shows *Claimed · CLM-000n*.
4. User **emails the letter** to the counterparty, or **marks it as sent** and uses **Copy letter** / **Print / PDF**.

* **E1** Findings from two counterparties in one claim → 422. **E2** A finding already in an open claim, resolved, or owed by a customer → 409.
* **E3** No SMTP or no address → the claim is still marked sent, with a message to copy or print the letter.
* **E4** Auditor / Viewer → can view, but cannot create or change claims (403, no buttons).

Verified by: BTC-35, BTC-36, BTC-37, BTC-41, BTC-45

### UC-15 Record recovery and close the claim
**Actor:** Owner / Admin / Analyst, then a checker

1. User records each payment received (amount, bank reference, date). The claim becomes *Partly recovered*.
2. When nothing is outstanding the claim is *Recovered*, and each finding still open is submitted for resolution as `RECOVERED_FROM_COUNTERPARTY` through maker-checker.
3. A checker approves; the findings close. Headline tiles show recovered this month, to date, and the recovery rate.

* **A1** Counterparty refuses → **Mark rejected** with a reason; findings can be claimed again.
* **A2** Not worth chasing → **Write off balance** with a reason; findings go to a checker as `WRITE_OFF`.
* **E1** Payment above the outstanding balance, zero or negative → 422. **E2** Payment on a draft or a closed claim → 409.

Verified by: BTC-38, BTC-39, BTC-40, BTC-42

### UC-16 Recovery detected automatically in fresh data
**Actor:** System (reconciliation) · **Trigger:** a new courier report or bank statement is uploaded and reconciled

1. Reconciliation rebuilds findings, then re-checks every claim that is sent or partly recovered.
2. If a claimed finding has disappeared (the courier remitted, the bank shows the payout), the claim is credited with a *Payment seen in courier / bank data* event.
3. If it only shrank (part paid), only the difference is credited.

* **E1** A finding closed by a person is not treated as payment. **E2** Data matches and recorded payments never add up to more than the claim.

Verified by: BTC-43, BTC-44

### UC-17 Switch WhatsApp alerts on for a client (optional)
**Actor:** Owner / Admin · **Pre:** the client asked for alerts

1. Admin opens **WhatsApp Alerts**, which shows *Off* and what this server can send (WhatsApp provider, email).
2. Admin ticks *Send alerts for this company* and picks daily or weekly, the send hour, time zone, minimum amount, overdue days and sections.
3. **Save**: the badge shows *On · daily at 08:00*.

* **E1** Unknown time zone, hour outside 0–23, unknown frequency, negative amount → 422.
* **E2** Analyst, Auditor, Viewer → no panel; API 403.

Verified by: BTC-46, BTC-47, BTC-52

### UC-18 Add recipients, preview and send a test
**Actor:** Owner / Admin

1. Admin adds a recipient: name, WhatsApp number or email, and ticks that the person agreed to receive alerts.
2. The **preview** shows the next message.
3. **Send test now** sends it immediately (even while alerts are off). *Recent deliveries* shows the result with the address masked.

* **E1** No consent → Add is disabled / 422. **E2** Local number (`0300…`) → "international format". **E3** Same number twice → 409.
* **E4** WhatsApp not configured on the server → test shows *Not sent: WhatsApp is not configured*, recorded as FAILED.

Verified by: BTC-48, BTC-49, BTC-50

### UC-19 Scheduled digest delivery
**Actor:** System (Celery beat every 15 minutes, or a cron job calling the protected endpoint)

1. For each company with alerts on, once the local send time has passed (daily) or Monday's send time has passed (weekly), each active recipient gets the digest.
2. Each recipient gets at most one digest per period, however often the job runs.

* **A1** Nothing to report and *all clear* off → recorded as SKIPPED, nothing sent.
* **E1** Send fails → retried on later runs, up to 3 attempts. **E2** Process died mid-send → released for retry after 15 minutes.
* **E3** Cron endpoint without the right token → 403 (404 when no token is configured).

Verified by: BTC-51, BTC-53
