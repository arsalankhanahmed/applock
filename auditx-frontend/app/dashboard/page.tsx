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

/* ============================================================================
 * Types — mirror app/models/schemas.py
 * ========================================================================== */
type IssueType = "MISSING_PAYMENT" | "UNTRACKED_REVENUE" | "AMOUNT_MISMATCH";
type DiscrepancyStatus = "UNRESOLVED" | "RESOLVED";
type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
type JobType = "INGEST_ORDERS" | "INGEST_GATEWAY" | "RECONCILIATION";
type Money = string | number;

interface Session {
  token: string;
  companyName: string;
  role: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  org_id: string;
  user_id: string;
  role: string;
  company_name: string;
}

interface IssueBreakdown {
  issue_type: IssueType;
  open_count: number;
  open_exposure: Money;
  resolved_count: number;
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
  by_issue_type: IssueBreakdown[];
  by_root_cause: RootCauseBreakdown[];
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
  evidence?: { events?: GatewayEvent[]; discount_codes_seen?: string[]; source?: string } | null;
  next_steps?: string[];
  manual_resolution?: { note: string; resolved_by: string; resolved_at: string };
  [key: string]: unknown;
}

interface Discrepancy {
  log_id: string;
  source_order_number: string;
  issue_type: IssueType;
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

/* ============================================================================
 * API client
 * ========================================================================== */
const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
const SESSION_KEY = "auditx.session";

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, `Cannot reach the AuditX API at ${API_BASE}`);
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "detail" in body) {
        const d = (body as { detail: unknown }).detail;
        detail = typeof d === "string" ? d : JSON.stringify(d);
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

function loadSession(): Session | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session | null): void {
  try {
    if (session) window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable (private mode) — session lives in memory only */
  }
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
const humanize = (s: string): string => s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

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

const ISSUE_META: Record<IssueType, { label: string; tone: string; bar: string }> = {
  MISSING_PAYMENT: { label: "Missing Payments", tone: "text-rose-300 bg-rose-500/10 ring-rose-500/30", bar: "bg-rose-500" },
  UNTRACKED_REVENUE: { label: "Untracked Revenue", tone: "text-amber-300 bg-amber-500/10 ring-amber-500/30", bar: "bg-amber-400" },
  AMOUNT_MISMATCH: { label: "Amount Mismatch", tone: "text-sky-300 bg-sky-500/10 ring-sky-500/30", bar: "bg-sky-400" },
};

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

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
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
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${className}`}>{children}</span>;
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
      onAuthenticated({ token: res.access_token, companyName: res.company_name, role: res.role });
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
        <label className="mt-6 block text-xs font-medium uppercase tracking-wider text-slate-400">Work email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
        />
        <label className="mt-4 block text-xs font-medium uppercase tracking-wider text-slate-400">Password</label>
        <input
          type="password"
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

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-sky-500 text-sm font-black text-ink-950">X</div>
      <div>
        <p className="text-base font-bold tracking-tight text-slate-100">
          Audit<span className="text-emerald-400">X</span>
        </p>
        <p className="-mt-0.5 text-[10px] uppercase tracking-[0.2em] text-slate-500">Forensic Reconciliation</p>
      </div>
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
        sub={metrics ? `${integer(metrics.auto_healed_count)} resolved by AI` : undefined}
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
        label="Auto-Heal Rate"
        value={metrics ? pct(metrics.auto_heal_rate_pct) : "—"}
        sub={metrics ? `${integer(metrics.manual_resolved_count)} manual resolutions` : undefined}
      />
      <MetricTile
        loading={loading}
        label="Gateway Volume"
        value={money(metrics?.total_gateway_gross, c, true)}
        sub={metrics ? `${integer(metrics.total_gateway_transactions)} captures` : undefined}
      />
      <MetricTile
        loading={loading}
        label="Gateway Fees"
        tone="text-amber-300"
        value={money(metrics?.total_gateway_fees, c, true)}
        sub={metrics && num(metrics.total_gateway_gross) > 0 ? `${((num(metrics.total_gateway_fees) / num(metrics.total_gateway_gross)) * 100).toFixed(2)}% effective rate` : undefined}
      />
    </div>
  );
}

function LeakageBreakdown({ metrics, loading }: { metrics: DashboardMetrics | null; loading: boolean }) {
  const c = metrics?.brand_currency ?? "USD";
  const max = Math.max(1, ...(metrics?.by_issue_type ?? []).map((i) => num(i.open_exposure)));
  return (
    <Card title="Leak State by Channel">
      {loading || !metrics ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : (
        <ul className="space-y-4">
          {metrics.by_issue_type.map((i) => (
            <li key={i.issue_type}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-slate-300">{ISSUE_META[i.issue_type].label}</span>
                <span className="tabular font-medium text-slate-100">{money(i.open_exposure, c)}</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-700">
                <div className={`h-full rounded-full ${ISSUE_META[i.issue_type].bar}`} style={{ width: `${(num(i.open_exposure) / max) * 100}%` }} />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {integer(i.open_count)} open · {integer(i.resolved_count)} resolved
              </p>
            </li>
          ))}
        </ul>
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
function FixPreview({ fix, currency }: { fix: SuggestedFix | null; currency: string }) {
  if (!fix) return <p className="text-xs text-slate-500">No AI analysis attached yet.</p>;
  const events = fix.evidence?.events ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Proposed action</p>
        <p className="font-mono text-sm text-emerald-300">{fix.action ?? "—"}</p>
        {fix.reason && <p className="text-xs leading-relaxed text-slate-400">{fix.reason}</p>}
        {fix.priority && <Badge className="text-amber-300 bg-amber-500/10 ring-amber-500/30">Priority {fix.priority}</Badge>}
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
            Resolved by {fix.manual_resolution.resolved_by}: “{fix.manual_resolution.note}”
          </p>
        )}
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
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Gateway API evidence</p>
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
        ) : (
          <p className="text-xs text-slate-500">No gateway capture exists for this reference.</p>
        )}
      </div>
    </div>
  );
}

function TrackingMatrix({ token, currency, refreshKey, canResolve, onChanged }: { token: string; currency: string; refreshKey: number; canResolve: boolean; onChanged: () => void }) {
  const [status, setStatus] = useState<DiscrepancyStatus | "">("UNRESOLVED");
  const [issue, setIssue] = useState<IssueType | "">("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<DiscrepancyPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const limit = 15;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setOffset(0), [status, issue, debounced]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset), sort: "variance" });
    if (status) params.set("status", status);
    if (issue) params.set("issue_type", issue);
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
  }, [token, status, issue, debounced, offset, refreshKey]);

  async function resolve(d: Discrepancy) {
    const note = window.prompt(`Resolution note for ${d.source_order_number}`, "Verified against bank statement");
    if (!note || note.trim().length < 3) return;
    setResolving(d.log_id);
    try {
      await api(`/api/v1/discrepancies/${d.log_id}/resolve`, token, {
        method: "POST",
        body: JSON.stringify({ resolution_note: note.trim() }),
      });
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
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search order #" className={`${select} w-36`} />
          <select value={status} onChange={(e) => setStatus(e.target.value as DiscrepancyStatus | "")} className={select}>
            <option value="">All statuses</option>
            <option value="UNRESOLVED">Unresolved</option>
            <option value="RESOLVED">Resolved</option>
          </select>
          <select value={issue} onChange={(e) => setIssue(e.target.value as IssueType | "")} className={select}>
            <option value="">All issue types</option>
            {(Object.keys(ISSUE_META) as IssueType[]).map((k) => (
              <option key={k} value={k}>
                {ISSUE_META[k].label}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {error && <p className="mb-3 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th className="px-5 pb-2 font-medium">Order ref</th>
              <th className="pb-2 font-medium">Issue</th>
              <th className="pb-2 text-right font-medium">ERP</th>
              <th className="pb-2 text-right font-medium">Gateway</th>
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
                          {d.status === "RESOLVED" ? (
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
const SUGGESTIONS = [
  "What is our total open revenue leakage by issue type?",
  "Which findings did the auto-healer resolve and how much value?",
  "Show suspicious fraud risk items",
  "What are our monthly gateway fees as a percentage of volume?",
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
  const ordersInput = useRef<HTMLInputElement>(null);
  const gatewayInput = useRef<HTMLInputElement>(null);

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

  async function upload(target: "ecom_orders" | "gateway_transactions", file: File | undefined) {
    if (!file) return;
    setError(null);
    const form = new FormData();
    form.append("file", file);
    try {
      setBusy("Uploading");
      const accepted = await api<JobAccepted>(`/api/v1/ingest/${target}`, token, { method: "POST", body: form });
      await track(accepted, target === "ecom_orders" ? "Order ingestion" : "Gateway ingestion");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setBusy(null);
    }
  }

  const button = "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex flex-col items-start gap-2 md:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={ordersInput} type="file" accept=".csv,.tsv,.txt" hidden onChange={(e) => { void upload("ecom_orders", e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={gatewayInput} type="file" accept=".csv,.tsv,.txt" hidden onChange={(e) => { void upload("gateway_transactions", e.target.files?.[0]); e.target.value = ""; }} />
        <button disabled={!canWrite || !!busy} onClick={() => ordersInput.current?.click()} className={`${button} border border-ink-600 text-slate-300 hover:border-slate-400`}>
          Upload ERP orders
        </button>
        <button disabled={!canWrite || !!busy} onClick={() => gatewayInput.current?.click()} className={`${button} border border-ink-600 text-slate-300 hover:border-slate-400`}>
          Upload gateway file
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
    if (!session) return;
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
  const canWrite = useMemo(() => !!session && ["OWNER", "ADMIN", "ANALYST"].includes(session.role), [session]);
  const canResolve = useMemo(() => canWrite || session?.role === "AUDITOR", [canWrite, session]);

  if (!hydrated) return null;
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
      <header className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div className="flex items-center gap-5">
          <Logo />
          <div className="hidden h-8 w-px bg-ink-700 md:block" />
          <div>
            <p className="text-sm font-medium text-slate-200">{metrics?.company_name ?? session.companyName}</p>
            <p className="text-[11px] text-slate-500">
              Last reconciliation {timeAgo(metrics?.last_reconciliation_at ?? null)} · {session.role}
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
          <PanelBoundary title="Tracking matrix">
            <TrackingMatrix token={session.token} currency={currency} refreshKey={refreshKey} canResolve={canResolve} onChanged={refresh} />
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
