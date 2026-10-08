import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Award, Plus } from 'lucide-react';
import { useApi } from '../../useApi.ts';
import { Spinner } from '../../components/ui.tsx';
import { STAR_SELLER, formatMoney } from '../../../shared/config.ts';

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const { data } = useApi(`/seller/stats?days=${days}`);
  if (!data) return <Spinner />;
  const max = Math.max(1, ...data.daily.map((d: any) => d.revenue));
  const tile = (label: string, value: string | number) => (
    <div className="card p-4"><p className="text-xs text-neutral-500">{label}</p><p className="mt-1 text-2xl font-bold">{value}</p></div>
  );
  const criteria = [
    ['Rating', data.reviewCount ? `${data.rating} / 5` : '—', data.rating >= STAR_SELLER.minRating],
    ['On-time shipping with tracking', `${Math.round(data.onTimeShippingRate * 100)}%`, data.onTimeShippingRate >= STAR_SELLER.minOnTimeShippingRate],
    [`Orders (min ${STAR_SELLER.minOrders})`, data.orderCount, data.orderCount >= STAR_SELLER.minOrders],
  ] as const;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-3xl">Dashboard</h1>
        <div className="flex gap-2">
          <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
          <Link to="/seller/listings/new" className="inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-neutral-900 px-4 py-2 text-sm font-semibold text-white"><Plus className="h-4 w-4" /> Add listing</Link>
        </div>
      </div>
      {data.lateOrders > 0 && (
        <Link to="/seller/orders?status=paid" className="flex items-center gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4" /> {data.lateOrders} order{data.lateOrders > 1 ? 's are' : ' is'} past the ship-by date. Ship now to protect your Star Seller status.
        </Link>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tile('Revenue', formatMoney(data.revenue))}
        {tile('Orders', data.orders)}
        {tile('Total listing views', data.views.toLocaleString())}
        {tile('Conversion rate', `${(data.conversionRate * 100).toFixed(1)}%`)}
        {tile('Orders to ship', data.openOrders)}
        {tile('Active listings', data.activeListings)}
        {tile('Shop favorites', data.favorites)}
        {tile('Ad spend', formatMoney(data.adSpend))}
      </div>
      <div className="card p-5">
        <p className="mb-4 text-sm font-semibold">Revenue per day</p>
        <div className="flex h-40 items-end gap-[2px]">
          {data.daily.map((d: any) => (
            <div key={d.date} className="group relative flex-1">
              <div className="w-full rounded-t bg-brand-500/80 hover:bg-brand-600" style={{ height: `${Math.max(2, (d.revenue / max) * 150)}px` }} />
              <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-neutral-900 px-2 py-1 text-xs text-white group-hover:block">
                {d.date}: {formatMoney(d.revenue)} · {d.orders} orders
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card p-5">
          <p className="mb-3 flex items-center gap-2 text-sm font-semibold"><Award className="h-4 w-4 text-purple-700" /> Star Seller {data.starSeller ? '— you’re a Star Seller!' : 'progress'}</p>
          {criteria.map(([label, value, ok]) => (
            <div key={label} className="flex justify-between border-b py-2 text-sm last:border-0">
              <span>{label}</span>
              <span className={ok ? 'font-semibold text-green-700' : 'text-neutral-600'}>{value} {ok ? '✓' : ''}</span>
            </div>
          ))}
        </div>
        <div className="card p-5">
          <p className="mb-3 text-sm font-semibold">Top listings</p>
          {data.topListings.map((l: any) => (
            <Link key={l.id} to={`/seller/listings/${l.id}`} className="flex items-center gap-3 border-b py-2 text-sm last:border-0 hover:bg-neutral-50">
              {l.image && <img src={l.image} className="h-10 w-10 rounded object-cover" alt="" />}
              <span className="line-clamp-1 flex-1">{l.title}</span>
              <span className="whitespace-nowrap text-xs text-neutral-500">{l.sold} sold · {l.views} views · {l.favorites} ♥</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
