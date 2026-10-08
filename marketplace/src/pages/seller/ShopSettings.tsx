import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useApi } from '../../useApi.ts';
import { api } from '../../api.ts';
import { Button, ErrorNote, ImageUploader, Spinner } from '../../components/ui.tsx';
import type { Shop } from '../../../shared/types.ts';

export default function ShopSettings() {
  const { data } = useApi('/seller/shop');
  const [shop, setShop] = useState<Shop | null>(null);
  const [status, setStatus] = useState<{ ok?: string; error?: string }>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setShop(data.shop); }, [data]);
  if (!shop) return <Spinner />;
  const set = (patch: Partial<Shop>) => setShop({ ...shop, ...patch });
  const setPolicy = (patch: Partial<Shop['policies']>) => setShop({ ...shop, policies: { ...shop.policies, ...patch } });

  return (
    <form
      className="space-y-6 pb-10"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          setShop(await api('/seller/shop', { method: 'PATCH', body: shop }));
          setStatus({ ok: 'Shop updated' });
        } catch (err) {
          setStatus({ error: (err as Error).message });
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="font-serif text-3xl">Shop settings</h1>
      <section className="card space-y-4 p-6">
        <h2 className="text-lg font-semibold">Info & appearance</h2>
        <div className="grid gap-6 sm:grid-cols-2">
          <div><label className="label">Shop icon</label><ImageUploader images={shop.logo ? [shop.logo] : []} onChange={(v) => set({ logo: v[0] })} max={1} /></div>
          <div><label className="label">Banner</label><ImageUploader images={shop.banner ? [shop.banner] : []} onChange={(v) => set({ banner: v[0] })} max={1} /></div>
        </div>
        <div><label className="label">Shop title</label><input className="input" maxLength={55} value={shop.tagline} onChange={(e) => set({ tagline: e.target.value })} /></div>
        <div><label className="label">Location</label><input className="input" value={shop.location} onChange={(e) => set({ location: e.target.value })} /></div>
        <div><label className="label">Announcement</label><textarea className="input" value={shop.announcement} onChange={(e) => set({ announcement: e.target.value })} /></div>
        <div><label className="label">About your shop</label><textarea className="input min-h-32" value={shop.about} onChange={(e) => set({ about: e.target.value })} /></div>
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-lg font-semibold">Sections</h2>
        <p className="text-sm text-neutral-600">Organise your listings into sections buyers can browse.</p>
        {shop.sections.map((s, i) => (
          <div key={s.id || i} className="flex gap-2">
            <input className="input" maxLength={24} value={s.name} onChange={(e) => set({ sections: shop.sections.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <button type="button" className="rounded-full p-2 hover:bg-neutral-100" aria-label="Remove section" onClick={() => set({ sections: shop.sections.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        <button type="button" className="text-sm font-semibold underline" onClick={() => set({ sections: [...shop.sections, { id: '', name: '' }] })}>+ Add section</button>
      </section>

      <section className="card space-y-4 p-6">
        <h2 className="text-lg font-semibold">Policies</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label className="label">Default processing time (days)</label><input type="number" min={1} max={70} className="input" value={shop.policies.processingDays} onChange={(e) => setPolicy({ processingDays: Number(e.target.value) })} /></div>
          <div><label className="label">Return window (days)</label><input type="number" min={0} max={90} className="input" value={shop.policies.returnWindowDays} onChange={(e) => setPolicy({ returnWindowDays: Number(e.target.value) })} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-neutral-900" checked={shop.policies.acceptsReturns} onChange={(e) => setPolicy({ acceptsReturns: e.target.checked })} /> I accept returns and exchanges</label>
        <div><label className="label">Shipping policy</label><textarea className="input" value={shop.policies.shipping} onChange={(e) => setPolicy({ shipping: e.target.value })} /></div>
        <div><label className="label">Returns policy</label><textarea className="input" value={shop.policies.returns} onChange={(e) => setPolicy({ returns: e.target.value })} /></div>
        <div><label className="label">Privacy policy</label><textarea className="input" value={shop.policies.privacy} onChange={(e) => setPolicy({ privacy: e.target.value })} /></div>
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-lg font-semibold">Vacation mode</h2>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-neutral-900" checked={shop.vacationMode} onChange={(e) => set({ vacationMode: e.target.checked })} /> Put my shop on vacation (listings are hidden from search and can't be purchased)</label>
        {shop.vacationMode && <textarea className="input" placeholder="Message to shoppers" value={shop.vacationMessage} onChange={(e) => set({ vacationMessage: e.target.value })} />}
      </section>

      <ErrorNote message={status.error} />
      {status.ok && <p className="text-sm text-green-700">{status.ok}</p>}
      <Button loading={busy}>Save settings</Button>
    </form>
  );
}
