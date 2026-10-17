/* Brand mark and loading spinner shared by the dashboard and the invite page. */

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
}

export function Logo() {
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
