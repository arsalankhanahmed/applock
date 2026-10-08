import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Gift, Tag, Trash2 } from 'lucide-react';
import { useApi } from '../useApi.ts';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';
import { Page } from '../components/Layout.tsx';
import { Button, Empty, ListingCard, Spinner } from '../components/ui.tsx';
import { formatMoney } from '../../shared/config.ts';
import type { CartShopGroup } from '../../shared/types.ts';

const COUPON_KEY = 'hb_coupons';

export function loadCoupons(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(COUPON_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveCoupons(c: Record<string, string>) {
  try {
    sessionStorage.setItem(COUPON_KEY, JSON.stringify(c));
  } catch {
    // ignore
  }
}

export default function CartPage() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [coupons, setCoupons] = useState<Record<string, string>>(loadCoupons);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { data, reload } = useApi<{ groups: CartShopGroup[]; total: number; saved: any[] }>(`/cart?coupons=${encodeURIComponent(JSON.stringify(coupons))}`);

  if (!data) return <Spinner />;
  const update = async (id: string, body: Record<string, unknown>) => {
    await api(`/cart/${id}`, { method: 'PATCH', body });
    await Promise.all([reload(), refresh()]);
  };
  const remove = async (id: string) => {
    await api(`/cart/${id}`, { method: 'DELETE' });
    await Promise.all([reload(), refresh()]);
  };
  const itemCount = data.groups.reduce((n, g) => n + g.items.reduce((m, i) => m + i.quantity, 0), 0);

  return (
    <Page>
      <h1 className="mb-6 font-serif text-3xl">{itemCount ? `${itemCount} item${itemCount > 1 ? 's' : ''} in your cart` : 'Your cart'}</h1>
      {data.groups.length === 0 ? (
        <Empty title="Your cart is empty.">
          <Link to="/" className="font-semibold underline">Discover something unique to fill it up</Link>
        </Empty>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
          <div className="space-y-6">
            {data.groups.map((g) => (
              <div key={g.shop.id} className="card p-5">
                <Link to={`/shop/${g.shop.slug}`} className="font-semibold hover:underline">{g.shop.name}</Link>
                {g.shop.vacationMode && <p className="mt-1 text-sm text-amber-700">This shop is on vacation — remove its items to check out.</p>}
                <div className="mt-4 divide-y">
                  {g.items.map((item) => (
                    <div key={item.id} className="flex gap-4 py-4">
                      <Link to={`/listing/${item.listingId}`} className="h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-neutral-100">
                        {item.listing.image && <img src={item.listing.image} alt="" className="h-full w-full object-cover" />}
                      </Link>
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between gap-4">
                          <Link to={`/listing/${item.listingId}`} className="line-clamp-2 text-sm hover:underline">{item.listing.title}</Link>
                          <span className="whitespace-nowrap font-bold">{formatMoney(item.lineTotal)}</span>
                        </div>
                        {Object.entries(item.selections).map(([k, v]) => (
                          <p key={k} className="text-xs text-neutral-600">{k}: {v}</p>
                        ))}
                        {item.personalization && <p className="text-xs text-neutral-600">Personalization: {item.personalization}</p>}
                        {item.listing.status !== 'active' && <p className="text-xs font-semibold text-red-700">No longer available</p>}
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                          {!item.listing.isDigital && (
                            <select className="rounded-lg border px-2 py-1" value={item.quantity} onChange={(e) => update(item.id, { quantity: Number(e.target.value) })}>
                              {Array.from({ length: Math.max(1, Math.min(item.listing.quantity, 20)) }, (_, i) => i + 1).map((n) => (
                                <option key={n}>{n}</option>
                              ))}
                            </select>
                          )}
                          <button className="font-semibold hover:underline" onClick={() => update(item.id, { savedForLater: true })}>Save for later</button>
                          <button className="inline-flex items-center gap-1 font-semibold hover:underline" onClick={() => remove(item.id)}><Trash2 className="h-3.5 w-3.5" /> Remove</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-4 text-sm">
                  <Tag className="h-4 w-4" />
                  {g.appliedPromotion ? (
                    <span className="text-green-700">
                      {g.appliedPromotion.code ? `Coupon ${g.appliedPromotion.code}` : 'Shop sale'}: {g.appliedPromotion.label}
                      {g.appliedPromotion.code && (
                        <button className="ml-2 text-neutral-600 underline" onClick={() => { const next = { ...coupons }; delete next[g.shop.id]; setCoupons(next); saveCoupons(next); }}>remove</button>
                      )}
                    </span>
                  ) : null}
                  {!g.appliedPromotion?.code && (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const code = (draft[g.shop.id] ?? '').trim();
                        if (!code) return;
                        const next = { ...coupons, [g.shop.id]: code };
                        setCoupons(next);
                        saveCoupons(next);
                      }}
                    >
                      <input className="rounded-lg border px-2 py-1 text-sm uppercase" placeholder="Shop coupon code" value={draft[g.shop.id] ?? ''} onChange={(e) => setDraft({ ...draft, [g.shop.id]: e.target.value })} />
                      <button className="font-semibold underline">Apply</button>
                    </form>
                  )}
                  {coupons[g.shop.id] && !g.appliedPromotion?.code && <span className="text-red-700">Code “{coupons[g.shop.id]}” isn't valid for this order</span>}
                </div>
                <dl className="mt-4 space-y-1 text-sm">
                  <div className="flex justify-between"><dt>Item(s) total</dt><dd>{formatMoney(g.subtotal)}</dd></div>
                  {g.discount > 0 && <div className="flex justify-between text-green-700"><dt>Shop discount</dt><dd>−{formatMoney(g.discount)}</dd></div>}
                  <div className="flex justify-between"><dt>Shipping</dt><dd>{g.shipping ? formatMoney(g.shipping) : 'FREE'}</dd></div>
                </dl>
              </div>
            ))}
          </div>
          <aside className="card h-fit p-6 lg:sticky lg:top-28">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt>Item(s) total</dt><dd>{formatMoney(data.groups.reduce((s, g) => s + g.subtotal, 0))}</dd></div>
              <div className="flex justify-between text-green-700"><dt>Shop discounts</dt><dd>−{formatMoney(data.groups.reduce((s, g) => s + g.discount, 0))}</dd></div>
              <div className="flex justify-between"><dt>Shipping</dt><dd>{formatMoney(data.groups.reduce((s, g) => s + g.shipping, 0))}</dd></div>
              <div className="flex justify-between border-t pt-2 text-base font-bold"><dt>Total ({itemCount} items)</dt><dd>{formatMoney(data.total)}</dd></div>
            </dl>
            <Button className="mt-5 w-full" onClick={() => navigate('/checkout')} disabled={data.groups.some((g) => g.shop.vacationMode)}>Proceed to checkout</Button>
            <p className="mt-3 flex items-center gap-2 text-xs text-neutral-600"><Gift className="h-4 w-4" /> You can mark orders as gifts at checkout.</p>
          </aside>
        </div>
      )}
      {data.saved.length > 0 && (
        <section className="mt-12">
          <h2 className="mb-4 font-serif text-2xl">Saved for later ({data.saved.length})</h2>
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            {data.saved.map((s: any) => (
              <div key={s.id}>
                <ListingCard card={{ ...s.card, available: s.available }} />
                <div className="mt-2 flex gap-3 text-sm">
                  {s.available && <button className="font-semibold underline" onClick={() => update(s.id, { savedForLater: false })}>Move to cart</button>}
                  <button className="underline" onClick={() => remove(s.id)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </Page>
  );
}
