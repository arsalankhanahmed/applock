"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Logo, Spinner } from "../components/brand";
import { MIN_PASSWORD_LENGTH, api, saveSession, sessionFromToken, type TokenResponse } from "../lib/client";

interface InvitePublic {
  email: string;
  full_name: string | null;
  role: string;
  company_name: string;
  invited_by_email: string | null;
  expires_at: string;
}

const ROLE_DUTY: Record<string, string> = {
  OWNER: "full control of the workspace",
  ADMIN: "managing the team and approval policy, and approving fixes",
  ANALYST: "uploading files, running reconciliation and proposing fixes",
  AUDITOR: "approving or rejecting proposed fixes",
  VIEWER: "read-only access to the dashboard",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-7 shadow-2xl shadow-black/50">
        <Logo />
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}

function AcceptInvite() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [invite, setInvite] = useState<InvitePublic | null>(null);
  const [problem, setProblem] = useState<string | null>(token ? null : "This page needs the link from your invitation email.");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api<InvitePublic>(`/api/v1/invites/token/${encodeURIComponent(token)}`, null)
      .then((i) => {
        setInvite(i);
        setName(i.full_name ?? "");
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : "This invitation link is not valid."));
  }, [token]);

  async function accept(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<TokenResponse>(`/api/v1/invites/token/${encodeURIComponent(token)}/accept`, null, {
        method: "POST",
        body: JSON.stringify({ full_name: name.trim(), password }),
      });
      saveSession(sessionFromToken(res));
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the invitation");
      setBusy(false);
    }
  }

  if (problem) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-slate-100">Invitation unavailable</h1>
        <p className="mt-2 text-sm text-slate-400">{problem}</p>
        <a href="/dashboard" className="mt-5 inline-block text-sm text-emerald-400 hover:text-emerald-300">
          Go to sign in
        </a>
      </Shell>
    );
  }

  if (!invite) {
    return (
      <Shell>
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <Spinner /> Checking your invitation…
        </p>
      </Shell>
    );
  }

  const field = "mt-1.5 w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500";
  return (
    <Shell>
      <h1 className="text-lg font-semibold text-slate-100">Join {invite.company_name}</h1>
      <p className="mt-1 text-sm text-slate-400">
        {invite.invited_by_email ? `${invite.invited_by_email} invited you` : "You were invited"} as{" "}
        <span className="text-slate-200">{invite.role.charAt(0) + invite.role.slice(1).toLowerCase()}</span>
        {ROLE_DUTY[invite.role] ? ` (${ROLE_DUTY[invite.role]})` : ""}.
      </p>
      <form onSubmit={accept} className="mt-5 space-y-4">
        <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
          Work email
          <input value={invite.email} disabled className={`${field} opacity-70`} />
        </label>
        <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
          Full name
          <input required minLength={2} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
          Choose a password ({MIN_PASSWORD_LENGTH}+ characters)
          <input type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        </label>
        <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
          Repeat password
          <input type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
        </label>
        {error && <p className="rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
        <button type="submit" disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-emerald-400 disabled:opacity-60">
          {busy && <Spinner />} Join and sign in
        </button>
      </form>
      <p className="mt-4 text-[11px] text-slate-500">This link works once and expires on {new Date(invite.expires_at).toLocaleDateString()}.</p>
    </Shell>
  );
}

export default function InvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInvite />
    </Suspense>
  );
}
