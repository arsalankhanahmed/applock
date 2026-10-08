import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { BadgePercent, Megaphone, Store, Wallet } from 'lucide-react';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';
import { Page } from '../components/Layout.tsx';
import { Button, ErrorNote } from '../components/ui.tsx';
import { APP_NAME, FEES, formatMoney } from '../../shared/config.ts';

export default function SellPage() {
  const { user, refresh } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', tagline: '', location: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (user?.shopId) return <Navigate to="/seller" replace />;

  return (
    <div>
      <section className="bg-brand-50 py-16 text-center">
        <h1 className="mx-auto max-w-2xl px-4 font-serif text-4xl">Millions of shoppers can't wait to see what you have in store</h1>
        <p className="mt-4 text-neutral-700">Join the creative marketplace where makers, curators and collectors sell their goods.</p>
      </section>
      <Page>
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="font-serif text-2xl">Open your shop</h2>
            {!user ? (
              <div className="mt-4 space-y-3">
                <p className="text-neutral-700">Sign in or create a free account to get started.</p>
                <Link to="/register?next=/sell" className="inline-block rounded-full bg-neutral-900 px-6 py-2.5 font-semibold text-white">Create account</Link>
              </div>
            ) : (
              <form
                className="mt-4 space-y-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError(undefined);
                  try {
                    await api('/seller/shop', { body: form });
                    await refresh();
                    navigate('/seller/listings/new');
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <div>
                  <label className="label">Shop name</label>
                  <input className="input" maxLength={20} placeholder="e.g. MayaCrafts" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                  <p className="mt-1 text-xs text-neutral-500">4–20 letters or numbers, no spaces. This becomes your shop URL.</p>
                </div>
                <div><label className="label">Shop title</label><input className="input" maxLength={55} placeholder="A short headline for your shop" value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} /></div>
                <div><label className="label">Shop location</label><input className="input" placeholder="City, Country" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} required /></div>
                <ErrorNote message={error} />
                <Button loading={busy}><Store className="h-4 w-4" /> Open shop</Button>
              </form>
            )}
          </div>
          <div id="fees" className="card p-6">
            <h2 className="font-serif text-2xl">Simple, transparent pricing</h2>
            <p className="mt-1 text-sm text-neutral-600">No monthly fees. You only pay when you list and when you sell.</p>
            <ul className="mt-6 space-y-5 text-sm">
              <li className="flex gap-3"><Store className="h-5 w-5 shrink-0 text-brand-600" /><div><b>{formatMoney(FEES.listingFee)} listing fee</b><br />Each listing stays live for {Math.round(FEES.listingDurationDays / 30)} months or until it sells. Multi-quantity listings auto-renew for {formatMoney(FEES.listingFee)} per extra item sold.</div></li>
              <li className="flex gap-3"><BadgePercent className="h-5 w-5 shrink-0 text-brand-600" /><div><b>{(FEES.transactionRate * 100).toFixed(1)}% transaction fee</b><br />On the item price and shipping you charge.</div></li>
              <li className="flex gap-3"><Wallet className="h-5 w-5 shrink-0 text-brand-600" /><div><b>{(FEES.processingRate * 100).toFixed(0)}% + {formatMoney(FEES.processingFlat)} payment processing</b><br />When buyers pay through {APP_NAME} Payments. Payouts go to your bank account.</div></li>
              <li className="flex gap-3"><Megaphone className="h-5 w-5 shrink-0 text-brand-600" /><div><b>Optional ads — {formatMoney(FEES.adCostPerClick)} per click</b><br />Promote listings to the top of search. You set a daily budget and only pay for clicks.</div></li>
            </ul>
          </div>
        </div>
      </Page>
    </div>
  );
}
