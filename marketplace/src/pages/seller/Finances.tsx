import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../useApi.ts';
import { api } from '../../api.ts';
import { Button, ErrorNote, Spinner, formatDate } from '../../components/ui.tsx';
import { formatMoney } from '../../../shared/config.ts';

const TYPE_LABEL: Record<string, string> = {
  sale: 'Sale',
  shipping: 'Shipping',
  listing_fee: 'Listing fee',
  transaction_fee: 'Transaction fee',
  processing_fee: 'Processing fee',
  ad_fee: 'Ads',
  refund: 'Refund',
  payout: 'Payout',
};

export default function Finances() {
  const { data, reload } = useApi('/seller/finances');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string>();
  if (!data) return <Spinner />;
  const rows = data.entries.filter((e: any) => !filter || e.type === filter);
  return (
    <div className="space-y-6">
      <h1 className="font-serif text-3xl">Finances</h1>
      <div className="card flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <p className="text-sm text-neutral-600">Current balance</p>
          <p className={`text-3xl font-bold ${data.balance < 0 ? 'text-red-700' : ''}`}>{formatMoney(data.balance)}</p>
          {data.balance < 0 && <p className="text-xs text-red-700">Fees owed will be deducted from your next sale.</p>}
        </div>
        <Button disabled={data.balance <= 0} onClick={async () => { setError(undefined); try { await api('/seller/finances/payout', { body: {} }); reload(); } catch (e) { setError((e as Error).message); } }}>Request payout</Button>
      </div>
      <ErrorNote message={error} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          ['Sales & shipping', data.totals.sales],
          ['Fees', data.totals.fees],
          ['Refunds', data.totals.refunds],
          ['Paid out', data.totals.payouts],
        ].map(([l, v]) => (
          <div key={l} className="card p-4"><p className="text-xs text-neutral-500">{l}</p><p className="mt-1 text-xl font-bold">{formatMoney(v)}</p></div>
        ))}
      </div>
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Payment account activity</h2>
          <select className="input w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All activity</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50"><tr><th className="p-3">Date</th><th>Type</th><th>Description</th><th className="p-3 text-right">Amount</th></tr></thead>
            <tbody>
              {rows.map((e: any) => (
                <tr key={e.id} className="border-t">
                  <td className="whitespace-nowrap p-3">{formatDate(e.createdAt)}</td>
                  <td className="whitespace-nowrap">{TYPE_LABEL[e.type]}</td>
                  <td>{e.orderId ? <Link to={`/seller/orders/${e.orderId}`} className="hover:underline">{e.description}</Link> : e.description}</td>
                  <td className={`whitespace-nowrap p-3 text-right font-medium ${e.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>{e.amount < 0 ? '−' : '+'}{formatMoney(Math.abs(e.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
