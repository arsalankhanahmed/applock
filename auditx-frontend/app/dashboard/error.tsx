"use client";

import { useEffect } from "react";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("AuditX dashboard crashed", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-rose-500/30 bg-ink-900 p-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-rose-400">Dashboard error</p>
        <h1 className="mt-2 text-lg font-semibold text-slate-100">The command center failed to render</h1>
        <p className="mt-2 break-words text-sm text-slate-400">{error.message}</p>
        <button
          onClick={reset}
          className="mt-5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-emerald-400"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
