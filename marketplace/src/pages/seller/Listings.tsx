import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { useApi } from '../../useApi.ts';
import { api } from '../../api.ts';
import { Empty, ErrorNote, Spinner, StatusPill, formatDate } from '../../components/ui.tsx';
import { formatMoney } from '../../../shared/config.ts';
import type { Listing } from '../../../shared/types.ts';

const TABS = ['active', 'draft', 'sold_out', 'inactive', 'expired'] as const;

export default function Listings() {
  const { data, reload } = useApi<(Listing & { favorites: number })[]>('/seller/listings');
  const [tab, setTab] = useState<(typeof TABS)[number]>('active');
  const [error, setError] = useState<string>();
  const navigate = useNavigate();
  if (!data) return <Spinner />;
  const rows = data.filter((l) => l.status === tab);
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-serif text-3xl">Listings</h1>
        <Link to="/seller/listings/new" className="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-4 py-2 text-sm font-semibold text-white"><Plus className="h-4 w-4" /> Add a listing</Link>
      </div>
      <div className="no-scrollbar mb-4 flex gap-4 overflow-x-auto border-b text-sm">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`whitespace-nowrap border-b-2 pb-2 font-semibold capitalize ${tab === t ? 'border-neutral-900' : 'border-transparent text-neutral-500'}`}>
            {t.replace('_', ' ')} ({data.filter((l) => l.status === t).length})
          </button>
        ))}
      </div>
      <ErrorNote message={error} />
      {rows.length === 0 ? (
        <Empty title={`No ${tab.replace('_', ' ')} listings`} />
      ) : (
        <div className="divide-y rounded-xl border">
          {rows.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-4 p-3">
              <img src={l.images[0] ?? ''} alt="" className="h-16 w-16 rounded-lg bg-neutral-100 object-cover" />
              <div className="min-w-0 flex-1">
                <Link to={`/seller/listings/${l.id}`} className="line-clamp-1 font-medium hover:underline">{l.title}</Link>
                <p className="text-xs text-neutral-600">
                  {formatMoney(l.price)} · {l.quantity} in stock · {l.views} views · {l.favorites} favorites
                  {l.promoted && ' · 📣 Promoted'}
                </p>
                <p className="text-xs text-neutral-500">{l.expiresAt ? `${l.status === 'expired' ? 'Expired' : 'Expires'} ${formatDate(l.expiresAt)}` : `Created ${formatDate(l.createdAt)}`} {l.autoRenew ? '· Auto-renews' : ''}</p>
              </div>
              <StatusPill status={l.status} />
              <div className="flex items-center gap-1">
                {l.status === 'active' && <button className="rounded-full px-3 py-1 text-xs font-semibold hover:bg-neutral-100" onClick={() => act(() => api(`/seller/listings/${l.id}/status`, { body: { action: 'deactivate' } }))}>Deactivate</button>}
                {l.status === 'inactive' && <button className="rounded-full px-3 py-1 text-xs font-semibold hover:bg-neutral-100" onClick={() => act(() => api(`/seller/listings/${l.id}/status`, { body: { action: 'activate' } }))}>Activate</button>}
                {(l.status === 'expired' || l.status === 'active') && <button className="rounded-full px-3 py-1 text-xs font-semibold hover:bg-neutral-100" title="Charges a listing fee" onClick={() => act(() => api(`/seller/listings/${l.id}/status`, { body: { action: 'renew' } }))}>Renew</button>}
                <button className="rounded-full p-2 hover:bg-neutral-100" aria-label="Edit" onClick={() => navigate(`/seller/listings/${l.id}`)}><Pencil className="h-4 w-4" /></button>
                <button className="rounded-full p-2 hover:bg-neutral-100" aria-label="Copy" onClick={() => act(() => api(`/seller/listings/${l.id}/copy`, { body: {} }))}><Copy className="h-4 w-4" /></button>
                <button className="rounded-full p-2 hover:bg-neutral-100" aria-label="Delete" onClick={() => confirm('Delete this listing?') && act(() => api(`/seller/listings/${l.id}`, { method: 'DELETE' }))}><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
