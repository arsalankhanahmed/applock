# AuditX — Use Cases

Actors: **Owner** (company account holder), **Admin**, **Analyst** (maker), **Auditor** (checker), **Viewer**, **Invitee**, **AI Auto-Healer** (system actor), **Forensic Agent** (system actor), **Courier / Gateway / Bank** (external data sources, via files).

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
