export default function DashboardLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex items-center gap-3 text-sm text-slate-400">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
        Loading AuditX command center…
      </div>
    </div>
  );
}
