import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import { useApi } from '../useApi.ts';
import { Empty, ListingGrid, Spinner } from '../components/ui.tsx';
import { Page } from '../components/Layout.tsx';
import { categoryById, childCategories, rootCategories } from '../../shared/categories.ts';

const SORTS = [
  ['relevance', 'Most relevant'],
  ['price_asc', 'Lowest price'],
  ['price_desc', 'Highest price'],
  ['top_rated', 'Top customer reviews'],
  ['newest', 'Most recent'],
];

export default function SearchPage() {
  const { categoryId } = useParams();
  const [params, setParams] = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);
  const category = categoryId ?? params.get('category') ?? '';
  const query = new URLSearchParams(params);
  if (category) query.set('category', category);
  const { data, loading } = useApi(`/search?${query.toString()}`);

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next);
  };
  const toggle = (key: string) => set(key, params.get(key) === '1' ? null : '1');

  const current = category ? categoryById(category) : undefined;
  const subcats = current ? childCategories(current.id) : rootCategories();
  const q = params.get('q');

  const filters = (
    <div className="space-y-6 text-sm">
      <div>
        <p className="mb-2 font-semibold">{current ? current.name : 'Categories'}</p>
        {current?.parentId && <Link to={`/c/${current.parentId}?${params}`} className="mb-1 block text-neutral-600 hover:underline">← {categoryById(current.parentId)?.name}</Link>}
        {current && !current.parentId && <Link to={`/search?${params}`} className="mb-1 block text-neutral-600 hover:underline">← All categories</Link>}
        {subcats.map((c) => (
          <Link key={c.id} to={`/c/${c.id}?${params}`} className="block py-0.5 hover:underline">{c.name}</Link>
        ))}
      </div>
      <div>
        <p className="mb-2 font-semibold">Special offers</p>
        {[
          ['freeShipping', 'FREE shipping'],
          ['onSale', 'On sale'],
          ['digital', 'Digital downloads'],
          ['personalizable', 'Can be personalized'],
        ].map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-2 py-1">
            <input type="checkbox" checked={params.get(key) === '1'} onChange={() => toggle(key)} className="h-4 w-4 accent-neutral-900" /> {label}
          </label>
        ))}
      </div>
      <div>
        <p className="mb-2 font-semibold">Item type</p>
        {[
          ['', 'All items'],
          ['handmade', 'Handmade'],
          ['vintage', 'Vintage'],
          ['supplies', 'Craft supplies'],
        ].map(([value, label]) => (
          <label key={value} className="flex cursor-pointer items-center gap-2 py-1">
            <input type="radio" name="type" checked={(params.get('type') ?? '') === value} onChange={() => set('type', value || null)} className="h-4 w-4 accent-neutral-900" /> {label}
          </label>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const next = new URLSearchParams(params);
          for (const k of ['min', 'max']) {
            const v = String(f.get(k) ?? '');
            if (v) next.set(k, v);
            else next.delete(k);
          }
          setParams(next);
        }}
      >
        <p className="mb-2 font-semibold">Price ($)</p>
        <div className="flex items-center gap-2">
          <input name="min" defaultValue={params.get('min') ?? ''} placeholder="Low" className="input" inputMode="decimal" />
          <span>–</span>
          <input name="max" defaultValue={params.get('max') ?? ''} placeholder="High" className="input" inputMode="decimal" />
        </div>
        <button className="mt-2 rounded-full border px-3 py-1 text-xs font-semibold hover:bg-neutral-100">Apply</button>
      </form>
      <div>
        <p className="mb-2 font-semibold">Shop location</p>
        <input defaultValue={params.get('shipsFrom') ?? ''} placeholder="e.g. Lahore" className="input" onKeyDown={(e) => e.key === 'Enter' && set('shipsFrom', e.currentTarget.value.trim() || null)} />
      </div>
    </div>
  );

  return (
    <Page>
      {data?.categoryPath?.length > 0 && (
        <nav className="mb-2 text-sm text-neutral-600">
          <Link to="/" className="hover:underline">Home</Link>
          {data.categoryPath.map((c: { id: string; name: string }) => (
            <span key={c.id}> / <Link to={`/c/${c.id}`} className="hover:underline">{c.name}</Link></span>
          ))}
        </nav>
      )}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-2xl">
          {q ? <>Results for “{q}”</> : current ? current.name : 'All items'}
          {data && <span className="ml-2 text-base text-neutral-500">({data.total.toLocaleString()} results)</span>}
        </h1>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold lg:hidden" onClick={() => setShowFilters((v) => !v)}>
            <SlidersHorizontal className="h-4 w-4" /> Filters
          </button>
          <select value={params.get('sort') ?? 'relevance'} onChange={(e) => set('sort', e.target.value)} className="rounded-full border px-4 py-2 text-sm">
            {SORTS.map(([v, l]) => (
              <option key={v} value={v}>Sort by: {l}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex gap-8">
        <aside className={`${showFilters ? 'block' : 'hidden'} w-full shrink-0 lg:block lg:w-56`}>{filters}</aside>
        <div className={`min-w-0 flex-1 ${showFilters ? 'max-lg:hidden' : ''}`}>
          {loading && !data ? (
            <Spinner />
          ) : data.total === 0 ? (
            <Empty title="No results found">Try a different search term or remove some filters.</Empty>
          ) : (
            <>
              {data.ads.length > 0 && (
                <div className="mb-10">
                  <ListingGrid cards={data.ads} />
                </div>
              )}
              <ListingGrid cards={data.results} />
              {data.pages > 1 && (
                <div className="mt-10 flex justify-center gap-2">
                  {Array.from({ length: data.pages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        const next = new URLSearchParams(params);
                        next.set('page', String(p));
                        setParams(next);
                      }}
                      className={`h-10 w-10 rounded-full text-sm font-semibold ${p === data.page ? 'bg-neutral-900 text-white' : 'hover:bg-neutral-100'}`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
