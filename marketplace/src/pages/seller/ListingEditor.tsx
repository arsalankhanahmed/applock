import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Trash2, Upload } from 'lucide-react';
import { api, uploadFile } from '../../api.ts';
import { useApi } from '../../useApi.ts';
import { Button, ErrorNote, ImageUploader, MoneyInput, Spinner, StatusPill } from '../../components/ui.tsx';
import { CATEGORIES, categoryPath } from '../../../shared/categories.ts';
import { FEES, formatMoney } from '../../../shared/config.ts';
import type { Listing, Variation } from '../../../shared/types.ts';

type Draft = Omit<Listing, 'id' | 'shopId' | 'status' | 'views' | 'createdAt'> & { status?: Listing['status'] };

const BLANK: Draft = {
  title: '',
  description: '',
  price: 1000,
  quantity: 1,
  images: [],
  categoryId: '',
  tags: [],
  materials: [],
  type: 'handmade',
  isDigital: false,
  variations: [],
  personalization: { enabled: false, required: false, instructions: '' },
  shipping: { cost: 500, additionalItemCost: 100, freeShipping: false, shipsFrom: '', processingDays: 3 },
  autoRenew: true,
  promoted: false,
  featured: false,
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card space-y-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {hint && <p className="text-sm text-neutral-600">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function ChipInput({ values, onChange, max, placeholder }: { values: string[]; onChange: (v: string[]) => void; max: number; placeholder: string }) {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text.split(',').map((t) => t.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...values, ...parts])].slice(0, max));
    setText('');
  };
  return (
    <div>
      <div className="flex gap-2">
        <input className="input" placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button type="button" variant="secondary" onClick={add}>Add</Button>
      </div>
      <p className="mt-1 text-xs text-neutral-500">{max - values.length} left</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1 text-xs">
            {v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}>×</button>
          </span>
        ))}
      </div>
    </div>
  );
}

