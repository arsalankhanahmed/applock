import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CreditCard, Lock } from 'lucide-react';
import { useApi } from '../useApi.ts';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';
import { Page } from '../components/Layout.tsx';
import { Button, Empty, ErrorNote, Spinner } from '../components/ui.tsx';
import { loadCoupons } from './Cart.tsx';
import { formatMoney } from '../../shared/config.ts';
import type { Address, CartShopGroup } from '../../shared/types.ts';

const EMPTY_ADDRESS: Address = { name: '', line1: '', line2: '', city: '', state: '', postalCode: '', country: '' };

export function AddressFields({ value, onChange }: { value: Address; onChange: (a: Address) => void }) {
  const field = (key: keyof Address, label: string, opts: { required?: boolean; autoComplete?: string } = {}) => (
    <div>
      <label className="label">{label}{opts.required && ' *'}</label>
      <input className="input" required={opts.required} autoComplete={opts.autoComplete} value={value[key] ?? ''} onChange={(e) => onChange({ ...value, [key]: e.target.value })} />
    </div>
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">{field('name', 'Full name', { required: true, autoComplete: 'name' })}</div>
      <div className="sm:col-span-2">{field('line1', 'Street address', { required: true, autoComplete: 'address-line1' })}</div>
      <div className="sm:col-span-2">{field('line2', 'Apt / Suite / Other', { autoComplete: 'address-line2' })}</div>
      {field('city', 'City', { required: true, autoComplete: 'address-level2' })}
      {field('state', 'State / Province', { autoComplete: 'address-level1' })}
      {field('postalCode', 'Postal code', { required: true, autoComplete: 'postal-code' })}
      {field('country', 'Country', { required: true, autoComplete: 'country-name' })}
    </div>
  );
}

export default function CheckoutPage() {
  const { user, refresh } = useSession();
  const navigate = useNavigate();
  const coupons = loadCoupons();
  const { data } = useApi<{ groups: CartShopGroup[]; total: number }>(`/cart?coupons=${encodeURIComponent(JSON.stringify(coupons))}`);
  const [address, setAddress] = useState<Address>(user?.address ?? EMPTY_ADDRESS);
  const [saveAddress, setSaveAddress] = useState(!user?.address);
  const [gifts, setGifts] = useState<Record<string, string | undefined>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!data) return <Spinner />;
  if (data.groups.length === 0) return <Page><Empty title="Your cart is empty"><Link to="/" className="underline">Keep shopping</Link></Empty></Page>;
  const needsShipping = data.groups.some((g) => g.items.some((i) => !i.listing.isDigital));

  return (
    <Page>
      <h1 className="mb-6 font-serif text-3xl">Checkout</h1>
      <form
        className="grid gap-8 lg:grid-cols-[1fr_380px]"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const giftShops = Object.keys(gifts).filter((k) => gifts[k] !== undefined);
            const giftMessages = Object.fromEntries(giftShops.map((k) => [k, gifts[k] ?? '']));
            const { orders } = await api('/checkout', { body: { address, saveAddress, coupons, giftShops, giftMessages, notes } });
            try { sessionStorage.removeItem('hb_coupons'); } catch { /* ignore */ }
            await refresh();
            navigate(`/purchases?placed=${orders.length}`);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="space-y-8">
          <section className="card p-6">
            <h2 className="mb-4 text-lg font-semibold">{needsShipping ? 'Shipping address' : 'Billing address'}</h2>
            <AddressFields value={address} onChange={setAddress} />
            <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={saveAddress} onChange={(e) => setSaveAddress(e.target.checked)} className="accent-neutral-900" /> Save this address to my account</label>
          </section>
          <section className="card p-6">
            <h2 className="mb-4 text-lg font-semibold">Order options</h2>
            <div className="space-y-6">
              {data.groups.map((g) => (
                <div key={g.shop.id}>
                  <p className="font-semibold">{g.shop.name}</p>
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    <input type="checkbox" className="accent-neutral-900" checked={gifts[g.shop.id] !== undefined} onChange={(e) => setGifts({ ...gifts, [g.shop.id]: e.target.checked ? '' : undefined })} />
                    This order is a gift (prices hidden on packing slip)
                  </label>
                  {gifts[g.shop.id] !== undefined && (
                    <textarea className="input mt-2" placeholder="Gift message (optional)" maxLength={200} value={gifts[g.shop.id]} onChange={(e) => setGifts({ ...gifts, [g.shop.id]: e.target.value })} />
                  )}
                  <input className="input mt-2" placeholder={`Add a note to ${g.shop.name} (optional)`} value={notes[g.shop.id] ?? ''} onChange={(e) => setNotes({ ...notes, [g.shop.id]: e.target.value })} />
                </div>
              ))}
            </div>
          </section>
          <section className="card p-6">
            <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold"><CreditCard className="h-5 w-5" /> Payment</h2>
            <p className="mb-4 text-sm text-neutral-600">Demo mode — no real card is charged. Connect a payment gateway (Stripe, PayFast, JazzCash…) in <code>server/services.ts → checkout()</code>.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2"><label className="label">Card number</label><input className="input" placeholder="4242 4242 4242 4242" autoComplete="off" /></div>
              <div><label className="label">Expiry</label><input className="input" placeholder="MM / YY" autoComplete="off" /></div>
              <div><label className="label">CVC</label><input className="input" placeholder="123" autoComplete="off" /></div>
            </div>
          </section>
        </div>
        <aside className="card h-fit p-6 lg:sticky lg:top-28">
          <h2 className="mb-4 text-lg font-semibold">Order summary</h2>
          <div className="space-y-3">
            {data.groups.map((g) => (
              <div key={g.shop.id} className="text-sm">
                <p className="font-semibold">{g.shop.name}</p>
                {g.items.map((i) => (
                  <div key={i.id} className="flex justify-between gap-2 text-neutral-700">
                    <span className="line-clamp-1">{i.quantity} × {i.listing.title}</span>
                    <span>{formatMoney(i.lineTotal)}</span>
                  </div>
                ))}
                {g.discount > 0 && <div className="flex justify-between text-green-700"><span>Discount</span><span>−{formatMoney(g.discount)}</span></div>}
                <div className="flex justify-between text-neutral-700"><span>Shipping</span><span>{g.shipping ? formatMoney(g.shipping) : 'FREE'}</span></div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-between border-t pt-3 text-lg font-bold"><span>Total</span><span>{formatMoney(data.total)}</span></div>
          <ErrorNote message={error} />
          <Button className="mt-4 w-full" loading={busy}><Lock className="h-4 w-4" /> Place order</Button>
          <p className="mt-3 text-xs text-neutral-500">Each shop receives a separate order. Purchase protection covers orders that don't arrive or aren't as described.</p>
        </aside>
      </form>
    </Page>
  );
}
