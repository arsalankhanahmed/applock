import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../useApi.ts';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';
import { Page } from '../components/Layout.tsx';
import { Button, Empty, Spinner, StatusPill, formatDate } from '../components/ui.tsx';
import { formatMoney } from '../../shared/config.ts';

const FEE_LABELS: Record<string, string> = {
  listing_fee: 'Listing fees',
  transaction_fee: 'Transaction fees',
  processing_fee: 'Payment processing',
  ad_fee: 'Ads',
};

export default function AdminPage() {
  const { user } = useSession();
  const [tab, setTab] = useState<'reports' | 'users'>('reports');
  const isAdmin = user?.role === 'admin';
  const overview = useApi(isAdmin ? '/admin/overview' : null);
  const reports = useApi<any[]>(isAdmin ? '/admin/reports' : null);
  const users = useApi<any[]>(isAdmin && tab === 'users' ? '/admin/users' : null);
  if (!isAdmin) return <Page><Empty title="Admins only" /></Page>;
  if (!overview.data) return <Spinner />;
  const o = overview.data;
  const stat = (label: string, value: string | number) => (
    <div className="card p-4"><p className="text-xs text-neutral-500">{label}</p><p className="mt-1 text-2xl font-bold">{value}</p></div>
  );
  return (
    <Page>
      <h1 className="mb-6 font-serif text-3xl">Marketplace admin</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stat('Marketplace revenue', formatMoney(o.revenue))}
        {stat('Gross merchandise sales', formatMoney(o.gmv))}
        {stat('Orders', o.orders)}
        {stat('Active listings', o.activeListings)}
        {stat('Members', o.users)}
        {stat('Shops', o.shops)}
        {stat('Open reports', o.openReports)}
      </div>
      <div className="card mt-6 p-4">
        <p className="mb-2 text-sm font-semibold">Revenue by fee type</p>
        {Object.entries(o.revenueByType as Record<string, number>).map(([k, v]) => (
          <div key={k} className="flex justify-between border-b py-1.5 text-sm last:border-0"><span>{FEE_LABELS[k] ?? k}</span><span>{formatMoney(v)}</span></div>
        ))}
      </div>
      <div className="mb-4 mt-10 flex gap-6 border-b">
        {(['reports', 'users'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`border-b-2 pb-2 font-semibold capitalize ${tab === t ? 'border-neutral-900' : 'border-transparent text-neutral-500'}`}>{t}</button>
        ))}
      </div>
      {tab === 'reports' &&
        (reports.data?.length ? (
          <div className="space-y-3">
            {reports.data.map((r) => (
              <div key={r.id} className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                <div>
                  <p><StatusPill status={r.status} /> <span className="ml-2 font-semibold capitalize">{r.targetType}</span>: {r.target ? <Link to={r.target.link} className="underline">{r.target.label}</Link> : 'deleted'}</p>
                  <p className="mt-1 text-neutral-600">“{r.reason}” — reported by {r.reporterName} on {formatDate(r.createdAt)}</p>
                </div>
                {r.status === 'open' && (
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={async () => { await api(`/admin/reports/${r.id}`, { body: { action: 'dismiss' } }); reports.reload(); overview.reload(); }}>Dismiss</Button>
                    <Button variant="danger" onClick={async () => { await api(`/admin/reports/${r.id}`, { body: { action: 'remove' } }); reports.reload(); overview.reload(); }}>Take down</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No reports" />
        ))}
      {tab === 'users' && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b"><th className="py-2">Name</th><th>Email</th><th>Shop</th><th>Joined</th><th></th></tr></thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id} className="border-b">
                  <td className="py-2">{u.name} {u.role === 'admin' && <span className="text-xs text-brand-600">(admin)</span>}</td>
                  <td>{u.email}</td>
                  <td>{u.shop ? <Link to={`/shop/${u.shop.slug}`} className="underline">{u.shop.name}</Link> : '—'}</td>
                  <td>{formatDate(u.createdAt)}</td>
                  <td className="text-right">
                    {u.id !== user.id && (
                      <button className={`text-xs font-semibold underline ${u.suspended ? 'text-green-700' : 'text-red-700'}`} onClick={async () => { await api(`/admin/users/${u.id}/suspend`, { body: {} }); users.reload(); }}>
                        {u.suspended ? 'Reinstate' : 'Suspend'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