function VariationEditor({ variations, onChange }: { variations: Variation[]; onChange: (v: Variation[]) => void }) {
  const update = (i: number, v: Variation) => onChange(variations.map((x, j) => (j === i ? v : x)));
  return (
    <div className="space-y-4">
      {variations.map((v, i) => (
        <div key={i} className="rounded-lg border p-4">
          <div className="flex gap-2">
            <input className="input" placeholder="Variation name, e.g. Size or Colour" value={v.name} onChange={(e) => update(i, { ...v, name: e.target.value })} />
            <button type="button" className="rounded-full p-2 hover:bg-neutral-100" aria-label="Remove variation" onClick={() => onChange(variations.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
          </div>
          <div className="mt-3 space-y-2">
            {v.options.map((o, k) => (
              <div key={k} className="grid grid-cols-[1fr_120px_auto] items-center gap-2">
                <input className="input" placeholder="Option" value={o.value} onChange={(e) => update(i, { ...v, options: v.options.map((x, m) => (m === k ? { ...x, value: e.target.value } : x)) })} />
                <MoneyInput value={o.priceDelta} onChange={(c) => update(i, { ...v, options: v.options.map((x, m) => (m === k ? { ...x, priceDelta: c } : x)) })} />
                <button type="button" className="p-2" aria-label="Remove option" onClick={() => update(i, { ...v, options: v.options.filter((_, m) => m !== k) })}>×</button>
              </div>
            ))}
            <p className="text-xs text-neutral-500">Second column: price difference from the base price (0 for same price).</p>
            <button type="button" className="text-sm font-semibold underline" onClick={() => update(i, { ...v, options: [...v.options, { value: '', priceDelta: 0 }] })}>+ Add option</button>
          </div>
        </div>
      ))}
      {variations.length < 2 && (
        <Button type="button" variant="secondary" onClick={() => onChange([...variations, { name: '', options: [{ value: '', priceDelta: 0 }] }])}>
          <Plus className="h-4 w-4" /> Add a variation
        </Button>
      )}
    </div>
  );
}

export default function ListingEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const shop = useApi('/seller/shop');
  const existing = useApi<Listing>(id ? `/seller/listings/${id}` : null);
  const [draft, setDraft] = useState<Draft | null>(id ? null : BLANK);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (existing.data) setDraft(existing.data);
  }, [existing.data]);
  useEffect(() => {
    if (!id && shop.data && !draft?.shipping.shipsFrom) {
      setDraft((d) => d && { ...d, shipping: { ...d.shipping, shipsFrom: shop.data.shop.location, processingDays: shop.data.shop.policies.processingDays } });
    }
  }, [id, shop.data, draft?.shipping.shipsFrom]);

  if (existing.error) return <ErrorNote message={existing.error} />;
  if (!draft || !shop.data) return <Spinner />;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const isPublished = draft.status === 'active' || draft.status === 'sold_out';

  const save = async (publish: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const body = { ...draft, publish };
      if (id) await api(`/seller/listings/${id}`, { method: 'PUT', body });
      else await api('/seller/listings', { body });
      navigate('/seller/listings');
    } catch (e) {
      setError((e as Error).message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 pb-24">
      <div className="flex items-center gap-3">
        <h1 className="font-serif text-3xl">{id ? 'Edit listing' : 'New listing'}</h1>
        {draft.status && <StatusPill status={draft.status} />}
      </div>
      <ErrorNote message={error} />

      <Section title="Photos" hint="Add up to 10 photos. The first one is shown in search results.">
        <ImageUploader images={draft.images} onChange={(images) => set({ images })} />
      </Section>

      <Section title="Listing details" hint="Tell the world all about your item and why they'll love it.">
        <div>
          <label className="label">Title *</label>
          <input className="input" maxLength={140} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
          <p className="mt-1 text-xs text-neutral-500">{140 - draft.title.length} characters left. Include keywords buyers would search for.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">What is it? *</label>
            <select className="input" value={draft.type} onChange={(e) => set({ type: e.target.value as Draft['type'] })}>
              <option value="handmade">I made it (handmade)</option>
              <option value="vintage">Vintage (at least 20 years old)</option>
              <option value="supplies">A craft supply or tool</option>
            </select>
          </div>
          <div>
            <label className="label">Category *</label>
            <select className="input" value={draft.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
              <option value="">Choose a category</option>
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>{categoryPath(c.id).map((p) => p.name).join(' › ')}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label">Description *</label>
          <textarea className="input min-h-40" value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </div>
        <div>
          <label className="label">Tags</label>
          <ChipInput values={draft.tags} onChange={(tags) => set({ tags })} max={13} placeholder="Shape, colour, style, function…" />
        </div>
        <div>
          <label className="label">Materials</label>
          <ChipInput values={draft.materials} onChange={(materials) => set({ materials })} max={13} placeholder="Ingredients, components…" />
        </div>
        {shop.data.shop.sections.length > 0 && (
          <div>
            <label className="label">Shop section</label>
            <select className="input" value={draft.sectionId ?? ''} onChange={(e) => set({ sectionId: e.target.value || undefined })}>
              <option value="">None</option>
              {shop.data.shop.sections.map((s: { id: string; name: string }) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
      </Section>

      <Section title="Price & inventory">
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label className="label">Price ($) *</label><MoneyInput value={draft.price} onChange={(price) => set({ price })} /></div>
          <div><label className="label">Quantity *</label><input className="input" type="number" min={0} max={999} value={draft.quantity} onChange={(e) => set({ quantity: Number(e.target.value) })} /></div>
        </div>
        <div>
          <p className="label">Variations</p>
          <p className="mb-3 text-sm text-neutral-600">Add options like size or colour. Buyers must choose one of each.</p>
          <VariationEditor variations={draft.variations} onChange={(variations) => set({ variations })} />
        </div>
      </Section>

      <Section title="Personalization" hint="Collect personalization info from buyers, e.g. a name or initials.">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-neutral-900" checked={draft.personalization.enabled} onChange={(e) => set({ personalization: { ...draft.personalization, enabled: e.target.checked } })} /> Offer personalization</label>
        {draft.personalization.enabled && (
          <>
            <textarea className="input" placeholder="Instructions for buyers" maxLength={256} value={draft.personalization.instructions} onChange={(e) => set({ personalization: { ...draft.personalization, instructions: e.target.value } })} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-neutral-900" checked={draft.personalization.required} onChange={(e) => set({ personalization: { ...draft.personalization, required: e.target.checked } })} /> Personalization is required</label>
          </>
        )}
      </Section>

      <Section title="Delivery">
        <div className="flex gap-6 text-sm">
          <label className="flex items-center gap-2"><input type="radio" className="accent-neutral-900" checked={!draft.isDigital} onChange={() => set({ isDigital: false })} /> Physical item</label>
          <label className="flex items-center gap-2"><input type="radio" className="accent-neutral-900" checked={draft.isDigital} onChange={() => set({ isDigital: true })} /> Digital download</label>
        </div>
        {draft.isDigital ? (
          <div>
            <label className="label">Digital file (PDF, ZIP or image, max 8 MB)</label>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border-2 border-neutral-900 px-4 py-2 text-sm font-semibold">
              <Upload className="h-4 w-4" /> {uploading ? 'Uploading…' : draft.digitalFileUrl ? 'Replace file' : 'Upload file'}
              <input type="file" className="hidden" accept=".pdf,.zip,image/*" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setUploading(true);
                try { set({ digitalFileUrl: await uploadFile(file) }); } catch (err) { setError((err as Error).message); } finally { setUploading(false); }
              }} />
            </label>
            {draft.digitalFileUrl && <p className="mt-2 text-sm text-green-700">File uploaded ✓ Buyers can download it right after payment.</p>}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="accent-neutral-900" checked={draft.shipping.freeShipping} onChange={(e) => set({ shipping: { ...draft.shipping, freeShipping: e.target.checked } })} /> Offer free shipping</label>
            {!draft.shipping.freeShipping && (
              <>
                <div><label className="label">Shipping cost — first item ($)</label><MoneyInput value={draft.shipping.cost} onChange={(cost) => set({ shipping: { ...draft.shipping, cost } })} /></div>
                <div><label className="label">Each additional item ($)</label><MoneyInput value={draft.shipping.additionalItemCost} onChange={(additionalItemCost) => set({ shipping: { ...draft.shipping, additionalItemCost } })} /></div>
              </>
            )}
            <div><label className="label">Processing time (business days)</label><input type="number" min={1} max={70} className="input" value={draft.shipping.processingDays} onChange={(e) => set({ shipping: { ...draft.shipping, processingDays: Number(e.target.value) } })} /></div>
            <div><label className="label">Ships from</label><input className="input" value={draft.shipping.shipsFrom} onChange={(e) => set({ shipping: { ...draft.shipping, shipsFrom: e.target.value } })} /></div>
          </div>
        )}
      </Section>

      <Section title="Settings">
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-neutral-900" checked={draft.autoRenew} onChange={(e) => set({ autoRenew: e.target.checked })} /> <span><b>Auto-renew</b> — renew automatically every {Math.round(FEES.listingDurationDays / 30)} months and after each sale for {formatMoney(FEES.listingFee)}.</span></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-neutral-900" checked={draft.featured} onChange={(e) => set({ featured: e.target.checked })} /> <span><b>Feature in shop</b> — show at the top of your shop home.</span></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-neutral-900" checked={draft.promoted} onChange={(e) => set({ promoted: e.target.checked })} /> <span><b>Promote with ads</b> — appear in the ad row of search results. {formatMoney(FEES.adCostPerClick)} per click, within your daily budget ({formatMoney(shop.data.shop.adsDailyBudget)}/day — change it in Marketing).</span></label>
      </Section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-white/95 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-end gap-3 px-4">
          {!isPublished && <p className="mr-auto text-xs text-neutral-500">Publishing costs {formatMoney(FEES.listingFee)}.</p>}
          <Button variant="ghost" type="button" onClick={() => navigate('/seller/listings')}>Cancel</Button>
          {isPublished ? (
            <Button loading={busy} onClick={() => save(false)}>Save changes</Button>
          ) : (
            <>
              <Button variant="secondary" loading={busy} onClick={() => save(false)}>Save as draft</Button>
              <Button loading={busy} onClick={() => save(true)}>Publish</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
