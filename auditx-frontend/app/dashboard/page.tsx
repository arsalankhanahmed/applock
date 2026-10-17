"use client";

import {
  Component,
  FormEvent,
  Fragment,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
} from "react";

import { Logo, Spinner } from "../components/brand";
import {
  API_BASE,
  ApiError,
  MIN_PASSWORD_LENGTH,
  api,
  loadSession,
  saveSession,
  sessionFromToken,
  type Session,
  type TokenResponse,
} from "../lib/client";

/* ============================================================================
 * Types — mirror app/models/schemas.py
 * ========================================================================== */
type Channel = "GATEWAY" | "BANK" | "COD";
type IssueType =
  | "MISSING_PAYMENT"
  | "UNTRACKED_REVENUE"
  | "AMOUNT_MISMATCH"
  | "SETTLEMENT_NOT_DEPOSITED"
  | "DEPOSIT_MISMATCH"
  | "UNMATCHED_DEPOSIT"
  | "COD_PARCEL_UNTRACKED"
  | "COD_ORDER_NOT_BOOKED"
  | "COD_NOT_REMITTED"
  | "COD_REMITTANCE_SHORTFALL"
  | "COURIER_OVERCHARGE"
  | "RETURNED_ORDER_BOOKED"
  | "PARCEL_LOST_OR_STUCK";
type IngestTarget = "ecom_orders" | "gateway_transactions" | "courier_remittances" | "bank_transactions";
type DiscrepancyStatus = "UNRESOLVED" | "PENDING_APPROVAL" | "RESOLVED";
type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
type AutoHealMode = "AUTO" | "THRESHOLD" | "ALWAYS_APPROVE";
type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
type JobType = "INGEST_ORDERS" | "INGEST_GATEWAY" | "INGEST_BANK" | "INGEST_COURIER" | "RECONCILIATION";
type Money = string | number;

interface IssueBreakdown {
  issue_type: IssueType;
  channel: Channel;
  open_count: number;
  open_exposure: Money;
  resolved_count: number;
}

interface ChannelBreakdown {
  channel: Channel;
  open_count: number;
  open_exposure: Money;
  resolved_count: number;
}

interface CourierSummary {
  courier_name: string;
  parcels: number;
  delivered: number;
  returned: number;
  cod_collected: Money;
  charges: Money;
  remitted: Money;
  pending_remittance: Money;
  overdue_remittance: Money;
  return_rate_pct: Money;
}

interface RootCauseBreakdown {
  category: string;
  count: number;
  exposure: Money;
  avg_confidence: Money | null;
}

interface DashboardMetrics {
  company_name: string;
  brand_currency: string;
  total_orders: number;
  total_order_value: Money;
  total_gateway_transactions: number;
  total_gateway_gross: Money;
  total_gateway_fees: Money;
  open_discrepancies: number;
  open_leakage_exposure: Money;
  auto_healed_count: number;
  auto_healed_value: Money;
  manual_resolved_count: number;
  match_rate_pct: Money;
  auto_heal_rate_pct: Money;
  bank_credits_total: Money;
  settlements_expected_total: Money;
  settlements_not_deposited: Money;
  cod_orders: number;
  cod_pending_remittance: Money;
  pending_approval_count: number;
  pending_approval_value: Money;
  by_channel: ChannelBreakdown[];
  by_issue_type: IssueBreakdown[];
  by_root_cause: RootCauseBreakdown[];
  courier_summary: CourierSummary[];
  last_reconciliation_at: string | null;
}

interface JournalLine {
  account: string;
  debit: number;
  credit: number;
  memo: string;
}

interface GatewayEvent {
  id: string;
  type: string;
  transaction_id: string;
  provider: string;
  amount: number | null;
  fee: number | null;
  presentment_currency: string;
  settlement_currency: string;
  fx_rate: number;
  created: string;
}

interface SuggestedFix {
  action?: string;
  reason?: string;
  priority?: string;
  target_table?: string;
  match?: Record<string, unknown>;
  transform?: { field: string; from: unknown; to: unknown };
  journal?: JournalLine[];
  evidence?: ({ events?: GatewayEvent[]; discount_codes_seen?: string[] } & Record<string, unknown>) | null;
  next_steps?: string[];
  manual_resolution?: { note: string; resolved_by: string; resolved_at: string };
  approval?: ApprovalTrail;
  [key: string]: unknown;
}

interface ApprovalTrail {
  status: string;
  request_id?: string;
  proposed_by?: string;
  maker_note?: string | null;
  approved_by?: string;
  rejected_by?: string;
  checker_note?: string | null;
  note?: string;
}

interface ApprovalRequest {
  request_id: string;
  log_id: string | null;
  source_order_number: string;
  issue_type: IssueType;
  channel: Channel;
  amount: Money;
  root_cause_category: string | null;
  proposed_fix: SuggestedFix | null;
  proposed_by_type: "AI" | "USER";
  proposed_by_email: string | null;
  maker_note: string | null;
  status: RequestStatus;
  decided_by_email: string | null;
  checker_note: string | null;
  created_at: string;
  decided_at: string | null;
  is_mine: boolean;
}

interface ApprovalPageData {
  total: number;
  pending_value: Money;
  limit: number;
  offset: number;
  items: ApprovalRequest[];
}

interface ApprovalPolicy {
  auto_heal_mode: AutoHealMode;
  auto_heal_max_amount: Money;
  manual_requires_approval: boolean;
  manual_auto_approve_max: Money;
  updated_at: string | null;
  updated_by_email: string | null;
}

type Role = "OWNER" | "ADMIN" | "ANALYST" | "AUDITOR" | "VIEWER";

interface Member {
  user_id: string;
  full_name: string;
  email: string;
  role: Role;
  created_at: string;
}

interface MeResponse {
  user: { user_id: string; org_id: string; role: Role; email: string; must_change_password: boolean };
}

type InviteState = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

interface Invite {
  invite_id: string;
  email: string;
  full_name: string | null;
  role: Role;
  status: InviteState;
  invited_by_email: string | null;
  send_count: number;
  last_sent_at: string | null;
  last_send_error: string | null;
  created_at: string;
  expires_at: string;
}

interface InviteSent extends Invite {
  invite_url: string;
  email_sent: boolean;
  email_error: string | null;
}

interface BulkResult {
  approved: string[];
  failed: Record<string, string>;
}

interface Discrepancy {
  log_id: string;
  source_order_number: string;
  issue_type: IssueType;
  channel: Channel;
  order_amount: Money | null;
  gateway_amount: Money | null;
  variance_amount: Money;
  status: DiscrepancyStatus;
  ai_root_cause_category: string | null;
  ai_confidence_score: Money | null;
  ai_suggested_fix: SuggestedFix | null;
  auto_resolved: boolean;
  detected_at: string;
  resolved_at: string | null;
  claim_number?: string | null;
}

interface DiscrepancyPage {
  total: number;
  limit: number;
  offset: number;
  items: Discrepancy[];
}

interface JobAccepted {
  job_id: string;
  job_type: JobType;
  status: JobStatus;
  status_url: string;
}

interface Job {
  job_id: string;
  job_type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

interface AgentAnswer {
  question: string;
  sql: string;
  explanation: string;
  narrative: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  engine: string;
  elapsed_ms: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  answer?: AgentAnswer;
}

async function waitForJob(token: string, jobId: string, onTick: (job: Job) => void): Promise<Job> {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await api<Job>(`/api/v1/jobs/${jobId}`, token);
    onTick(job);
    if (job.status === "SUCCEEDED" || job.status === "FAILED") return job;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("Job polling timed out");
}

/* ============================================================================
 * Formatting helpers
 * ========================================================================== */
const num = (v: Money | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

function money(v: Money | null | undefined, currency = "USD", compact = false): string {
  if (v === null || v === undefined) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: compact ? 1 : 2,
    }).format(num(v));
  } catch {
    return `${currency} ${num(v).toFixed(2)}`;
  }
}

const integer = (v: number): string => new Intl.NumberFormat("en-US").format(v);
const pct = (v: Money): string => `${num(v).toFixed(2)}%`;
const humanize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Cod|Fx|Erp|Id)\b/g, (w) => w.toUpperCase());

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? integer(value) : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const TONE = {
  rose: "text-rose-300 bg-rose-500/10 ring-rose-500/30",
  amber: "text-amber-300 bg-amber-500/10 ring-amber-500/30",
  sky: "text-sky-300 bg-sky-500/10 ring-sky-500/30",
  violet: "text-violet-300 bg-violet-500/10 ring-violet-500/30",
  orange: "text-orange-300 bg-orange-500/10 ring-orange-500/30",
};

const ISSUE_META: Record<IssueType, { label: string; tone: string }> = {
  MISSING_PAYMENT: { label: "Missing Payment", tone: TONE.rose },
  UNTRACKED_REVENUE: { label: "Untracked Revenue", tone: TONE.amber },
  AMOUNT_MISMATCH: { label: "Amount Mismatch", tone: TONE.sky },
  SETTLEMENT_NOT_DEPOSITED: { label: "Not Deposited", tone: TONE.rose },
  DEPOSIT_MISMATCH: { label: "Deposit Mismatch", tone: TONE.violet },
  UNMATCHED_DEPOSIT: { label: "Unidentified Credit", tone: TONE.amber },
  COD_PARCEL_UNTRACKED: { label: "Never Dispatched", tone: TONE.amber },
  COD_ORDER_NOT_BOOKED: { label: "Parcel Not in ERP", tone: TONE.amber },
  COD_NOT_REMITTED: { label: "COD Not Remitted", tone: TONE.rose },
  COD_REMITTANCE_SHORTFALL: { label: "Short Remittance", tone: TONE.orange },
  COURIER_OVERCHARGE: { label: "Courier Overcharge", tone: TONE.orange },
  RETURNED_ORDER_BOOKED: { label: "Return Still Booked", tone: TONE.violet },
  PARCEL_LOST_OR_STUCK: { label: "Lost / Stuck Parcel", tone: TONE.rose },
};

const CHANNEL_META: Record<Channel, { label: string; bar: string; hint: string }> = {
  GATEWAY: { label: "Orders ↔ Gateway", bar: "bg-sky-400", hint: "prepaid orders vs captures" },
  BANK: { label: "Settlements ↔ Bank", bar: "bg-violet-400", hint: "payouts & remittances vs statement" },
  COD: { label: "COD ↔ Couriers", bar: "bg-orange-400", hint: "cash on delivery vs courier reports" },
};

const ISSUE_CHANNEL: Record<IssueType, Channel> = {
  MISSING_PAYMENT: "GATEWAY",
  UNTRACKED_REVENUE: "GATEWAY",
  AMOUNT_MISMATCH: "GATEWAY",
  SETTLEMENT_NOT_DEPOSITED: "BANK",
  DEPOSIT_MISMATCH: "BANK",
  UNMATCHED_DEPOSIT: "BANK",
  COD_PARCEL_UNTRACKED: "COD",
  COD_ORDER_NOT_BOOKED: "COD",
  COD_NOT_REMITTED: "COD",
  COD_REMITTANCE_SHORTFALL: "COD",
  COURIER_OVERCHARGE: "COD",
  RETURNED_ORDER_BOOKED: "COD",
  PARCEL_LOST_OR_STUCK: "COD",
};

const UPLOAD_TARGETS: { value: IngestTarget; label: string; job: string }[] = [
  { value: "ecom_orders", label: "ERP / storefront orders", job: "Order ingestion" },
  { value: "gateway_transactions", label: "Gateway settlements", job: "Gateway ingestion" },
  { value: "courier_remittances", label: "Courier COD report", job: "Courier ingestion" },
  { value: "bank_transactions", label: "Bank statement", job: "Bank ingestion" },
];

