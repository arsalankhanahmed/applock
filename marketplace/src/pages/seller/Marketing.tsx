import { useState } from 'react';
import { useApi } from '../../useApi.ts';
import { api } from '../../api.ts';
import { Button, ErrorNote, MoneyInput, Spinner, formatDate } from '../../components/ui.tsx';
import { FEES, formatMoney } from '../../../shared/config.ts';
import { describePromotion, isPromotionLive } from '../../../shared/fees.ts';
import type { Promotion } from '../../../shared/types.ts';

export default function Marketing() {
  const promos = useApi<Promotion[]>('/seller/promotions');
  const shop = useApi('/seller/shop');
  const stats = useApi('/seller/stats?days=30');
  const [form, setForm] = useState({ kind: 'sale', code: '', discountType: 'percent', value: 10, minOrder: 0, endsAt: '' });
  const [budget, setBudget] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  if (!promos.data || !shop.data) return <Spinner />;
  const dailyBudget = budget ?? shop.data.shop.adsDailyBudget;

  return (
    <div className="space-y-8">
      <h1 className="font-serif text-3xl">Marketing</h1>

      <section className="card space-y-4 p-6">
        <h2 className="text-lg font-semibold">Sales and coupons</h2>
        <p className="text-sm text-neutral-600">A <b>sale</b> discounts every item automatically and shows the strike-through price in search. A <b>coupon</b> applies when buyers enter the code at checkout — great for repeat customers and social media.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label">Type</label>
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, discountType: e.target.value === 'sale' && form.discountType === 'free_shipping' ? 'percent' : form.discountType })}>
              <option value="sale">Shop-wide sale</option>
              <option value="coupon">Coupon code</option>
            </select>
          </div>
          <div>
            <label className="label">Discount</label>
            <select className="input" value={form.discountType} onChange={(e) => setForm({ ...form, discountType: e.target.value })}>
              <option value="percent">Percentage off</option>
              <option value="fixed">Fixed amount off</option>
              {form.kind === 'coupon' && <option value="free_shipping">Free shipping</option>}
            </select>
          </div>
          {form.discountType === 'percent' && <div><label className="label">Percent (1–75)</label><input type="number" min={1} max={75} className="input" value={form.value} onChange={(e) => setForm({ ...form, value: Number(e.target.value) })} /></div>}
          {form.discountType === 'fixed' && <div><label className="label">Amount ($)</label><MoneyInput value={form.value} onChange={(value) => setForm({ ...form, value })} /></div>}
          {form.kind === 'coupon' && <div><label className="label">Code</label><input className="input uppercase" maxLength={20} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>}
          <div><label className="label">Minimum order ($)</label><MoneyInput value={form.minOrder} onChange={(minOrder) => setForm({ ...form, minOrder })} /></div>
          <div><label className="label">Ends (optional)</label><input type="date" className="input" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></div>
        </div>
        <ErrorNote message={error} />
        <Button
          onClick={async () => {
            setError(undefined);
            try {
              await api('/seller/promotions', { body: { ...form, endsAt: form.endsAt ? `${form.endsAt}T23:59:59` : undefined } });
              promos.reload();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Create {form.kind}
        </Button>
        <div className="divide-y rounded-lg border">
          {promos.data.length === 0 && <p className="p-4 text-sm text-neutral-500">No promotions yet.</p>}
          {promos.data.map((p) => {
            const live = isPromotionLive(p);
            return (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div>
                  <p className="font-semibold">{p.kind === 'coupon' ? `Coupon ${p.code}` : 'Sale'} — {describePromotion(p, formatMoney)}{p.minOrder > 0 && ` on orders over ${formatMoney(p.minOrder)}`}</p>
                  <p className="text-xs text-neutral-500">Started {formatDate(p.startsAt)}{p.endsAt && ` · ends ${formatDate(p.endsAt)}`} · used {p.timesUsed}×</p>
                </div>
                {live ? <Button variant="ghost" onClick={async () => { await api(`/seller/promotions/${p.id}/end`, { body: {} }); promos.reload(); }}>End now</Button> : <span className="text-xs text-neutral-500">Ended</span>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="card space-y-4 p-6">
        <h2 className="text-lg font-semibold">Ads</h2>
        <p className="text-sm text-neutral-600">Promoted listings show in the ad row at the top of matching search results. You pay {formatMoney(FEES.adCostPerClick)} per click, never more than your daily budget. Choose which listings to promote in each listing's settings.</p>
        <div className="flex flex-wrap items-end gap-3">
          <div><label className="label">Daily budget ($)</label><MoneyInput value={dailyBudget} onChange={setBudget} /></div>
          <Button onClick={async () => { await api('/seller/shop', { method: 'PATCH', body: { adsDailyBudget: dailyBudget } }); setSaved(true); shop.reload(); }}>Save budget</Button>
          {saved && <span className="text-sm text-green-700">Saved</span>}
        </div>
        {stats.data && <p className="text-sm">Last 30 days: <b>{stats.data.adClicks}</b> clicks · <b>{formatMoney(stats.data.adSpend)}</b> spent</p>}
        {dailyBudget === 0 && <p className="text-sm text-amber-700">Ads are paused while the budget is $0.</p>}
      </section>
    </div>
  );
}
