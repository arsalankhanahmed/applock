import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, Flag, FolderPlus, Gift, Heart, MapPin, MessageSquare, Package, RotateCcw, ShoppingCart, Truck } from 'lucide-react';
import { useApi } from '../useApi.ts';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';
import { Page } from '../components/Layout.tsx';
import { Button, Empty, ErrorNote, ListingGrid, Modal, Price, Spinner, Stars, StarSellerBadge, formatDate } from '../components/ui.tsx';
import { formatMoney } from '../../shared/config.ts';
import { unitPrice } from '../../shared/fees.ts';
import type { Collection, Listing } from '../../shared/types.ts';

const RECENT_KEY = 'hb_recent';

export function rememberViewed(id: string) {
  try {
    const list: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...list.filter((x) => x !== id)].slice(0, 12)));
  } catch {
    // ignore storage errors
  }
}

function ReviewList({ reviews }: { reviews: any[] }) {
  if (!reviews.length) return <p className="py-6 text-sm text-neutral-500">No reviews yet.</p>;
  return (
    <div className="divide-y">
      {reviews.map((r) => (
        <div key={r.id} className="py-5">
          <Stars rating={r.rating} />
          {r.text && <p className="mt-2 text-sm leading-relaxed">{r.text}</p>}
          {r.image && <img src={r.image} alt="Review" className="mt-2 h-24 w-24 rounded-lg object-cover" />}
          <p className="mt-2 text-xs text-neutral-500">
            {r.buyerName} · {formatDate(r.createdAt)}
            {r.listingTitle && <> · <span className="italic">{r.listingTitle}</span></>}
          </p>
          {r.sellerReply && <p className="mt-2 rounded-lg bg-neutral-50 p-3 text-sm"><span className="font-semibold">Seller response: </span>{r.sellerReply}</p>}
        </div>
      ))}
    </div>
  );
}

function CollectionsModal({ listingId, onClose }: { listingId: string; onClose: () => void }) {
  const { data, reload } = useApi<{ collections: Collection[] }>('/favorites');
  const [name, setName] = useState('');
  return (
    <Modal title="Save to collection" onClose={onClose}>
      <div className="space-y-2">
        {data?.collections.map((c) => {
          const inIt = c.listingIds.includes(listingId);
          return (
            <button key={c.id} className="flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left hover:bg-neutral-50" onClick={async () => { await api(`/collections/${c.id}/toggle/${listingId}`, { body: {} }); reload(); }}>
              <span>{c.name} <span className="text-xs text-neutral-500">({c.listingIds.length})</span></span>
              {inIt && <Check className="h-4 w-4 text-green-700" />}
            </button>
          );
        })}
      </div>
      <form
        className="mt-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const c = await api<Collection>('/collections', { body: { name } });
          await api(`/collections/${c.id}/toggle/${listingId}`, { body: {} });
          setName('');
          reload();
        }}
      >
        <input className="input" placeholder="New collection name" value={name} onChange={(e) => setName(e.target.value)} />
        <Button>Create</Button>
      </form>
    </Modal>
  );
}