/* ============================================================================
 * Primitive UI
 * ========================================================================== */
class PanelBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`AuditX panel "${this.props.title}" crashed`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-5 text-sm">
          <p className="font-semibold text-rose-300">{this.props.title} failed to render</p>
          <p className="mt-1 break-words text-rose-200/70">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-3 rounded-md border border-rose-400/40 px-3 py-1 text-xs text-rose-200 hover:bg-rose-500/10"
          >
            Retry panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Card({ title, action, children, className = "" }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col rounded-2xl border border-ink-700 bg-ink-900/80 shadow-xl shadow-black/30 backdrop-blur ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-ink-700 px-5 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{title}</h2>
        {action}
      </header>
      <div className="min-h-0 flex-1 p-5">{children}</div>
    </section>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-ink-700/60 ${className}`} />;
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      {[0, 150, 300].map((delay) => (
        <span key={delay} className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-emerald-400" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  );
}

function Badge({ children, className }: { children: ReactNode; className: string }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${className}`}>{children}</span>;
}

function ConfidenceMeter({ value }: { value: Money | null }) {
  if (value === null) return <span className="text-slate-500">—</span>;
  const v = Math.round(num(value) * 100);
  const tone = v >= 90 ? "bg-emerald-400" : v >= 70 ? "bg-sky-400" : v >= 50 ? "bg-amber-400" : "bg-rose-400";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full ${tone}`} style={{ width: `${v}%` }} />
      </div>
      <span className="tabular text-xs text-slate-300">{v}%</span>
    </div>
  );
}

/* ============================================================================
 * Login gate
 * ========================================================================== */
function LoginGate({ onAuthenticated }: { onAuthenticated: (s: Session) => void }) {
  const [email, setEmail] = useState("demo@auditx.io");
  const [password, setPassword] = useState("AuditX#Demo2026");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<TokenResponse>("/api/v1/auth/login", null, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onAuthenticated(sessionFromToken(res));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-7 shadow-2xl shadow-black/50">
        <Logo />
        <p className="mt-2 text-sm text-slate-400">Sign in to the autonomous audit command center.</p>
        <label htmlFor="login-email" className="mt-6 block text-xs font-medium uppercase tracking-wider text-slate-400">Work email</label>
        <input
          id="login-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
        />
        <label htmlFor="login-password" className="mt-4 block text-xs font-medium uppercase tracking-wider text-slate-400">Password</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
        />
        {error && <p className="mt-3 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-emerald-400 disabled:opacity-60"
        >
          {busy && <Spinner />} Sign in
        </button>
        <p className="mt-4 text-center text-[11px] text-slate-500">Demo credentials are created by the seeder.</p>
      </form>
    </div>
  );
}

/* ============================================================================
 * Metrics widgets
 * ========================================================================== */
function MetricTile({ label, value, sub, tone = "text-slate-100", loading }: { label: string; value: string; sub?: string; tone?: string; loading: boolean }) {
  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-900/80 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      {loading ? <Skeleton className="mt-2 h-7 w-28" /> : <p className={`tabular mt-1.5 text-2xl font-semibold ${tone}`}>{value}</p>}
      {sub && !loading && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function MetricsRow({ metrics, loading }: { metrics: DashboardMetrics | null; loading: boolean }) {
  const c = metrics?.brand_currency ?? "USD";
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <MetricTile
        loading={loading}
        label="Open Leakage"
        tone="text-rose-300"
        value={money(metrics?.open_leakage_exposure, c, true)}
        sub={metrics ? `${integer(metrics.open_discrepancies)} open findings` : undefined}
      />
      <MetricTile
        loading={loading}
        label="Auto-Healed"
        tone="text-emerald-300"
        value={money(metrics?.auto_healed_value, c, true)}
        sub={metrics ? `${integer(metrics.auto_healed_count)} by AI · ${integer(metrics.pending_approval_count)} awaiting approval` : undefined}
      />
      <MetricTile
        loading={loading}
        label="Match Rate"
        tone="text-sky-300"
        value={metrics ? pct(metrics.match_rate_pct) : "—"}
        sub={metrics ? `${integer(metrics.total_orders)} orders compared` : undefined}
      />
      <MetricTile
        loading={loading}
        label="Not Banked"
        tone="text-violet-300"
        value={money(metrics?.settlements_not_deposited, c, true)}
        sub={metrics ? `of ${money(metrics.settlements_expected_total, c, true)} settled to bank` : undefined}
      />
      <MetricTile
        loading={loading}
        label="COD With Couriers"
        tone="text-orange-300"
        value={money(metrics?.cod_pending_remittance, c, true)}
        sub={metrics ? `${integer(metrics.cod_orders)} COD orders` : undefined}
      />
      <MetricTile
        loading={loading}
        label="Gateway Fees"
        tone="text-amber-300"
        value={money(metrics?.total_gateway_fees, c, true)}
        sub={metrics && num(metrics.total_gateway_gross) > 0 ? `${((num(metrics.total_gateway_fees) / num(metrics.total_gateway_gross)) * 100).toFixed(2)}% of ${money(metrics.total_gateway_gross, c, true)}` : undefined}
      />
    </div>
  );
}

function LeakageBreakdown({ metrics, loading }: { metrics: DashboardMetrics | null; loading: boolean }) {
  const c = metrics?.brand_currency ?? "USD";
  const max = Math.max(1, ...(metrics?.by_channel ?? []).map((ch) => num(ch.open_exposure)));
  return (
    <Card title="Leak State by Channel">
      {loading || !metrics ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : (
        <ul className="space-y-5">
          {metrics.by_channel.map((ch) => {
            const issues = metrics.by_issue_type.filter((i) => i.channel === ch.channel && i.open_count > 0);
            return (
              <li key={ch.channel}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-slate-200">{CHANNEL_META[ch.channel].label}</span>
                  <span className="tabular font-medium text-slate-100">{money(ch.open_exposure, c)}</span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-700">
                  <div className={`h-full rounded-full ${CHANNEL_META[ch.channel].bar}`} style={{ width: `${(num(ch.open_exposure) / max) * 100}%` }} />
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {integer(ch.open_count)} open · {integer(ch.resolved_count)} resolved · {CHANNEL_META[ch.channel].hint}
                </p>
                {issues.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {issues.map((i) => (
                      <Badge key={i.issue_type} className={ISSUE_META[i.issue_type].tone}>
                        {ISSUE_META[i.issue_type].label} · {integer(i.open_count)}
                      </Badge>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function CourierLedger({ metrics, loading }: { metrics: DashboardMetrics | null; loading: boolean }) {
  const c = metrics?.brand_currency ?? "USD";
  const rows = metrics?.courier_summary ?? [];
  return (
    <Card title="Courier COD Ledger">
      {loading || !metrics ? (
        <Skeleton className="h-24" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No courier report uploaded yet. Upload a TCS, Leopards, PostEx or Trax COD report to see who owes you cash.</p>
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-5 pb-2 font-medium">Courier</th>
                <th className="pb-2 text-right font-medium">Delivered</th>
                <th className="pb-2 text-right font-medium">COD collected</th>
                <th className="pb-2 text-right font-medium">Remitted</th>
                <th className="pb-2 text-right font-medium">With courier</th>
                <th className="pb-2 text-right font-medium">Overdue</th>
                <th className="px-5 pb-2 text-right font-medium">Return rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700">
              {rows.map((r) => (
                <tr key={r.courier_name}>
                  <td className="px-5 py-2 font-medium text-slate-200">{r.courier_name}</td>
                  <td className="tabular py-2 text-right text-slate-300">{integer(r.delivered)}</td>
                  <td className="tabular py-2 text-right text-slate-300">{money(r.cod_collected, c)}</td>
                  <td className="tabular py-2 text-right text-slate-300">{money(r.remitted, c)}</td>
                  <td className="tabular py-2 text-right text-orange-300">{money(r.pending_remittance, c)}</td>
                  <td className={`tabular py-2 text-right ${num(r.overdue_remittance) > 0 ? "font-medium text-rose-300" : "text-slate-500"}`}>
                    {money(r.overdue_remittance, c)}
                  </td>
                  <td className="tabular px-5 py-2 text-right text-slate-300">{pct(r.return_rate_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RootCausePanel({ metrics, loading }: { metrics: DashboardMetrics | null; loading: boolean }) {
  const c = metrics?.brand_currency ?? "USD";
  return (
    <Card title="AI Root-Cause Attribution">
      {loading || !metrics ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-7" />
          ))}
        </div>
      ) : metrics.by_root_cause.length === 0 ? (
        <p className="text-sm text-slate-500">No findings yet. Run a reconciliation to populate attribution.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th className="pb-2 font-medium">Category</th>
              <th className="pb-2 text-right font-medium">Count</th>
              <th className="pb-2 text-right font-medium">Exposure</th>
              <th className="pb-2 pl-4 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700">
            {metrics.by_root_cause.map((r) => (
              <tr key={r.category}>
                <td className="py-2 text-slate-200">{humanize(r.category)}</td>
                <td className="tabular py-2 text-right text-slate-300">{integer(r.count)}</td>
                <td className="tabular py-2 text-right text-slate-100">{money(r.exposure, c)}</td>
                <td className="py-2 pl-4">
                  <ConfidenceMeter value={r.avg_confidence} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/* ============================================================================
 * Tracking matrix (discrepancy explorer with nested fix previews)
 * ========================================================================== */
const FACT_FIELDS: [string, string, boolean][] = [
  ["days_outstanding", "Days outstanding", false],
  ["days_since_delivery", "Days since delivery", false],
  ["batch_items", "Items in batch", false],
  ["claim_amount", "Claim amount", true],
  ["recoverable_amount", "Recoverable", true],
  ["excess_amount", "Excess charged", true],
  ["refund_amount", "Refund", true],
  ["receivable_amount", "Receivable", true],
  ["unbooked_amount", "Unbooked", true],
  ["narration", "Bank narration", false],
];

function ApprovalTrailNote({ trail }: { trail: ApprovalTrail }) {
  const tone =
    trail.status === "APPROVED"
      ? "bg-emerald-500/10 text-emerald-200"
      : trail.status === "PENDING"
        ? "bg-amber-500/10 text-amber-200"
        : "bg-rose-500/10 text-rose-200";
  const text =
    trail.status === "APPROVED"
      ? `Approved by ${trail.approved_by === "policy:auto" ? "policy (below the auto-approve limit)" : trail.approved_by}`
      : trail.status === "PENDING"
        ? `Awaiting a checker · proposed by ${trail.proposed_by ?? "AI Auto-Healer"}`
        : trail.status === "REJECTED"
          ? `Rejected by ${trail.rejected_by}`
          : trail.note ?? "A checker rejected this AI fix earlier";
  return (
    <p className={`rounded-md px-2 py-1.5 text-xs ${tone}`}>
      <span className="font-semibold">Maker-checker:</span> {text}
      {trail.checker_note ? ` — “${trail.checker_note}”` : ""}
    </p>
  );
}

function FixPreview({ fix, currency }: { fix: SuggestedFix | null; currency: string }) {
  if (!fix) return <p className="text-xs text-slate-500">No AI analysis attached yet.</p>;
  const events = fix.evidence?.events ?? [];
  const facts = FACT_FIELDS.filter(([key]) => fix[key] !== undefined && fix[key] !== null);
  const records = fix.evidence && events.length === 0 ? Object.entries(fix.evidence).filter(([, v]) => v !== null && v !== "") : [];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Proposed action</p>
        <p className="font-mono text-sm text-emerald-300">{fix.action ?? "—"}</p>
        {fix.reason && <p className="text-xs leading-relaxed text-slate-400">{fix.reason}</p>}
        {fix.priority && <Badge className="text-amber-300 bg-amber-500/10 ring-amber-500/30">Priority {fix.priority}</Badge>}
        {facts.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {facts.map(([key, label, isMoney]) => (
              <Fragment key={key}>
                <dt className="text-slate-500">{label}</dt>
                <dd className="tabular text-slate-200">{isMoney ? money(fix[key] as number, currency) : cell(fix[key])}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {fix.transform && (
          <div className="rounded-lg border border-ink-600 bg-ink-850 p-2.5 font-mono text-[11px] text-slate-300">
            <span className="text-slate-500">{fix.target_table}.</span>
            {fix.transform.field}: <span className="text-rose-300 line-through">{cell(fix.transform.from)}</span> →{" "}
            <span className="text-emerald-300">{cell(fix.transform.to)}</span>
          </div>
        )}
        {fix.next_steps && (
          <ol className="list-decimal space-y-0.5 pl-4 text-xs text-slate-400">
            {fix.next_steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        )}
        {fix.manual_resolution && (
          <p className="rounded-md bg-sky-500/10 px-2 py-1.5 text-xs text-sky-200">
            Proposed by {fix.manual_resolution.resolved_by}: “{fix.manual_resolution.note}”
          </p>
        )}
        {fix.approval && <ApprovalTrailNote trail={fix.approval} />}
      </div>
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Journal entry</p>
        {fix.journal && fix.journal.length > 0 ? (
          <table className="w-full text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="pb-1 text-left font-medium">Account</th>
                <th className="pb-1 text-right font-medium">Dr</th>
                <th className="pb-1 text-right font-medium">Cr</th>
              </tr>
            </thead>
            <tbody>
              {fix.journal.map((j, idx) => (
                <tr key={`${j.account}-${idx}`} className="border-t border-ink-700">
                  <td className="py-1 text-slate-300">{j.account}</td>
                  <td className="tabular py-1 text-right text-slate-200">{j.debit ? money(j.debit, currency) : ""}</td>
                  <td className="tabular py-1 text-right text-slate-200">{j.credit ? money(j.credit, currency) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-slate-500">No ledger posting proposed.</p>
        )}
      </div>
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Evidence</p>
        {events.length > 0 ? (
          <ul className="space-y-1.5">
            {events.map((ev) => (
              <li key={ev.id} className="rounded-lg border border-ink-600 bg-ink-850 p-2 font-mono text-[11px] text-slate-300">
                <span className="text-sky-300">{ev.provider}</span> · {ev.type} · {ev.transaction_id}
                <br />
                gross {cell(ev.amount)} · fee {cell(ev.fee)} · {ev.presentment_currency}→{ev.settlement_currency} @ {ev.fx_rate}
              </li>
            ))}
            {fix.evidence?.discount_codes_seen && (
              <li className="text-[11px] text-slate-500">Discount codes in checkout log: {fix.evidence.discount_codes_seen.join(", ")}</li>
            )}
          </ul>
        ) : records.length > 0 ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg border border-ink-600 bg-ink-850 p-2.5 font-mono text-[11px]">
            {records.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-slate-500">{key.replace(/_cents$/, "")}</dt>
                <dd className="break-all text-slate-300">{key.endsWith("_cents") ? money(Number(value) / 100, currency) : cell(value)}</dd>
              </Fragment>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-slate-500">No supporting gateway, courier or bank record exists for this reference.</p>
        )}
      </div>
    </div>
  );
}

function TrackingMatrix({ token, currency, refreshKey, canResolve, onChanged }: { token: string; currency: string; refreshKey: number; canResolve: boolean; onChanged: () => void }) {
  const [status, setStatus] = useState<DiscrepancyStatus | "">("UNRESOLVED");
  const [issue, setIssue] = useState<IssueType | "">("");
  const [channel, setChannel] = useState<Channel | "">("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<DiscrepancyPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const limit = 15;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setOffset(0), [status, issue, channel, debounced]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset), sort: "variance" });
    if (status) params.set("status", status);
    if (issue) params.set("issue_type", issue);
    if (channel) params.set("channel", channel);
    if (debounced) params.set("search", debounced);
    setLoading(true);
    api<DiscrepancyPage>(`/api/v1/discrepancies?${params.toString()}`, token)
      .then((p) => {
        if (!cancelled) {
          setPage(p);
          setError(null);
        }
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token, status, issue, channel, debounced, offset, refreshKey]);

  async function resolve(d: Discrepancy) {
    const note = window.prompt(`Resolution note for ${d.source_order_number}`, "Verified against bank statement");
    if (!note || note.trim().length < 3) return;
    setResolving(d.log_id);
    try {
      const updated = await api<Discrepancy>(`/api/v1/discrepancies/${d.log_id}/resolve`, token, {
        method: "POST",
        body: JSON.stringify({ resolution_note: note.trim() }),
      });
      setNotice(
        updated.status === "PENDING_APPROVAL"
          ? `${d.source_order_number} sent to a checker for approval.`
          : `${d.source_order_number} resolved (below the approval limit).`,
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resolve failed");
    } finally {
      setResolving(null);
    }
  }

  const select = "rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-emerald-500";
  const totalPages = page ? Math.max(1, Math.ceil(page.total / limit)) : 1;

  return (
    <Card
      title="Discrepancy Tracking Matrix"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search findings" placeholder="Search order / ref" className={`${select} w-36`} />
          <select
            aria-label="Channel filter"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as Channel | "");
              setIssue("");
            }}
            className={select}
          >
            <option value="">All channels</option>
            {(Object.keys(CHANNEL_META) as Channel[]).map((k) => (
              <option key={k} value={k}>
                {CHANNEL_META[k].label}
              </option>
            ))}
          </select>
          <select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as DiscrepancyStatus | "")} className={select}>
            <option value="">All statuses</option>
            <option value="UNRESOLVED">Unresolved</option>
            <option value="PENDING_APPROVAL">Pending approval</option>
            <option value="RESOLVED">Resolved</option>
          </select>
          <select aria-label="Issue type filter" value={issue} onChange={(e) => setIssue(e.target.value as IssueType | "")} className={select}>
            <option value="">All issue types</option>
            {(Object.keys(CHANNEL_META) as Channel[])
              .filter((ch) => !channel || ch === channel)
              .map((ch) => (
                <optgroup key={ch} label={CHANNEL_META[ch].label}>
                  {(Object.keys(ISSUE_META) as IssueType[])
                    .filter((k) => ISSUE_CHANNEL[k] === ch)
                    .map((k) => (
                      <option key={k} value={k}>
                        {ISSUE_META[k].label}
                      </option>
                    ))}
                </optgroup>
              ))}
          </select>
        </div>
      }
    >
      {error && <p className="mb-3 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      {notice && <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{notice}</p>}
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th className="px-5 pb-2 font-medium">Order ref</th>
              <th className="pb-2 font-medium">Issue</th>
              <th className="pb-2 text-right font-medium">Expected</th>
              <th className="pb-2 text-right font-medium">Received</th>
              <th className="pb-2 text-right font-medium">Variance</th>
              <th className="pb-2 pl-5 font-medium">AI root cause</th>
              <th className="pb-2 font-medium">Confidence</th>
              <th className="px-5 pb-2 text-right font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {loading && !page
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={8} className="px-5 py-2">
                      <Skeleton className="h-6" />
                    </td>
                  </tr>
                ))
              : page?.items.map((d) => {
                  const open = expanded === d.log_id;
                  const variance = num(d.variance_amount);
                  return (
                    <Fragment key={d.log_id}>
                      <tr
                        onClick={() => setExpanded(open ? null : d.log_id)}
                        className={`cursor-pointer border-b border-ink-800 transition hover:bg-ink-850 ${open ? "bg-ink-850" : ""} ${loading ? "opacity-60" : ""}`}
                      >
                        <td className="px-5 py-2.5 font-mono text-xs text-slate-200">
                          <span className="mr-1.5 inline-block w-3 text-slate-500">{open ? "▾" : "▸"}</span>
                          {d.source_order_number}
                        </td>
                        <td className="py-2.5">
                          <Badge className={ISSUE_META[d.issue_type].tone}>{ISSUE_META[d.issue_type].label}</Badge>
                        </td>
                        <td className="tabular py-2.5 text-right text-slate-300">{money(d.order_amount, currency)}</td>
                        <td className="tabular py-2.5 text-right text-slate-300">{money(d.gateway_amount, currency)}</td>
                        <td className={`tabular py-2.5 text-right font-medium ${variance > 0 ? "text-rose-300" : "text-amber-300"}`}>
                          {money(variance, currency)}
                        </td>
                        <td className="py-2.5 pl-5 text-xs text-slate-300">{d.ai_root_cause_category ? humanize(d.ai_root_cause_category) : "Pending"}</td>
                        <td className="py-2.5">
                          <ConfidenceMeter value={d.ai_confidence_score} />
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          {d.claim_number && d.status === "UNRESOLVED" ? (
                            <Badge className={TONE.sky}>Claimed · {d.claim_number}</Badge>
                          ) : d.status === "PENDING_APPROVAL" ? (
                            <Badge className={TONE.amber}>Awaiting checker</Badge>
                          ) : d.status === "RESOLVED" ? (
                            <Badge className="text-emerald-300 bg-emerald-500/10 ring-emerald-500/30">{d.auto_resolved ? "Auto-healed" : "Resolved"}</Badge>
                          ) : canResolve ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void resolve(d);
                              }}
                              disabled={resolving === d.log_id}
                              className="inline-flex items-center gap-1.5 rounded-md border border-ink-600 px-2 py-0.5 text-[11px] text-slate-300 hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-50"
                            >
                              {resolving === d.log_id && <Spinner className="h-3 w-3" />} Resolve
                            </button>
                          ) : (
                            <Badge className="text-slate-300 bg-slate-500/10 ring-slate-500/30">Open</Badge>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-ink-700 bg-ink-950/60">
                          <td colSpan={8} className="px-5 py-4">
                            <PanelBoundary title="Fix preview">
                              <FixPreview fix={d.ai_suggested_fix} currency={currency} />
                            </PanelBoundary>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
            {!loading && page?.items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-sm text-slate-500">
                  No discrepancies match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className="mt-4 flex items-center justify-between text-xs text-slate-500">
        <span>{page ? `${integer(page.total)} findings` : " "}</span>
        <div className="flex items-center gap-2">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} className="rounded-md border border-ink-600 px-2.5 py-1 hover:text-slate-200 disabled:opacity-40">
            Prev
          </button>
          <span className="tabular">
            {Math.floor(offset / limit) + 1} / {totalPages}
          </span>
          <button
            disabled={!page || offset + limit >= page.total}
            onClick={() => setOffset(offset + limit)}
            className="rounded-md border border-ink-600 px-2.5 py-1 hover:text-slate-200 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </footer>
    </Card>
  );
}

/* ============================================================================
 * Chat-with-your-Ledger console
 * ========================================================================== */
/* ============================================================================
 * Maker-checker approvals inbox + policy
 * ========================================================================== */
const MODE_LABEL: Record<AutoHealMode, string> = {
  AUTO: "AI fixes post immediately",
  THRESHOLD: "AI fixes post up to a limit, larger ones need a checker",
  ALWAYS_APPROVE: "Every AI fix needs a checker",
};

function PolicyEditor({ token, canEdit, currency }: { token: string; canEdit: boolean; currency: string }) {
  const [policy, setPolicy] = useState<ApprovalPolicy | null>(null);
  const [draft, setDraft] = useState<ApprovalPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api<ApprovalPolicy>("/api/v1/approval-policy", token)
      .then((p) => {
        setPolicy(p);
        setDraft(p);
      })
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "Failed to load policy"));
  }, [token]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api<ApprovalPolicy>("/api/v1/approval-policy", token, {
        method: "PUT",
        body: JSON.stringify({
          auto_heal_mode: draft.auto_heal_mode,
          auto_heal_max_amount: String(draft.auto_heal_max_amount || 0),
          manual_requires_approval: draft.manual_requires_approval,
          manual_auto_approve_max: String(draft.manual_auto_approve_max || 0),
        }),
      });
      setPolicy(saved);
      setDraft(saved);
      setMessage("Policy saved. It applies from the next reconciliation and resolution.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!policy || !draft) return message ? <p className="text-xs text-rose-300">{message}</p> : <Skeleton className="h-16" />;
  const input = "rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-emerald-500 disabled:opacity-60";
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-850/60 p-4 text-xs">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-slate-400">AI Auto-Healer</span>
          <select disabled={!canEdit} value={draft.auto_heal_mode} onChange={(e) => setDraft({ ...draft, auto_heal_mode: e.target.value as AutoHealMode })} className={input}>
            {(Object.keys(MODE_LABEL) as AutoHealMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-400">AI auto-post limit ({currency})</span>
          <input
            disabled={!canEdit || draft.auto_heal_mode !== "THRESHOLD"}
            type="number"
            min={0}
            step="0.01"
            value={String(draft.auto_heal_max_amount)}
            onChange={(e) => setDraft({ ...draft, auto_heal_max_amount: e.target.value })}
            className={input}
          />
        </label>
        <label className="flex items-center gap-2 text-slate-300">
          <input
            disabled={!canEdit}
            type="checkbox"
            checked={draft.manual_requires_approval}
            onChange={(e) => setDraft({ ...draft, manual_requires_approval: e.target.checked })}
            className="h-4 w-4 accent-emerald-500"
          />
          Manual resolutions need a second person
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-400">Manual auto-approve limit ({currency})</span>
          <input
            disabled={!canEdit || !draft.manual_requires_approval}
            type="number"
            min={0}
            step="0.01"
            value={String(draft.manual_auto_approve_max)}
            onChange={(e) => setDraft({ ...draft, manual_auto_approve_max: e.target.value })}
            className={input}
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-slate-500">
        <span>
          {policy.updated_by_email ? `Last changed by ${policy.updated_by_email} ${timeAgo(policy.updated_at)}` : "Default policy"}
          {canEdit ? "" : " · only owners and admins can change it"}
        </span>
        {canEdit && (
          <button onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1 font-semibold text-ink-950 hover:bg-emerald-400 disabled:opacity-60">
            {saving && <Spinner className="h-3 w-3" />} Save policy
          </button>
        )}
      </div>
      {message && <p className="mt-2 text-slate-300">{message}</p>}
    </div>
  );
}

/* ============================================================================
 * Recovery & claims
 * ========================================================================== */
type ClaimStatus = "DRAFT" | "SUBMITTED" | "PARTIALLY_RECOVERED" | "RECOVERED" | "REJECTED" | "WRITTEN_OFF" | "CANCELLED";
type CounterpartyType = "COURIER" | "GATEWAY" | "BANK";

interface ClaimableFinding {
  log_id: string;
  source_order_number: string;
  issue_type: IssueType;
  channel: Channel;
  amount: Money;
  root_cause_category: string | null;
  counterparty_type: CounterpartyType;
  counterparty_name: string;
  evidence: Record<string, string | number | null>;
}

interface ClaimableGroup {
  counterparty_type: CounterpartyType;
  counterparty_name: string;
  total: Money;
  count: number;
  items: ClaimableFinding[];
}

interface ClaimRow {
  claim_id: string;
  claim_number: string;
  counterparty_type: CounterpartyType;
  counterparty_name: string;
  counterparty_contact: string | null;
  currency: string;
  status: ClaimStatus;
  claimed_amount: Money;
  recovered_amount: Money;
  written_off_amount: Money;
  outstanding_amount: Money;
  due_date: string | null;
  created_at: string;
  submitted_at: string | null;
  item_count?: number | null;
}

interface ClaimItem {
  item_id: string;
  source_order_number: string;
  issue_type: IssueType;
  channel: Channel;
  amount: Money;
  evidence: Record<string, string | number | null>;
  data_cleared_amount: Money;
  active: boolean;
  finding_status: string | null;
}

interface ClaimEvent {
  event_id: string;
  kind: string;
  amount: Money | null;
  reference: string | null;
  note: string | null;
  actor_email: string | null;
  occurred_on: string;
  created_at: string;
}

interface ClaimDetail extends ClaimRow {
  items: ClaimItem[];
  events: ClaimEvent[];
  letter_subject: string;
  letter_text: string;
  email_sent?: boolean | null;
  email_error?: string | null;
  resolutions?: { source_order_number: string; status: string }[];
}

interface ClaimPageData {
  total: number;
  items: ClaimRow[];
}

interface RecoverySummaryData {
  currency: string;
  claimable_count: number;
  claimable_value: Money;
  open_claims: number;
  open_value: Money;
  recovered_total: Money;
  recovered_this_month: Money;
  written_off_total: Money;
  recovery_rate_pct: Money | null;
}

const CLAIM_META: Record<ClaimStatus, { label: string; tone: string }> = {
  DRAFT: { label: "Draft", tone: "text-slate-300 bg-slate-500/10 ring-slate-500/30" },
  SUBMITTED: { label: "Sent", tone: TONE.sky },
  PARTIALLY_RECOVERED: { label: "Partly recovered", tone: TONE.amber },
  RECOVERED: { label: "Recovered", tone: "text-emerald-300 bg-emerald-500/10 ring-emerald-500/30" },
  REJECTED: { label: "Rejected", tone: TONE.rose },
  WRITTEN_OFF: { label: "Written off", tone: TONE.violet },
  CANCELLED: { label: "Cancelled", tone: "text-slate-400 bg-slate-500/10 ring-slate-500/30" },
};

const plural = (n: number, word: string): string => `${integer(n)} ${word}${n === 1 ? "" : "s"}`;

const OPEN_CLAIM_STATUSES: ClaimStatus[] = ["DRAFT", "SUBMITTED", "PARTIALLY_RECOVERED"];

const EVENT_LABEL: Record<string, string> = {
  CREATED: "Claim drafted",
  SUBMITTED: "Sent to counterparty",
  EMAILED: "Letter emailed",
  PAYMENT: "Payment received",
  DATA_MATCH: "Payment seen in courier / bank data",
  REJECTED: "Rejected by counterparty",
  WRITTEN_OFF: "Balance written off",
  CANCELLED: "Draft cancelled",
};

function RecoveryPanel({
  token,
  refreshKey,
  canWrite,
  onChanged,
}: {
  token: string;
  refreshKey: number;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"claimable" | "claims">("claimable");
  const [summary, setSummary] = useState<RecoverySummaryData | null>(null);
  const [groups, setGroups] = useState<ClaimableGroup[] | null>(null);
  const [claims, setClaims] = useState<ClaimPageData | null>(null);
  const [claimFilter, setClaimFilter] = useState<string>("OPEN");
  const [openClaim, setOpenClaim] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localKey, setLocalKey] = useState(0);

  const reload = useCallback(() => setLocalKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ limit: "50" });
    if (claimFilter) params.set("status", claimFilter);
    Promise.all([
      api<RecoverySummaryData>("/api/v1/recovery/summary", token),
      api<ClaimableGroup[]>("/api/v1/recovery/claimable", token),
      api<ClaimPageData>(`/api/v1/claims?${params.toString()}`, token),
    ])
      .then(([s, g, c]) => {
        if (cancelled) return;
        setSummary(s);
        setGroups(g);
        setClaims(c);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load recovery"));
    return () => {
      cancelled = true;
    };
  }, [token, refreshKey, localKey, claimFilter]);

  const currency = summary?.currency ?? "USD";

  async function createClaim(group: ClaimableGroup) {
    const ids = group.items.filter((i) => !excluded.has(i.log_id)).map((i) => i.log_id);
    if (ids.length === 0) return;
    setBusy(group.counterparty_name);
    setError(null);
    try {
      const claim = await api<ClaimDetail>("/api/v1/claims", token, { method: "POST", body: JSON.stringify({ log_ids: ids }) });
      setNotice(`${claim.claim_number} drafted for ${claim.counterparty_name}: ${money(claim.claimed_amount, currency)}.`);
      setTab("claims");
      setClaimFilter("OPEN");
      setOpenClaim(claim.claim_id);
      reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the claim");
    } finally {
      setBusy(null);
    }
  }

  const tile = (label: string, value: string, sub: string, tone: string) => (
    <div className="rounded-xl border border-ink-700 bg-ink-850/60 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className={`tabular mt-1 text-lg font-semibold ${tone}`}>{value}</p>
      <p className="text-[11px] text-slate-500">{sub}</p>
    </div>
  );
  const tabClass = (on: boolean) =>
    `rounded-md px-2.5 py-1 text-xs ${on ? "bg-ink-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`;

  return (
    <Card
      title="Recovery & Claims"
      action={
        <div className="flex flex-wrap items-center gap-2">
          {summary && (
            <Badge className="text-emerald-300 bg-emerald-500/10 ring-emerald-500/30">
              {money(summary.recovered_this_month, currency)} recovered this month
            </Badge>
          )}
          <div className="inline-flex rounded-lg border border-ink-600 p-0.5" role="tablist">
            <button role="tab" aria-selected={tab === "claimable"} onClick={() => setTab("claimable")} className={tabClass(tab === "claimable")}>
              Claimable ({summary?.claimable_count ?? 0})
            </button>
            <button role="tab" aria-selected={tab === "claims"} onClick={() => setTab("claims")} className={tabClass(tab === "claims")}>
              Claims ({summary?.open_claims ?? 0} open)
            </button>
          </div>
        </div>
      }
    >
      {summary ? (
        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          {tile("Recovered this month", money(summary.recovered_this_month, currency), "payments + matches in data", "text-emerald-300")}
          {tile(
            "Recovered to date",
            money(summary.recovered_total, currency),
            summary.recovery_rate_pct === null ? "no claims sent yet" : `${pct(summary.recovery_rate_pct)} of amounts claimed`,
            "text-emerald-300",
          )}
          {tile("Out with counterparties", money(summary.open_value, currency), plural(summary.open_claims, "open claim"), "text-amber-300")}
          {tile("Claimable now", money(summary.claimable_value, currency), plural(summary.claimable_count, "finding"), "text-rose-300")}
        </div>
      ) : (
        <Skeleton className="mb-4 h-16" />
      )}
      {error && <p className="mb-3 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      {notice && <p className="mb-3 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">{notice}</p>}

      {tab === "claimable" ? (
        !groups ? (
          <Skeleton className="h-24" />
        ) : groups.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">Nothing to claim: no courier, gateway or bank owes you money right now.</p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => {
              const chosen = g.items.filter((i) => !excluded.has(i.log_id));
              const chosenTotal = chosen.reduce((sum, i) => sum + num(i.amount), 0);
              return (
                <div key={`${g.counterparty_type}:${g.counterparty_name}`} className="rounded-xl border border-ink-700" data-testid="claimable-group">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-700 px-4 py-2.5">
                    <div>
                      <p className="text-sm font-semibold text-slate-100">{g.counterparty_name}</p>
                      <p className="text-[11px] text-slate-500">
                        {humanize(g.counterparty_type)} · {plural(g.count, "finding")} · {money(g.total, currency)} owed
                      </p>
                    </div>
                    {canWrite && (
                      <button
                        onClick={() => void createClaim(g)}
                        disabled={chosen.length === 0 || busy === g.counterparty_name}
                        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1 text-xs font-semibold text-ink-950 hover:bg-emerald-400 disabled:opacity-50"
                      >
                        {busy === g.counterparty_name && <Spinner className="h-3 w-3" />} Create claim ({money(chosenTotal, currency)})
                      </button>
                    )}
                  </div>
                  <ul className="divide-y divide-ink-800 text-xs">
                    {g.items.map((i) => (
                      <li key={i.log_id} className="flex items-center gap-3 px-4 py-2">
                        {canWrite && (
                          <input
                            type="checkbox"
                            aria-label={`Include ${i.source_order_number}`}
                            checked={!excluded.has(i.log_id)}
                            onChange={() =>
                              setExcluded((prev) => {
                                const next = new Set(prev);
                                if (next.has(i.log_id)) next.delete(i.log_id);
                                else next.add(i.log_id);
                                return next;
                              })
                            }
                            className="h-4 w-4 accent-emerald-500"
                          />
                        )}
                        <span className="w-24 font-mono text-slate-200">{i.source_order_number}</span>
                        <Badge className={ISSUE_META[i.issue_type].tone}>{ISSUE_META[i.issue_type].label}</Badge>
                        <span className="hidden flex-1 truncate text-slate-500 md:block">
                          {i.evidence.tracking_number ? `CN ${i.evidence.tracking_number}` : ""}
                          {i.evidence.delivered_at ? ` · delivered ${String(i.evidence.delivered_at).slice(0, 10)}` : ""}
                        </span>
                        <span className="tabular ml-auto text-slate-200">{money(i.amount, currency)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )
      ) : (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <select
              aria-label="Claim status filter"
              value={claimFilter}
              onChange={(e) => {
                setClaimFilter(e.target.value);
                setOpenClaim(null);
              }}
              className="rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-emerald-500"
            >
              <option value="OPEN">Open claims</option>
              <option value="">All claims</option>
              {(Object.keys(CLAIM_META) as ClaimStatus[]).map((s) => (
                <option key={s} value={s}>
                  {CLAIM_META[s].label}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-slate-500">{claims ? plural(claims.total, "claim") : ""}</span>
          </div>
          {!claims ? (
            <Skeleton className="h-24" />
          ) : claims.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">No claims here yet. Create one from the Claimable tab.</p>
          ) : (
            <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
              {claims.items.map((c) => (
                <li key={c.claim_id} data-testid="claim-row">
                  <button
                    onClick={() => setOpenClaim(openClaim === c.claim_id ? null : c.claim_id)}
                    className="flex w-full flex-wrap items-center gap-3 px-4 py-2.5 text-left text-xs hover:bg-ink-850"
                  >
                    <span className="font-mono text-slate-200">{c.claim_number}</span>
                    <span className="font-medium text-slate-100">{c.counterparty_name}</span>
                    <Badge className={CLAIM_META[c.status].tone}>{CLAIM_META[c.status].label}</Badge>
                    <span className="tabular ml-auto text-slate-400">
                      claimed {money(c.claimed_amount, currency)} · recovered{" "}
                      <span className="text-emerald-300">{money(c.recovered_amount, currency)}</span>
                    </span>
                  </button>
                  {openClaim === c.claim_id && (
                    <PanelBoundary title="Claim">
                      <ClaimView
                        token={token}
                        claimId={c.claim_id}
                        canWrite={canWrite}
                        onChanged={(message, status) => {
                          setNotice(message);
                          // Keep a claim the user is working on in view after it closes (recovered, written off…).
                          if (claimFilter === "OPEN" && !OPEN_CLAIM_STATUSES.includes(status)) setClaimFilter("");
                          reload();
                          onChanged();
                        }}
                      />
                    </PanelBoundary>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function ClaimView({
  token,
  claimId,
  canWrite,
  onChanged,
}: {
  token: string;
  claimId: string;
  canWrite: boolean;
  onChanged: (message: string, status: ClaimStatus) => void;
}) {
  const [claim, setClaim] = useState<ClaimDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [contact, setContact] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [showLetter, setShowLetter] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    api<ClaimDetail>(`/api/v1/claims/${claimId}`, token)
      .then((c) => {
        setClaim(c);
        setContact(c.counterparty_contact ?? "");
        setAmount(num(c.outstanding_amount).toFixed(2));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the claim"));
  }, [claimId, token]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(name: string, path: string, body: unknown, describe: (c: ClaimDetail) => string) {
    setBusy(name);
    setError(null);
    try {
      const updated = await api<ClaimDetail>(`/api/v1/claims/${claimId}/${path}`, token, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      setClaim(updated);
      setAmount(num(updated.outstanding_amount).toFixed(2));
      setReference("");
      onChanged(describe(updated), updated.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  function sentToCheckers(c: ClaimDetail): string {
    const pending = (c.resolutions ?? []).filter((r) => r.status === "PENDING_APPROVAL").length;
    return pending ? ` ${plural(pending, "finding")} sent to a checker to close.` : "";
  }

  async function printLetter() {
    const letter = await api<{ subject: string; html: string }>(`/api/v1/claims/${claimId}/letter`, token);
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!doctype html><title>${letter.subject.replace(/</g, "&lt;")}</title>${letter.html}`);
    w.document.close();
    w.focus();
    w.print();
  }

  if (error && !claim) return <p className="px-4 pb-3 text-xs text-rose-300">{error}</p>;
  if (!claim) return <Skeleton className="mx-4 mb-3 h-16" />;
  const c = claim.currency;
  const collecting = claim.status === "SUBMITTED" || claim.status === "PARTIALLY_RECOVERED";
  const field = "rounded-md border border-ink-600 bg-ink-850 px-2 py-1 text-xs text-slate-100 outline-none focus:border-emerald-500";
  const button = "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] disabled:opacity-50";

  return (
    <div className="space-y-3 bg-ink-950/60 px-4 pb-4 pt-2 text-xs" data-testid="claim-detail">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <p className="text-slate-400">Claimed <span className="tabular block text-sm text-slate-100">{money(claim.claimed_amount, c)}</span></p>
        <p className="text-slate-400">Recovered <span className="tabular block text-sm text-emerald-300">{money(claim.recovered_amount, c)}</span></p>
        <p className="text-slate-400">Outstanding <span className="tabular block text-sm text-amber-300">{money(claim.outstanding_amount, c)}</span></p>
        <p className="text-slate-400">Due <span className="block text-sm text-slate-100">{claim.due_date ?? "—"}</span></p>
      </div>

      <table className="w-full">
        <tbody>
          {claim.items.map((i) => (
            <tr key={i.item_id} className="border-b border-ink-800">
              <td className="py-1.5 font-mono text-slate-200">{i.source_order_number}</td>
              <td className="py-1.5">
                <Badge className={ISSUE_META[i.issue_type].tone}>{ISSUE_META[i.issue_type].label}</Badge>
              </td>
              <td className="py-1.5 text-slate-500">{i.finding_status ? humanize(i.finding_status) : "Cleared in data"}</td>
              <td className="tabular py-1.5 text-right text-slate-200">{money(i.amount, c)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && <p className="rounded-md bg-rose-500/10 px-3 py-2 text-rose-300">{error}</p>}
      {claim.email_error && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-amber-200">{claim.email_error}</p>}

      {canWrite && claim.status === "DRAFT" && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            aria-label="Counterparty email"
            placeholder="claims@courier.com (optional)"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            className={`${field} w-56`}
          />
          <button
            disabled={!!busy || !contact}
            onClick={() =>
              void act("email", "submit", { send_email: true, counterparty_contact: contact }, (u) =>
                u.email_sent ? `${u.claim_number} emailed to ${u.counterparty_contact}.` : `${u.claim_number} marked as sent; email failed.`,
              )
            }
            className={`${button} border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10`}
          >
            {busy === "email" && <Spinner className="h-3 w-3" />} Email letter
          </button>
          <button
            disabled={!!busy}
            onClick={() =>
              void act("send", "submit", contact ? { counterparty_contact: contact } : {}, (u) => `${u.claim_number} marked as sent to ${u.counterparty_name}.`)
            }
            className={`${button} border-sky-500/50 text-sky-300 hover:bg-sky-500/10`}
          >
            {busy === "send" && <Spinner className="h-3 w-3" />} Mark as sent
          </button>
          <button
            disabled={!!busy}
            onClick={() => void act("cancel", "cancel", undefined, (u) => `${u.claim_number} cancelled; its findings can be claimed again.`)}
            className={`${button} border-ink-600 text-slate-300 hover:border-slate-400`}
          >
            Cancel draft
          </button>
        </div>
      )}

      {canWrite && collecting && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act("pay", "payments", { amount, reference: reference || null }, (u) =>
              u.status === "RECOVERED"
                ? `${u.claim_number} fully recovered.${sentToCheckers(u)}`
                : `${money(amount, c)} recorded on ${u.claim_number}; ${money(u.outstanding_amount, c)} still outstanding.`,
            );
          }}
        >
          <input aria-label="Amount received" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${field} w-28 text-right`} />
          <input aria-label="Payment reference" placeholder="Bank / UTR reference" value={reference} onChange={(e) => setReference(e.target.value)} className={`${field} w-44`} />
          <button type="submit" disabled={!!busy || num(amount) <= 0} className={`${button} border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10`}>
            {busy === "pay" && <Spinner className="h-3 w-3" />} Record payment
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => {
              const note = window.prompt(`Why did ${claim.counterparty_name} reject ${claim.claim_number}?`, "");
              if (note && note.trim().length >= 3)
                void act("reject", "reject", { note: note.trim() }, (u) => `${u.claim_number} marked rejected; its findings are open again.`);
            }}
            className={`${button} border-rose-500/40 text-rose-300 hover:bg-rose-500/10`}
          >
            Mark rejected
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => {
              const note = window.prompt(`Reason for writing off ${money(claim.outstanding_amount, c)} on ${claim.claim_number}?`, "");
              if (note && note.trim().length >= 3)
                void act("writeoff", "write-off", { note: note.trim() }, (u) => `${u.claim_number} written off.${sentToCheckers(u)}`);
            }}
            className={`${button} border-violet-500/40 text-violet-300 hover:bg-violet-500/10`}
          >
            Write off balance
          </button>
        </form>
      )}

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setShowLetter(!showLetter)} className={`${button} border-ink-600 text-slate-300 hover:border-slate-400`}>
          {showLetter ? "Hide letter" : "View letter"}
        </button>
        <button onClick={() => void printLetter()} className={`${button} border-ink-600 text-slate-300 hover:border-slate-400`}>
          Print / PDF
        </button>
      </div>
      {showLetter && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-medium text-slate-200">{claim.letter_subject}</p>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(claim.letter_text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className={`${button} border-ink-600 text-slate-300 hover:border-slate-400`}
            >
              {copied ? "Copied" : "Copy letter"}
            </button>
          </div>
          <pre className="whitespace-pre-wrap font-sans leading-relaxed text-slate-300" data-testid="claim-letter">
            {claim.letter_text}
          </pre>
        </div>
      )}

      <ol className="space-y-1 border-l border-ink-700 pl-3" aria-label="Claim timeline">
        {claim.events.map((e) => (
          <li key={e.event_id} className="text-slate-400">
            <span className="text-slate-200">{EVENT_LABEL[e.kind] ?? humanize(e.kind)}</span>
            {e.amount !== null && e.kind !== "CREATED" ? ` · ${money(e.amount, c)}` : ""}
            {e.reference ? ` · ref ${e.reference}` : ""} · {e.occurred_on}
            {e.actor_email && !e.actor_email.startsWith("auditx:") ? ` · ${e.actor_email}` : ""}
            {e.note ? <span className="block text-[11px] text-slate-500">{e.note}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ApprovalsInbox({
  token,
  currency,
  refreshKey,
  canApprove,
  canEditPolicy,
  onChanged,
}: {
  token: string;
  currency: string;
  refreshKey: number;
  canApprove: boolean;
  canEditPolicy: boolean;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<RequestStatus>("PENDING");
  const [maker, setMaker] = useState<"" | "AI" | "USER">("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ApprovalPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showPolicy, setShowPolicy] = useState(false);
  const limit = 10;

  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [status, maker]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ status, limit: String(limit), offset: String(offset) });
    if (maker) params.set("proposed_by_type", maker);
    setLoading(true);
    api<ApprovalPageData>(`/api/v1/approvals?${params.toString()}`, token)
      .then((p) => {
        if (!cancelled) {
          setPage(p);
          setError(null);
        }
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load approvals"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token, status, maker, offset, refreshKey]);

  async function act(r: ApprovalRequest, action: "approve" | "reject" | "withdraw") {
    let body: string | undefined;
    if (action === "reject") {
      const reason = window.prompt(`Why reject the fix for ${r.source_order_number}?`, "");
      if (!reason || !reason.trim()) return;
      body = JSON.stringify({ note: reason.trim() });
    } else if (action === "approve") {
      body = JSON.stringify({});
    }
    setBusy(r.request_id);
    setError(null);
    try {
      await api(`/api/v1/approvals/${r.request_id}/${action}`, token, { method: "POST", body });
      setNotice(`${r.source_order_number}: ${action === "approve" ? "approved" : action === "reject" ? "rejected and reopened" : "withdrawn"}.`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function approveSelected() {
    if (selected.size === 0) return;
    setBusy("bulk");
    setError(null);
    try {
      const result = await api<BulkResult>("/api/v1/approvals/bulk-approve", token, {
        method: "POST",
        body: JSON.stringify({ request_ids: Array.from(selected) }),
      });
      const failed = Object.keys(result.failed).length;
      setNotice(`${result.approved.length} approved${failed ? `, ${failed} skipped (${Object.values(result.failed)[0]})` : ""}.`);
      setSelected(new Set());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk approval failed");
    } finally {
      setBusy(null);
    }
  }

  const items = page?.items ?? [];
  const selectable = items.filter((r) => r.status === "PENDING" && canApprove && !r.is_mine);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.request_id));
  const select = "rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-emerald-500";
  const smallButton = "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50";

  return (
    <Card
      title="Approvals · Maker-Checker"
      action={
        <div className="flex flex-wrap items-center gap-2">
          {page && status === "PENDING" && (
            <Badge className={TONE.amber}>
              {integer(page.total)} pending · {money(page.pending_value, currency, true)}
            </Badge>
          )}
          <select aria-label="Approval status filter" value={status} onChange={(e) => setStatus(e.target.value as RequestStatus)} className={select}>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="WITHDRAWN">Withdrawn</option>
          </select>
          <select aria-label="Proposed by filter" value={maker} onChange={(e) => setMaker(e.target.value as "" | "AI" | "USER")} className={select}>
            <option value="">AI and people</option>
            <option value="AI">AI Auto-Healer</option>
            <option value="USER">People</option>
          </select>
          <button onClick={() => setShowPolicy(!showPolicy)} className="rounded-lg border border-ink-600 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-400">
            {showPolicy ? "Hide policy" : "Policy"}
          </button>
        </div>
      }
    >
      {showPolicy && (
        <div className="mb-4">
          <PolicyEditor token={token} canEdit={canEditPolicy} currency={currency} />
        </div>
      )}
      {!canApprove && status === "PENDING" && (
        <p className="mb-3 text-xs text-slate-500">Your role can propose fixes; an owner, admin or auditor approves them.</p>
      )}
      {error && <p className="mb-3 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      {notice && <p className="mb-3 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">{notice}</p>}
      {selectable.length > 0 && (
        <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.request_id)))}
              className="h-4 w-4 accent-emerald-500"
            />
            Select all on this page
          </label>
          <button
            onClick={() => void approveSelected()}
            disabled={selected.size === 0 || busy === "bulk"}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1 font-semibold text-ink-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {busy === "bulk" && <Spinner className="h-3 w-3" />} Approve selected ({selected.size})
          </button>
        </div>
      )}
      {loading && !page ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">
          {status === "PENDING" ? "Nothing is waiting for approval." : `No ${status.toLowerCase()} requests.`}
        </p>
      ) : (
        <ul className={`divide-y divide-ink-700 ${loading ? "opacity-60" : ""}`}>
          {items.map((r) => {
            const open = expanded === r.request_id;
            const canSelect = r.status === "PENDING" && canApprove && !r.is_mine;
            return (
              <li key={r.request_id} className="py-3">
                <div className="flex flex-wrap items-center gap-3">
                  {canSelect ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.source_order_number}`}
                      checked={selected.has(r.request_id)}
                      onChange={() => {
                        const next = new Set(selected);
                        if (next.has(r.request_id)) next.delete(r.request_id);
                        else next.add(r.request_id);
                        setSelected(next);
                      }}
                      className="h-4 w-4 accent-emerald-500"
                    />
                  ) : (
                    <span className="w-4" />
                  )}
                  <button onClick={() => setExpanded(open ? null : r.request_id)} className="min-w-0 flex-1 text-left">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-slate-200">{r.source_order_number}</span>
                      <Badge className={ISSUE_META[r.issue_type].tone}>{ISSUE_META[r.issue_type].label}</Badge>
                      {r.root_cause_category && <span className="text-xs text-slate-400">{humanize(r.root_cause_category)}</span>}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {r.proposed_by_type === "AI" ? "AI Auto-Healer" : r.is_mine ? "You" : r.proposed_by_email} proposed {timeAgo(r.created_at)}
                      {r.maker_note ? ` · “${r.maker_note}”` : ""}
                      {r.decided_by_email ? ` · ${r.status.toLowerCase()} by ${r.decided_by_email === "policy:auto" ? "policy" : r.decided_by_email}` : ""}
                      {r.checker_note ? ` · “${r.checker_note}”` : ""}
                    </p>
                  </button>
                  <span className="tabular text-sm font-medium text-slate-100">{money(r.amount, currency)}</span>
                  {r.status === "PENDING" && (
                    <div className="flex items-center gap-1.5">
                      {r.is_mine ? (
                        <button onClick={() => void act(r, "withdraw")} disabled={busy === r.request_id} className={`${smallButton} border-ink-600 text-slate-300 hover:border-slate-400`}>
                          Withdraw
                        </button>
                      ) : canApprove ? (
                        <>
                          <button onClick={() => void act(r, "approve")} disabled={busy === r.request_id} className={`${smallButton} border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10`}>
                            {busy === r.request_id && <Spinner className="h-3 w-3" />} Approve
                          </button>
                          <button onClick={() => void act(r, "reject")} disabled={busy === r.request_id} className={`${smallButton} border-rose-500/40 text-rose-300 hover:bg-rose-500/10`}>
                            Reject
                          </button>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
                {open && (
                  <div className="mt-3 rounded-xl bg-ink-950/60 p-4">
                    <PanelBoundary title="Proposed fix">
                      <FixPreview fix={r.proposed_fix} currency={currency} />
                    </PanelBoundary>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {page && page.total > limit && (
        <footer className="mt-3 flex items-center justify-end gap-2 text-xs text-slate-500">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} className="rounded-md border border-ink-600 px-2.5 py-1 hover:text-slate-200 disabled:opacity-40">
            Prev
          </button>
          <span className="tabular">
            {Math.floor(offset / limit) + 1} / {Math.ceil(page.total / limit)}
          </span>
          <button disabled={offset + limit >= page.total} onClick={() => setOffset(offset + limit)} className="rounded-md border border-ink-600 px-2.5 py-1 hover:text-slate-200 disabled:opacity-40">
            Next
          </button>
        </footer>
      )}
    </Card>
  );
}

/* ============================================================================
 * Team members
 * ========================================================================== */
const ROLE_GUIDE: Record<Role, string> = {
  OWNER: "Everything, including owners, policy and the team",
  ADMIN: "Manages the team (not owners) and policy; can approve",
  ANALYST: "Uploads files, runs reconciliation, proposes fixes (maker)",
  AUDITOR: "Approves or rejects fixes (checker); can also propose",
  VIEWER: "Read-only access to the dashboard and chat",
};
const ROLES = Object.keys(ROLE_GUIDE) as Role[];

function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint32Array(12);
  window.crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${body}#${(bytes[0] % 90) + 10}`;
}

function timeUntil(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  if (seconds <= 0) return "expired";
  if (seconds < 3600) return `expires in ${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `expires in ${Math.ceil(seconds / 3600)}h`;
  return `expires in ${Math.ceil(seconds / 86400)}d`;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

type Shared =
  | { kind: "password"; name: string; email: string; password: string }
  | { kind: "invite"; email: string; url: string; sent: boolean; error: string | null; expires: string };

function TeamPanel({ token, myRole, myUserId }: { token: string; myRole: Role; myUserId: string | null }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [shared, setShared] = useState<Shared | null>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<"invite" | "password">("invite");
  const [form, setForm] = useState<{ full_name: string; email: string; role: Role; password: string }>({
    full_name: "",
    email: "",
    role: "AUDITOR",
    password: "",
  });
  const [showForm, setShowForm] = useState(false);
  const canManage = myRole === "OWNER" || myRole === "ADMIN";
  const assignable = ROLES.filter((r) => r !== "OWNER" || myRole === "OWNER");

  const load = useCallback(() => {
    api<Member[]>("/api/v1/users", token)
      .then((m) => {
        setMembers(m);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load the team"));
    if (canManage) {
      api<Invite[]>("/api/v1/invites", token)
        .then(setInvites)
        .catch(() => setInvites([]));
    }
  }, [token, canManage]);

  useEffect(load, [load]);

  function showInvite(sent: InviteSent) {
    setCopied(false);
    setShared({ kind: "invite", email: sent.email, url: sent.invite_url, sent: sent.email_sent, error: sent.email_error, expires: sent.expires_at });
  }

  async function addMember(e: FormEvent) {
    e.preventDefault();
    setBusy("add");
    setError(null);
    try {
      if (mode === "invite") {
        const sent = await api<InviteSent>("/api/v1/invites", token, {
          method: "POST",
          body: JSON.stringify({ email: form.email, role: form.role, full_name: form.full_name.trim() || null }),
        });
        showInvite(sent);
      } else {
        const created = await api<Member>("/api/v1/users", token, { method: "POST", body: JSON.stringify(form) });
        setCopied(false);
        setShared({ kind: "password", name: created.full_name, email: created.email, password: form.password });
      }
      setForm({ full_name: "", email: "", role: form.role, password: "" });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the member");
    } finally {
      setBusy(null);
    }
  }

  async function run(id: string, action: () => Promise<void>, failure: string) {
    setBusy(id);
    setError(null);
    try {
      await action();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(null);
    }
  }

  const changeRole = (m: Member, role: Role) =>
    run(m.user_id, () => api<Member>(`/api/v1/users/${m.user_id}`, token, { method: "PATCH", body: JSON.stringify({ role }) }).then(() => undefined), "Could not change the role");

  const resetPassword = (m: Member) => {
    if (!window.confirm(`Set a new temporary password for ${m.full_name}? They are signed out and must choose their own password at next sign-in.`)) return;
    const password = generatePassword();
    void run(
      m.user_id,
      async () => {
        await api<Member>(`/api/v1/users/${m.user_id}`, token, { method: "PATCH", body: JSON.stringify({ password }) });
        setCopied(false);
        setShared({ kind: "password", name: m.full_name, email: m.email, password });
      },
      "Could not reset the password",
    );
  };

  const remove = (m: Member) => {
    if (!window.confirm(`Remove ${m.full_name} (${m.email})? They lose access immediately; their approval history stays.`)) return;
    void run(m.user_id, () => api<void>(`/api/v1/users/${m.user_id}`, token, { method: "DELETE" }), "Could not remove the member");
  };

  const resend = (i: Invite) =>
    run(i.invite_id, async () => showInvite(await api<InviteSent>(`/api/v1/invites/${i.invite_id}/resend`, token, { method: "POST" })), "Could not resend the invite");

  const revoke = (i: Invite) => {
    if (!window.confirm(`Revoke the invitation for ${i.email}? The link stops working.`)) return;
    void run(i.invite_id, () => api<void>(`/api/v1/invites/${i.invite_id}`, token, { method: "DELETE" }), "Could not revoke the invite");
  };

  async function copyShared() {
    if (!shared) return;
    const value =
      shared.kind === "password"
        ? `AuditX sign-in\nEmail: ${shared.email}\nTemporary password: ${shared.password}\nYou will be asked to choose your own password.`
        : shared.url;
    setCopied(await copyText(value));
  }

  const input = "rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-emerald-500";
  const smallButton = "rounded-md border border-ink-600 px-2 py-0.5 text-[11px] text-slate-300 hover:border-slate-400 disabled:opacity-50";
  const tab = (active: boolean) => `rounded-md px-2.5 py-1 ${active ? "bg-ink-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`;

  return (
    <Card
      title="Team"
      action={
        canManage ? (
          <button onClick={() => setShowForm(!showForm)} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-emerald-400">
            {showForm ? "Cancel" : "Add member"}
          </button>
        ) : undefined
      }
    >
      {error && <p className="mb-3 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      {shared && (
        <div
          className={`mb-4 rounded-xl border p-3 text-xs ${
            shared.kind === "invite" && !shared.sent ? "border-amber-500/40 bg-amber-500/10 text-amber-100" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
          }`}
        >
          {shared.kind === "password" ? (
            <>
              <p className="font-semibold">Share these sign-in details with {shared.name} privately. This password is shown only once.</p>
              <p className="mt-1.5 font-mono">
                {shared.email} · {shared.password}
              </p>
              <p className="mt-1 opacity-80">They will be asked to choose their own password when they sign in.</p>
            </>
          ) : (
            <>
              <p className="font-semibold">
                {shared.sent ? `Invitation emailed to ${shared.email}.` : `The invitation for ${shared.email} was created but not emailed.`}
              </p>
              {!shared.sent && shared.error && <p className="mt-1 opacity-90">{shared.error}</p>}
              <p className="mt-1.5 break-all font-mono opacity-90">{shared.url}</p>
              <p className="mt-1 opacity-80">The link works once and {timeUntil(shared.expires)}. Anyone with it can join, so share it only with {shared.email}.</p>
            </>
          )}
          <div className="mt-2 flex gap-2">
            <button onClick={() => void copyShared()} className="rounded-md border border-current/40 px-2 py-0.5 hover:bg-white/5">
              {copied ? "Copied" : shared.kind === "invite" ? "Copy link" : "Copy"}
            </button>
            <button onClick={() => setShared(null)} className="rounded-md border border-current/40 px-2 py-0.5 hover:bg-white/5">
              Done
            </button>
          </div>
        </div>
      )}
      {showForm && canManage && (
        <form onSubmit={addMember} className="mb-4 rounded-xl border border-ink-700 bg-ink-850/60 p-4 text-xs">
          <div className="mb-3 inline-flex rounded-lg border border-ink-600 p-0.5">
            <button type="button" onClick={() => setMode("invite")} className={tab(mode === "invite")}>
              Send email invite
            </button>
            <button type="button" onClick={() => setMode("password")} className={tab(mode === "password")}>
              Set a temporary password
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-slate-400">Full name{mode === "invite" ? " (optional)" : ""}</span>
              <input required={mode === "password"} minLength={2} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className={input} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-400">Work email</span>
              <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={input} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-400">Role</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} className={input}>
                {assignable.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-slate-500">{ROLE_GUIDE[form.role]}</span>
            </label>
            {mode === "password" ? (
              <label className="flex flex-col gap-1">
                <span className="text-slate-400">Temporary password ({MIN_PASSWORD_LENGTH}+ characters)</span>
                <div className="flex gap-2">
                  <input required minLength={MIN_PASSWORD_LENGTH} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={`${input} flex-1 font-mono`} />
                  <button type="button" onClick={() => setForm({ ...form, password: generatePassword() })} className="rounded-lg border border-ink-600 px-2.5 text-slate-300 hover:border-slate-400">
                    Generate
                  </button>
                </div>
                <span className="text-[11px] text-slate-500">They must replace it with their own password at first sign-in.</span>
              </label>
            ) : (
              <p className="self-end text-[11px] leading-relaxed text-slate-500">
                They get an email with a one-time link (valid {7} days) to choose their own password and join.
              </p>
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <button type="submit" disabled={busy === "add"} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 font-semibold text-ink-950 hover:bg-emerald-400 disabled:opacity-60">
              {busy === "add" && <Spinner className="h-3 w-3" />} {mode === "invite" ? "Send invite" : "Add to team"}
            </button>
          </div>
        </form>
      )}
      {!members ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-5 pb-2 font-medium">Member</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 font-medium">Added</th>
                <th className="px-5 pb-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700">
              {members.map((m) => {
                const isMe = m.user_id === myUserId;
                const editable = canManage && !isMe && (m.role !== "OWNER" || myRole === "OWNER");
                return (
                  <tr key={m.user_id} className={busy === m.user_id ? "opacity-60" : ""}>
                    <td className="px-5 py-2.5">
                      <p className="text-slate-200">
                        {m.full_name} {isMe && <Badge className={TONE.sky}>You</Badge>}
                      </p>
                      <p className="text-xs text-slate-500">{m.email}</p>
                    </td>
                    <td className="py-2.5">
                      {editable ? (
                        <select
                          aria-label={`Role for ${m.full_name}`}
                          value={m.role}
                          disabled={busy === m.user_id}
                          onChange={(e) => void changeRole(m, e.target.value as Role)}
                          className={input}
                        >
                          {assignable.map((r) => (
                            <option key={r} value={r}>
                              {humanize(r)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-slate-300">{humanize(m.role)}</span>
                      )}
                      <p className="mt-0.5 text-[11px] text-slate-500">{ROLE_GUIDE[m.role]}</p>
                    </td>
                    <td className="py-2.5 text-xs text-slate-500">{timeAgo(m.created_at)}</td>
                    <td className="px-5 py-2.5 text-right">
                      {editable && (
                        <div className="flex justify-end gap-1.5">
                          <button onClick={() => resetPassword(m)} disabled={busy === m.user_id} className={smallButton}>
                            Reset password
                          </button>
                          <button onClick={() => remove(m)} disabled={busy === m.user_id} className={`${smallButton} border-rose-500/40 text-rose-300 hover:bg-rose-500/10`}>
                            Remove
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canManage && invites.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Pending invitations</p>
          <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
            {invites.map((i) => (
              <li key={i.invite_id} className={`flex flex-wrap items-center gap-3 px-4 py-2.5 ${busy === i.invite_id ? "opacity-60" : ""}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200">
                    {i.full_name ? `${i.full_name} · ` : ""}
                    <span className="text-slate-400">{i.email}</span>
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {humanize(i.role)} · invited by {i.invited_by_email ?? "—"} {timeAgo(i.created_at)} ·{" "}
                    {i.send_count > 0 ? `emailed ${i.send_count}×` : "not emailed (link shared by hand)"}
                  </p>
                </div>
                <Badge className={i.status === "EXPIRED" ? TONE.rose : TONE.amber}>{i.status === "EXPIRED" ? "Expired" : timeUntil(i.expires_at)}</Badge>
                {(i.role !== "OWNER" || myRole === "OWNER") && (
                  <div className="flex gap-1.5">
                    <button onClick={() => void resend(i)} disabled={busy === i.invite_id} className={smallButton}>
                      {i.status === "EXPIRED" ? "Send new link" : "Resend"}
                    </button>
                    <button onClick={() => revoke(i)} disabled={busy === i.invite_id} className={`${smallButton} border-rose-500/40 text-rose-300 hover:bg-rose-500/10`}>
                      Revoke
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!canManage && <p className="mt-3 text-xs text-slate-500">Only owners and admins can add or change team members.</p>}
    </Card>
  );
}

/* ============================================================================
 * Password change (forced after a temporary password, or from the header)
 * ========================================================================== */
function PasswordChangeForm({ token, onChanged, onCancel }: { token: string; onChanged: (session: Session) => void; onCancel?: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setError("The new passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<TokenResponse>("/api/v1/me/password", token, {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      onChanged(sessionFromToken(res));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the password");
    } finally {
      setBusy(false);
    }
  }

  const field = "mt-1.5 w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500";
  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
        Current password
        <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
      </label>
      <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
        New password ({MIN_PASSWORD_LENGTH}+ characters)
        <input type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={field} />
      </label>
      <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
        Repeat new password
        <input type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
      </label>
      {error && <p className="rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-slate-300 hover:border-slate-400">
            Cancel
          </button>
        )}
        <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-emerald-400 disabled:opacity-60">
          {busy && <Spinner />} Change password
        </button>
      </div>
      <p className="text-[11px] text-slate-500">Other devices signed in to your account are signed out.</p>
    </form>
  );
}

function ForcedPasswordChange({ session, onChanged, onSignOut }: { session: Session; onChanged: (s: Session) => void; onSignOut: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-7 shadow-2xl shadow-black/50">
        <Logo />
        <h1 className="mt-5 text-lg font-semibold text-slate-100">Choose your own password</h1>
        <p className="mt-1 text-sm text-slate-400">
          You signed in to {session.companyName} with a temporary password. Replace it to continue.
        </p>
        <div className="mt-5">
          <PasswordChangeForm token={session.token} onChanged={onChanged} />
        </div>
        <button onClick={onSignOut} className="mt-4 text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline">
          Sign out
        </button>
      </div>
    </div>
  );
}

function PasswordDialog({ token, onChanged, onClose }: { token: string; onChanged: (s: Session) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true" aria-label="Change password">
      <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-2xl shadow-black/60">
        <h2 className="mb-4 text-base font-semibold text-slate-100">Change password</h2>
        <PasswordChangeForm token={token} onChanged={onChanged} onCancel={onClose} />
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "What is our total open revenue leakage by issue type?",
  "Which findings did the auto-healer resolve and how much value?",
  "Which courier owes us the most COD?",
  "Which payouts never reached the bank?",
  "What is waiting for approval?",
];

function ResultTable({ answer }: { answer: AgentAnswer }) {
  const preview = answer.rows.slice(0, 12);
  if (answer.columns.length === 0) return null;
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-ink-600">
      <table className="w-full text-[11px]">
        <thead className="bg-ink-850 text-slate-400">
          <tr>
            {answer.columns.map((c) => (
              <th key={c} className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.map((row, i) => (
            <tr key={i} className="border-t border-ink-700">
              {answer.columns.map((c) => (
                <td key={c} className="tabular whitespace-nowrap px-2.5 py-1 text-slate-200">
                  {cell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(answer.row_count > preview.length || answer.truncated) && (
        <p className="border-t border-ink-700 px-2.5 py-1 text-[10px] text-slate-500">
          Showing {preview.length} of {answer.row_count}
          {answer.truncated ? "+" : ""} rows
        </p>
      )}
    </div>
  );
}

function AssistantBubble({ message }: { message: ChatMessage }) {
  const [showSql, setShowSql] = useState(false);
  const a = message.answer;
  return (
    <div className="max-w-full rounded-2xl rounded-tl-sm border border-ink-600 bg-ink-850 px-3.5 py-2.5 text-sm text-slate-200">
      <p className="whitespace-pre-wrap leading-relaxed">{message.text}</p>
      {a && (
        <>
          <ResultTable answer={a} />
          <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-slate-500">
            <button onClick={() => setShowSql(!showSql)} className="font-mono text-emerald-400 hover:text-emerald-300">
              {showSql ? "hide SQL" : "view SQL"}
            </button>
            <span>
              {a.engine} · {a.elapsed_ms} ms · read-only · tenant-scoped
            </span>
          </div>
          {showSql && <pre className="mt-2 overflow-x-auto rounded-lg bg-ink-950 p-2.5 font-mono text-[11px] leading-relaxed text-sky-200">{a.sql}</pre>}
        </>
      )}
    </div>
  );
}

function ForensicChat({ token }: { token: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "I'm the AuditX Forensic Agent. Ask me anything about your ledger — every answer is compiled to a read-only, tenant-isolated SQL query you can inspect.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (q.length < 3 || busy) return;
      setInput("");
      setBusy(true);
      setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", text: q }]);
      try {
        const answer = await api<AgentAnswer>("/api/v1/agent/query", token, {
          method: "POST",
          body: JSON.stringify({ question: q }),
        });
        setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", text: answer.narrative || answer.explanation, answer }]);
      } catch (e) {
        setMessages((m) => [...m, { id: `e-${Date.now()}`, role: "error", text: e instanceof Error ? e.message : "Agent request failed" }]);
      } finally {
        setBusy(false);
      }
    },
    [busy, token],
  );

  return (
    <Card title="Chat with your Ledger" className="h-[640px]" action={<Badge className="text-emerald-300 bg-emerald-500/10 ring-emerald-500/30">Forensic Agent</Badge>}>
      <div className="flex h-full flex-col">
        <div ref={scroller} className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1 pb-2">
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-tr-sm bg-emerald-500/15 px-3.5 py-2 text-sm text-emerald-100 ring-1 ring-inset ring-emerald-500/30">{m.text}</p>
              </div>
            ) : m.role === "error" ? (
              <p key={m.id} className="rounded-xl bg-rose-500/10 px-3.5 py-2 text-sm text-rose-300 ring-1 ring-inset ring-rose-500/30">
                {m.text}
              </p>
            ) : (
              <PanelBoundary key={m.id} title="Agent answer">
                <AssistantBubble message={m} />
              </PanelBoundary>
            ),
          )}
          {busy && (
            <div className="inline-flex items-center gap-2 rounded-2xl rounded-tl-sm border border-ink-600 bg-ink-850 px-3.5 py-2.5 text-xs text-slate-400">
              <TypingDots /> Compiling forensic query…
            </div>
          )}
        </div>
        {messages.length <= 1 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => void ask(s)} className="rounded-full border border-ink-600 px-2.5 py-1 text-[11px] text-slate-400 hover:border-emerald-500 hover:text-emerald-300">
                {s}
              </button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
          className="flex gap-2 border-t border-ink-700 pt-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            aria-label="Question for the forensic agent"
            placeholder="e.g. Which orders over $500 have no payment?"
            className="flex-1 rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-500 disabled:opacity-60"
          />
          <button type="submit" disabled={busy || input.trim().length < 3} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-ink-950 hover:bg-emerald-400 disabled:opacity-50">
            {busy ? <Spinner /> : "Ask"}
          </button>
        </form>
      </div>
    </Card>
  );
}

/* ============================================================================
 * Job controls (reconciliation + ingestion)
 * ========================================================================== */
function JobBar({ token, canWrite, onCompleted }: { token: string; canWrite: boolean; onCompleted: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<IngestTarget>("ecom_orders");
  const fileInput = useRef<HTMLInputElement>(null);

  async function track(accepted: JobAccepted, label: string) {
    setBusy(label);
    try {
      const done = await waitForJob(token, accepted.job_id, setJob);
      if (done.status === "FAILED") setError(done.error ?? `${label} failed`);
      onCompleted();
    } finally {
      setBusy(null);
    }
  }

  async function runReconciliation() {
    setError(null);
    try {
      const accepted = await api<JobAccepted>("/api/v1/reconciliation/run", token, {
        method: "POST",
        body: JSON.stringify({ auto_heal: true }),
      });
      await track(accepted, "Reconciliation");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reconciliation failed");
      setBusy(null);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    const form = new FormData();
    form.append("file", file);
    try {
      setBusy("Uploading");
      const accepted = await api<JobAccepted>(`/api/v1/ingest/${target}`, token, { method: "POST", body: form });
      await track(accepted, UPLOAD_TARGETS.find((t) => t.value === target)?.job ?? "Ingestion");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setBusy(null);
    }
  }

  const button = "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex flex-col items-start gap-2 md:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileInput} type="file" accept=".csv,.tsv,.txt" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        <select
          aria-label="File type to upload"
          value={target}
          disabled={!canWrite || !!busy}
          onChange={(e) => setTarget(e.target.value as IngestTarget)}
          className="rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-emerald-500 disabled:opacity-50"
        >
          {UPLOAD_TARGETS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button disabled={!canWrite || !!busy} onClick={() => fileInput.current?.click()} className={`${button} border border-ink-600 text-slate-300 hover:border-slate-400`}>
          Upload file
        </button>
        <button disabled={!canWrite || !!busy} onClick={() => void runReconciliation()} className={`${button} bg-emerald-500 text-ink-950 hover:bg-emerald-400`}>
          {busy ? <Spinner /> : null}
          {busy ? `${busy}…` : "Run reconciliation + auto-heal"}
        </button>
      </div>
      {job && busy && (
        <p className="text-[11px] text-slate-500">
          Job {job.job_id.slice(0, 8)} · <span className="text-sky-300">{job.status}</span>
        </p>
      )}
      {error && <p className="max-w-md rounded-md bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-300">{error}</p>}
    </div>
  );
}

/* ============================================================================
 * Page
 * ========================================================================== */
export default function DashboardPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setSession(loadSession());
    setHydrated(true);
  }, []);

  const logout = useCallback(() => {
    saveSession(null);
    setSession(null);
    setMetrics(null);
  }, []);

  useEffect(() => {
    if (!session || session.mustChangePassword) return;
    let cancelled = false;
    setLoading(true);
    api<DashboardMetrics>("/api/v1/dashboard/metrics", session.token)
      .then((m) => {
        if (!cancelled) {
          setMetrics(m);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) logout();
        else setError(e instanceof Error ? e.message : "Failed to load metrics");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, refreshKey, logout]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [passwordDialog, setPasswordDialog] = useState(false);

  // The server decides roles; pick up a role change (or removal) made since this browser signed in.
  useEffect(() => {
    if (!session) return;
    api<MeResponse>("/api/v1/me", session.token)
      .then((me) => {
        setMyUserId(me.user.user_id);
        if (me.user.role !== session.role || me.user.must_change_password !== !!session.mustChangePassword) {
          const next = { ...session, role: me.user.role, mustChangePassword: me.user.must_change_password };
          saveSession(next);
          setSession(next);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) logout();
      });
  }, [session, logout]);
  const canWrite = useMemo(() => !!session && ["OWNER", "ADMIN", "ANALYST"].includes(session.role), [session]);
  const canResolve = useMemo(() => canWrite || session?.role === "AUDITOR", [canWrite, session]);
  const canApprove = useMemo(() => !!session && ["OWNER", "ADMIN", "AUDITOR"].includes(session.role), [session]);
  const canEditPolicy = useMemo(() => !!session && ["OWNER", "ADMIN"].includes(session.role), [session]);

  if (!hydrated) return null;
  if (session?.mustChangePassword) {
    return (
      <ForcedPasswordChange
        session={session}
        onChanged={(s) => {
          saveSession(s);
          setSession(s);
        }}
        onSignOut={logout}
      />
    );
  }

  if (!session) {
    return (
      <LoginGate
        onAuthenticated={(s) => {
          saveSession(s);
          setSession(s);
        }}
      />
    );
  }

  const currency = metrics?.brand_currency ?? "USD";

  return (
    <main className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      {passwordDialog && (
        <PasswordDialog
          token={session.token}
          onClose={() => setPasswordDialog(false)}
          onChanged={(s) => {
            saveSession(s);
            setSession(s);
            setPasswordDialog(false);
          }}
        />
      )}
      <header className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div className="flex items-center gap-5">
          <Logo />
          <div className="hidden h-8 w-px bg-ink-700 md:block" />
          <div>
            <p className="text-sm font-medium text-slate-200">{metrics?.company_name ?? session.companyName}</p>
            <p className="text-[11px] text-slate-500">
              Last reconciliation {timeAgo(metrics?.last_reconciliation_at ?? null)} · {session.role}
              <a href="#team" className="ml-3 text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline">
                Team
              </a>
              <button onClick={() => setPasswordDialog(true)} className="ml-3 text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline">
                Change password
              </button>
              <button onClick={logout} className="ml-3 text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline">
                Sign out
              </button>
            </p>
          </div>
        </div>
        <JobBar token={session.token} canWrite={canWrite} onCompleted={refresh} />
      </header>

      {error && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
          <span>{error}</span>
          <button onClick={refresh} className="rounded-md border border-rose-400/40 px-2.5 py-1 text-xs hover:bg-rose-500/10">
            Retry
          </button>
        </div>
      )}

      <PanelBoundary title="Metrics">
        <MetricsRow metrics={metrics} loading={loading && !metrics} />
      </PanelBoundary>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <div className="grid gap-4 lg:grid-cols-2">
            <PanelBoundary title="Leak state">
              <LeakageBreakdown metrics={metrics} loading={loading && !metrics} />
            </PanelBoundary>
            <PanelBoundary title="Root causes">
              <RootCausePanel metrics={metrics} loading={loading && !metrics} />
            </PanelBoundary>
          </div>
          <PanelBoundary title="Courier ledger">
            <CourierLedger metrics={metrics} loading={loading && !metrics} />
          </PanelBoundary>
          <PanelBoundary title="Recovery">
            <RecoveryPanel token={session.token} refreshKey={refreshKey} canWrite={canWrite} onChanged={refresh} />
          </PanelBoundary>
          <PanelBoundary title="Approvals">
            <ApprovalsInbox
              token={session.token}
              currency={currency}
              refreshKey={refreshKey}
              canApprove={canApprove}
              canEditPolicy={canEditPolicy}
              onChanged={refresh}
            />
          </PanelBoundary>
          <PanelBoundary title="Tracking matrix">
            <TrackingMatrix token={session.token} currency={currency} refreshKey={refreshKey} canResolve={canResolve} onChanged={refresh} />
          </PanelBoundary>
          <PanelBoundary title="Team">
            <div id="team" className="scroll-mt-6" />
            <TeamPanel token={session.token} myRole={session.role as Role} myUserId={myUserId} />
          </PanelBoundary>
        </div>
        <div className="xl:sticky xl:top-6 xl:self-start">
          <PanelBoundary title="Forensic chat">
            <ForensicChat token={session.token} />
          </PanelBoundary>
        </div>
      </div>
    </main>
  );
}
