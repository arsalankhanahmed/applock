import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Flag, Heart, MapPin, MessageSquare } from 'lucide-react';
import { useApi } from '../useApi.ts';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';
import { Page } from '../components/Layout.tsx';
import { Button, Empty, ListingGrid, Spinner, Stars, StarSellerBadge, formatDate } from '../components/ui.tsx';
import { ContactModal, ReportModal } from './Listing.tsx';
import { APP_NAME, formatMoney } from '../../shared/config.ts';

export default function ShopPage() {
  const { slug } = useParams();
  const { user } = useSession();
  const navigate = useNavigate();
  const { data, error, setData } = useApi(`/shops/${slug}`);
  const [section, setSection] = useState<string>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('featured');
  const [modal, setModal] = useState<'contact' | 'report' | null>(null);

  if (error) return <Page><Empty title={error} /></Page>;
  if (!data) return <Spinner />;
  const { shop, stats, owner } = data;

  let listings = data.listings.filter((l: any) => (section === 'all' || l.sectionId === section) && (!q || l.title.toLowerCase().includes(q.toLowerCase())));
  if (sort === 'price_asc') listings = [...listings].sort((a, b) => (a.salePrice ?? a.price) - (b.salePrice ?? b.price));
  if (sort === 'price_desc') listings = [...listings].sort((a, b) => (b.salePrice ?? b.price) - (a.salePrice ?? a.price));

  const sale = data.sale;
  return (
    <div>
      <div className="h-40 bg-neutral-100 sm:h-56">{shop.banner && <img src={shop.banner} alt="" className="h-full w-full object-cover" />}</div>
      <Page>
        {shop.status !== 'active' && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">This shop is suspended and hidden from buyers.</div>}
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <img src={shop.logo} alt="" className="-mt-20 h-28 w-28 rounded-xl border-4 border-white bg-white object-cover shadow" />
          <div className="flex-1">
            <h1 className="flex flex-wrap items-center gap-2 font-serif text-3xl">{shop.name} {stats.starSeller && <StarSellerBadge />}</h1>
            <p className="text-neutral-700">{shop.tagline}</p>
            <p className="mt-1 flex flex-wrap items-center gap-3 text-sm text-neutral-600">
              <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" /> {shop.location}</span>
              <span>{stats.sales.toLocaleString()} sales</span>
              {stats.reviewCount > 0 && <Stars rating={stats.rating} count={stats.reviewCount} />}
            </p>
          </div>
          <div className="flex gap-2">
            {data.isOwner ? (
              <Link to="/seller/settings" className="rounded-full border-2 border-neutral-900 px-5 py-2 text-sm font-semibold">Edit shop</Link>
            ) : (
              <>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    if (!user) return navigate('/login');
                    const res = await api(`/shop-favorites/${shop.id}`, { body: {} });
                    setData({ ...data, favorited: res.favorited });
                  }}
                >
                  <Heart className={`h-4 w-4 ${data.favorited ? 'fill-red-500 text-red-500' : ''}`} /> {data.favorited ? 'Favorited' : 'Favorite shop'}
                </Button>
                <Button variant="ghost" onClick={() => (user ? setModal('contact') : navigate('/login'))}>
                  <MessageSquare className="h-4 w-4" /> Contact
                </Button>
              </>
            )}
          </div>
        </div>

        {shop.announcement && <div className="mt-6 rounded-xl bg-neutral-50 p-4 text-sm"><span className="font-semibold">Announcement: </span>{shop.announcement}</div>}
        {sale && (
          <div className="mt-4 rounded-xl bg-green-50 p-4 text-sm text-green-900">
            <span className="font-semibold">Sale on now: </span>
            {sale.discountType === 'percent' ? `${sale.value}% off` : `${formatMoney(sale.value)} off`} every item
            {sale.endsAt && ` until ${formatDate(sale.endsAt)}`}
          </div>
        )}
        {shop.vacationMode && <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm">This shop is taking a short break. {shop.vacationMessage}</div>}

        <div className="mt-10 grid gap-8 md:grid-cols-[200px_1fr]">
          <aside className="space-y-1 text-sm">
            <button onClick={() => setSection('all')} className={`flex w-full justify-between rounded-lg px-3 py-2 text-left ${section === 'all' ? 'bg-neutral-100 font-semibold' : 'hover:bg-neutral-50'}`}>
              All items <span>{data.listings.length}</span>
            </button>
            {shop.sections.map((s: { id: string; name: string }) => (
              <button key={s.id} onClick={() => setSection(s.id)} className={`flex w-full justify-between rounded-lg px-3 py-2 text-left ${section === s.id ? 'bg-neutral-100 font-semibold' : 'hover:bg-neutral-50'}`}>
                {s.name} <span>{data.listings.filter((l: any) => l.sectionId === s.id).length}</span>
              </button>
            ))}
            {user && !data.isOwner && (
              <button className="mt-4 flex items-center gap-1 px-3 text-xs text-neutral-500 hover:underline" onClick={() => setModal('report')}>
                <Flag className="h-3 w-3" /> Report this shop
              </button>
            )}
          </aside>
          <div>
            <div className="mb-5 flex flex-wrap gap-2">
              <input className="input max-w-xs" placeholder={`Search all ${data.listings.length} items`} value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="featured">Featured</option>
                <option value="price_asc">Lowest price</option>
                <option value="price_desc">Highest price</option>
              </select>
            </div>
            {listings.length ? <ListingGrid cards={listings} cols="lg:grid-cols-3" /> : <Empty title="No items here yet" />}
          </div>
        </div>

        <section className="mt-16 grid gap-10 md:grid-cols-2">
          <div>
            <h2 className="mb-3 font-serif text-2xl">Reviews</h2>
            {data.reviews.length === 0 && <p className="text-sm text-neutral-500">No reviews yet.</p>}
            <div className="divide-y">
              {data.reviews.map((r: any) => (
                <div key={r.id} className="py-4">
                  <Stars rating={r.rating} />
                  <p className="mt-1 text-sm">{r.text}</p>
                  <p className="mt-1 text-xs text-neutral-500">{r.buyerName} · {formatDate(r.createdAt)} · <Link to={`/listing/${r.listingId}`} className="underline">{r.listingTitle}</Link></p>
                  {r.sellerReply && <p className="mt-2 rounded bg-neutral-50 p-2 text-sm"><b>Seller: </b>{r.sellerReply}</p>}
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-8">
            <div>
              <h2 className="mb-3 font-serif text-2xl">About</h2>
              <p className="whitespace-pre-line text-sm leading-relaxed">{shop.about || 'This seller has not written an about section yet.'}</p>
              {owner && (
                <Link to={`/people/${owner.id}`} className="mt-4 flex items-center gap-3">
                  {owner.avatar ? <img src={owner.avatar} className="h-10 w-10 rounded-full object-cover" alt="" /> : <div className="h-10 w-10 rounded-full bg-neutral-200" />}
                  <span className="text-sm"><b>{owner.name}</b><br /><span className="text-neutral-500">Owner of {shop.name}</span></span>
                </Link>
              )}
              <p className="mt-3 text-xs text-neutral-500">On {APP_NAME} since {formatDate(shop.createdAt)}</p>
            </div>
            <div>
              <h2 className="mb-3 font-serif text-2xl">Shop policies</h2>
              <dl className="space-y-3 text-sm">
                <div><dt className="font-semibold">Processing time</dt><dd>{shop.policies.processingDays} business days</dd></div>
                <div><dt className="font-semibold">Shipping</dt><dd className="whitespace-pre-line">{shop.policies.shipping}</dd></div>
                <div><dt className="font-semibold">Returns & exchanges</dt><dd className="whitespace-pre-line">{shop.policies.acceptsReturns ? shop.policies.returns : 'This shop does not accept returns.'}</dd></div>
                <div><dt className="font-semibold">Privacy</dt><dd className="whitespace-pre-line">{shop.policies.privacy}</dd></div>
              </dl>
            </div>
          </div>
        </section>
      </Page>
      {modal === 'contact' && <ContactModal shopId={shop.id} shopName={shop.name} onClose={() => setModal(null)} />}
      {modal === 'report' && <ReportModal targetType="shop" targetId={shop.id} onClose={() => setModal(null)} />}
    </div>
  );
}