function ContactModal({ shopId, shopName, listingId, onClose }: { shopId: string; shopName: string; listingId?: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string>();
  return (
    <Modal title={`Message ${shopName}`} onClose={onClose}>
      <textarea className="input min-h-32" placeholder="Ask about customisation, sizing, shipping…" value={body} onChange={(e) => setBody(e.target.value)} />
      <ErrorNote message={error} />
      <Button
        className="mt-3 w-full"
        onClick={async () => {
          try {
            const { id } = await api('/conversations', { body: { shopId, listingId, body } });
            navigate(`/messages/${id}`);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Send
      </Button>
    </Modal>
  );
}

export function ReportModal({ targetType, targetId, onClose }: { targetType: string; targetId: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  return (
    <Modal title="Report this item" onClose={onClose}>
      {done ? (
        <p className="text-sm">Thanks — our team will review your report.</p>
      ) : (
        <>
          <select className="input mb-3" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose a reason…</option>
            <option>It's not handmade, vintage, or a craft supply</option>
            <option>It uses my intellectual property without permission</option>
            <option>It's prohibited or violates policies</option>
            <option>It's a scam or fraudulent</option>
            <option>Other</option>
          </select>
          <Button disabled={!reason} onClick={async () => { await api('/reports', { body: { targetType, targetId, reason } }); setDone(true); }}>Submit report</Button>
        </>
      )}
    </Modal>
  );
}

export default function ListingPage() {
  const { id } = useParams();
  const { user, refresh } = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const adClick = searchParams.get('ad') === '1';
  const { data, error } = useApi(`/listings/${id}${adClick ? '?ad=1' : ''}`);
  const [image, setImage] = useState(0);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [personalization, setPersonalization] = useState('');
  const [cartError, setCartError] = useState<string>();
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [modal, setModal] = useState<'collections' | 'contact' | 'report' | null>(null);
  const [reviewTab, setReviewTab] = useState<'item' | 'shop'>('item');

  useEffect(() => {
    if (!data) return;
    setFavorited(data.favorited);
    setImage(0);
    setSelections({});
    setQuantity(1);
    setPersonalization('');
    setAdded(false);
    rememberViewed(data.listing.id);
  }, [data]);

  const listing: Listing | undefined = data?.listing;
  const price = useMemo(() => (listing ? unitPrice(listing, selections) : 0), [listing, selections]);
  if (error) return <Page><Empty title={error} /></Page>;
  if (!data || !listing) return <Spinner />;
  const shop = data.shop;
  const sale = data.sale;
  const discounted = sale && sale.discountType === 'percent' ? Math.round(price * (1 - sale.value / 100)) : sale?.discountType === 'fixed' ? Math.max(0, price - sale.value) : undefined;
  const unavailable = listing.status !== 'active' || listing.quantity === 0 || shop.vacationMode;

  const addToCart = async (buyNow: boolean) => {
    if (!user) return navigate(`/login?next=/listing/${listing.id}`);
    setBusy(true);
    setCartError(undefined);
    try {
      await api('/cart', { body: { listingId: listing.id, quantity, selections, personalization } });
      await refresh();
      if (buyNow) navigate('/cart');
      else setAdded(true);
    } catch (e) {
      setCartError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <nav className="mb-4 text-sm text-neutral-600">
        <Link to="/" className="hover:underline">Home</Link>
        {data.categoryPath.map((c: { id: string; name: string }) => (
          <span key={c.id}> / <Link to={`/c/${c.id}`} className="hover:underline">{c.name}</Link></span>
        ))}
      </nav>
      {data.isOwner && (
        <div className="mb-4 flex items-center justify-between rounded-xl bg-brand-50 px-4 py-3 text-sm">
          <span>This is your listing ({listing.status.replace('_', ' ')}).</span>
          <Link to={`/seller/listings/${listing.id}`} className="font-semibold underline">Edit listing</Link>
        </div>
      )}
      <div className="grid gap-10 lg:grid-cols-[1fr_420px]">
        <div>
          <div className="flex gap-3">
            <div className="hidden flex-col gap-2 sm:flex">
              {listing.images.map((src, i) => (
                <button key={src + i} onClick={() => setImage(i)} className={`h-16 w-16 overflow-hidden rounded-lg border-2 ${i === image ? 'border-neutral-900' : 'border-transparent'}`}>
                  <img src={src} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
            <div className="relative flex-1 overflow-hidden rounded-2xl bg-neutral-100">
              {listing.images[image] && <img src={listing.images[image]} alt={listing.title} className="aspect-square w-full object-cover" />}
              <button
                onClick={async () => {
                  if (!user) return navigate('/login');
                  const res = await api(`/favorites/${listing.id}`, { body: {} });
                  setFavorited(res.favorited);
                }}
                className="absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-full bg-white shadow"
                aria-label="Favorite"
              >
                <Heart className={`h-5 w-5 ${favorited ? 'fill-red-500 text-red-500' : ''}`} />
              </button>
            </div>
          </div>
          <div className="mt-2 flex gap-2 overflow-x-auto sm:hidden">
            {listing.images.map((src, i) => (
              <button key={src + i} onClick={() => setImage(i)} className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 ${i === image ? 'border-neutral-900' : 'border-transparent'}`}>
                <img src={src} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>

          <section className="mt-10 hidden lg:block">
            <div className="mb-2 flex items-center gap-6 border-b">
              <button onClick={() => setReviewTab('item')} className={`border-b-2 pb-2 text-sm font-semibold ${reviewTab === 'item' ? 'border-neutral-900' : 'border-transparent text-neutral-500'}`}>
                Reviews for this item ({data.reviewCount})
              </button>
              <button onClick={() => setReviewTab('shop')} className={`border-b-2 pb-2 text-sm font-semibold ${reviewTab === 'shop' ? 'border-neutral-900' : 'border-transparent text-neutral-500'}`}>
                Reviews for this shop ({shop.reviewCount})
              </button>
            </div>
            <ReviewList reviews={reviewTab === 'item' ? data.reviews : data.shopReviews} />
          </section>
        </div>

        <div className="space-y-5">
          {data.inCarts > 1 && <p className="text-sm font-semibold text-red-700">In {data.inCarts} carts</p>}
          <div>
            {discounted !== undefined ? <Price price={price} salePrice={discounted} className="text-2xl" /> : <span className="text-2xl font-bold">{formatMoney(price)}</span>}
            {sale?.endsAt && <p className="text-sm text-green-700">Sale ends {formatDate(sale.endsAt)}</p>}
          </div>
          <h1 className="text-xl leading-snug">{listing.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link to={`/shop/${shop.slug}`} className="font-semibold underline">{shop.name}</Link>
            {shop.reviewCount > 0 && <Stars rating={shop.rating} count={shop.reviewCount} />}
            {shop.starSeller && <StarSellerBadge />}
          </div>
          {shop.vacationMode && <div className="rounded-lg bg-amber-50 p-3 text-sm">This shop is on vacation. {shop.vacationMessage}</div>}

          {listing.variations.map((v) => (
            <div key={v.name}>
              <label className="label">{v.name}</label>
              <select className="input" value={selections[v.name] ?? ''} onChange={(e) => setSelections({ ...selections, [v.name]: e.target.value })}>
                <option value="">Select an option</option>
                {v.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.value} {o.priceDelta ? `(${o.priceDelta > 0 ? '+' : '−'}${formatMoney(Math.abs(o.priceDelta))})` : ''}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {listing.quantity > 1 && !listing.isDigital && (
            <div>
              <label className="label">Quantity</label>
              <select className="input" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))}>
                {Array.from({ length: Math.min(listing.quantity, 20) }, (_, i) => i + 1).map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </div>
          )}
          {listing.personalization.enabled && (
            <div>
              <label className="label">Add your personalization {listing.personalization.required ? '' : '(optional)'}</label>
              <p className="mb-1 text-xs text-neutral-600">{listing.personalization.instructions}</p>
              <textarea className="input" maxLength={1024} value={personalization} onChange={(e) => setPersonalization(e.target.value)} />
            </div>
          )}
          <ErrorNote message={cartError} />
          {!data.isOwner && (
            <div className="space-y-2">
              {unavailable ? (
                <Button disabled className="w-full">Sold out</Button>
              ) : (
                <>
                  <Button variant="secondary" className="w-full" loading={busy} onClick={() => addToCart(true)}>Buy it now</Button>
                  <Button className="w-full" loading={busy} onClick={() => addToCart(false)}>
                    <ShoppingCart className="h-4 w-4" /> Add to cart
                  </Button>
                </>
              )}
              {added && (
                <p className="flex items-center justify-between rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
                  Added to your cart <Link to="/cart" className="font-semibold underline">View cart</Link>
                </p>
              )}
              {user && (
                <button className="flex w-full items-center justify-center gap-2 rounded-full py-2 text-sm font-semibold hover:bg-neutral-100" onClick={() => setModal('collections')}>
                  <FolderPlus className="h-4 w-4" /> Add to collection
                </button>
              )}
            </div>
          )}
          {listing.quantity > 0 && listing.quantity <= 3 && !listing.isDigital && <p className="text-sm font-semibold text-red-700">Only {listing.quantity} left</p>}

          <ul className="space-y-2 text-sm">
            {listing.type === 'handmade' && <li className="flex gap-2"><Gift className="h-4 w-4" /> Handmade item</li>}
            {listing.type === 'vintage' && <li className="flex gap-2"><Gift className="h-4 w-4" /> Vintage item</li>}
            {listing.type === 'supplies' && <li className="flex gap-2"><Gift className="h-4 w-4" /> Craft supply</li>}
            {listing.isDigital && <li className="flex gap-2"><Package className="h-4 w-4" /> Digital download — available instantly after purchase</li>}
            {listing.materials.length > 0 && <li>Materials: {listing.materials.join(', ')}</li>}
          </ul>

          <details open className="border-t pt-4">
            <summary className="cursor-pointer font-semibold">Description</summary>
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed">{listing.description}</p>
          </details>
          {!listing.isDigital && (
            <details open className="border-t pt-4">
              <summary className="cursor-pointer font-semibold">Shipping and return policies</summary>
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex gap-2"><Truck className="h-4 w-4 shrink-0" /> Ships within {listing.shipping.processingDays} business days</li>
                <li className="flex gap-2"><MapPin className="h-4 w-4 shrink-0" /> Ships from {listing.shipping.shipsFrom}</li>
                <li className="flex gap-2"><Package className="h-4 w-4 shrink-0" /> {listing.shipping.freeShipping ? 'FREE shipping' : `Shipping: ${formatMoney(listing.shipping.cost)}`}</li>
                <li className="flex gap-2"><RotateCcw className="h-4 w-4 shrink-0" /> {shop.policies.acceptsReturns ? `Returns & exchanges accepted within ${shop.policies.returnWindowDays} days` : 'Returns not accepted'}</li>
              </ul>
            </details>
          )}
          <div className="card flex items-center gap-4 p-4">
            {shop.logo && <img src={shop.logo} alt="" className="h-14 w-14 rounded-lg object-cover" />}
            <div className="min-w-0 flex-1">
              <Link to={`/shop/${shop.slug}`} className="font-semibold hover:underline">{shop.name}</Link>
              <p className="text-xs text-neutral-600">Owner: {shop.ownerName} · {shop.location}</p>
              <p className="text-xs text-neutral-600">{shop.sales.toLocaleString()} sales</p>
            </div>
          </div>
          {!data.isOwner && (
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => (user ? setModal('contact') : navigate('/login'))}>
                <MessageSquare className="h-4 w-4" /> Message seller
              </Button>
              {user && (
                <button className="rounded-full p-3 hover:bg-neutral-100" aria-label="Report" title="Report this item" onClick={() => setModal('report')}>
                  <Flag className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          {listing.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {listing.tags.map((t) => (
                <Link key={t} to={`/search?q=${encodeURIComponent(t)}`} className="rounded-full bg-neutral-100 px-3 py-1 text-xs hover:bg-neutral-200">{t}</Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <section className="mt-10 lg:hidden">
        <h2 className="mb-2 font-serif text-xl">Reviews ({data.reviewCount})</h2>
        <ReviewList reviews={data.reviews} />
      </section>

      {data.moreFromShop.length > 0 && (
        <section className="mt-14">
          <div className="mb-5 flex items-end justify-between">
            <h2 className="font-serif text-2xl">More from {shop.name}</h2>
            <Link to={`/shop/${shop.slug}`} className="text-sm font-semibold underline">Visit shop</Link>
          </div>
          <ListingGrid cards={data.moreFromShop.slice(0, 4)} />
        </section>
      )}
      {data.similar.length > 0 && (
        <section className="mt-14">
          <h2 className="mb-5 font-serif text-2xl">You may also like</h2>
          <ListingGrid cards={data.similar} />
        </section>
      )}

      {modal === 'collections' && <CollectionsModal listingId={listing.id} onClose={() => setModal(null)} />}
      {modal === 'contact' && <ContactModal shopId={shop.id} shopName={shop.name} listingId={listing.id} onClose={() => setModal(null)} />}
      {modal === 'report' && <ReportModal targetType="listing" targetId={listing.id} onClose={() => setModal(null)} />}
    </Page>
  );
}

export { ContactModal };
