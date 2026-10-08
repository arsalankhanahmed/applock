import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Award, Trash2 } from 'lucide-react';
import { useApi } from '../useApi.ts';
import { api } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { Empty, ListingCard, ListingGrid, Spinner, Stars } from '../components/ui.tsx';

export default function FavoritesPage() {
  const { data, reload } = useApi('/favorites');
  const [tab, setTab] = useState<'items' | 'shops' | 'collections'>('items');
  if (!data) return <Spinner />;
  const tabBtn = (key: typeof tab, label: string) => (
    <button onClick={() => setTab(key)} className={`border-b-2 pb-2 font-semibold ${tab === key ? 'border-neutral-900' : 'border-transparent text-neutral-500'}`}>{label}</button>
  );
  return (
    <Page>
      <h1 className="mb-6 font-serif text-3xl">Favorites</h1>
      <div className="mb-8 flex gap-6 border-b">
        {tabBtn('items', `Items (${data.listings.length})`)}
        {tabBtn('shops', `Shops (${data.shops.length})`)}
        {tabBtn('collections', `Collections (${data.collections.length})`)}
      </div>
      {tab === 'items' && (data.listings.length ? <ListingGrid cards={data.listings} /> : <Empty title="Nothing favorited yet">Tap the ♥ on any item to save it here.</Empty>)}
      {tab === 'shops' &&
        (data.shops.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.shops.map((s: any) => (
              <Link key={s.id} to={`/shop/${s.slug}`} className="card flex items-center gap-4 p-4 hover:shadow-md">
                <img src={s.logo} alt="" className="h-16 w-16 rounded-lg object-cover" />
                <div>
                  <p className="flex items-center gap-1 font-semibold">{s.name} {s.starSeller && <Award className="h-4 w-4 text-purple-700" />}</p>
                  <p className="text-xs text-neutral-500">{s.location} · {s.sales} sales</p>
                  {s.reviewCount > 0 && <Stars rating={s.rating} count={s.reviewCount} size={11} />}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <Empty title="No favorite shops yet" />
        ))}
      {tab === 'collections' &&
        (data.collections.length ? (
          <div className="space-y-10">
            {data.collections.map((c: any) => (
              <section key={c.id}>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="font-serif text-xl">{c.name} <span className="text-sm text-neutral-500">({c.listingIds.length} items{c.isPublic ? ', public' : ', private'})</span></h2>
                  <button className="inline-flex items-center gap-1 text-sm text-neutral-600 hover:underline" onClick={async () => { if (confirm(`Delete “${c.name}”?`)) { await api(`/collections/${c.id}`, { method: 'DELETE' }); reload(); } }}>
                    <Trash2 className="h-4 w-4" /> Delete
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
                  {c.listingIds.map((id: string) => {
                    const card = data.listings.find((l: any) => l.id === id);
                    return card ? <ListingCard key={id} card={card} /> : <Link key={id} to={`/listing/${id}`} className="grid aspect-square place-items-center rounded-xl bg-neutral-100 text-xs underline">View item</Link>;
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <Empty title="No collections yet">Use “Add to collection” on any listing to organise your finds.</Empty>
        ))}
    </Page>
  );
}
