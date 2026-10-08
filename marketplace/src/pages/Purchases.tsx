import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Download, MessageSquare, Truck } from 'lucide-react';
import { useApi } from '../useApi.ts';
import { api } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { Button, Empty, ErrorNote, ImageUploader, Spinner, StatusPill, formatDate } from '../components/ui.tsx';
import { ContactModal } from './Listing.tsx';
import { formatMoney } from '../../shared/config.ts';

function ReviewForm({ orderId, item, existing, onDone }: { orderId: string; item: any; existing?: any; onDone: () => void }) {
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [text, setText] = useState(existing?.text ?? '');
  const [images, setImages] = useState<string[]>(existing?.image ? [existing.image] : []);
  const [error, setError] = useState<string>();
  return (
    <div className="mt-3 rounded-lg bg-neutral-50 p-4">
      <p className="mb-2 text-sm font-semibold">{existing ? 'Edit your review' : 'How was this item?'}</p>
      <div className="mb-2 flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onClick={() => setRating(n)} className={`text-2xl ${n <= rating ? 'text-neutral-900' : 'text-neutral-300'}`} aria-label={`${n} stars`}>★</button>
        ))}
      </div>
      <textarea className="input" placeholder="What did you like about it? How was the quality, shipping, and seller communication?" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-2"><ImageUploader images={images} onChange={setImages} max={1} /></div>
      <ErrorNote message={error} />
      <Button
        className="mt-3"
        disabled={!rating}
        onClick={async () => {
          try {
            await api(`/purchases/${orderId}/reviews`, { body: { listingId: item.listingId, rating, text, image: images[0] ?? '' } });
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Post review
      </Button>
    </div>
  );
}

function OrderCard({ order, onChange, detailed }: { order: any; onChange: () => void; detailed?: boolean }) {
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [contact, setContact] = useState(false);
  const canReview = ['shipped', 'delivered', 'completed'].includes(order.status);
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 text-sm">
        <div>
          Purchased from <Link to={`/shop/${order.shop?.slug}`} className="font-semibold underline">{order.shop?.name}</Link> on {formatDate(order.createdAt)}
        </div>
        <div className="flex items-center gap-3">
          <StatusPill status={order.status} />
          <span className="font-bold">{formatMoney(order.total)}</span>
          {!detailed && <Link to={`/purchases/${order.id}`} className="underline">Order #{order.receiptNo}</Link>}
        </div>
      </div>
      {order.tracking && (
        <p className="mt-3 flex items-center gap-2 text-sm"><Truck className="h-4 w-4" /> Shipped {formatDate(order.shippedAt)} · {order.tracking.carrier} {order.tracking.number}</p>
      )}
      {order.status === 'paid' && <p className="mt-3 text-sm text-neutral-600">Estimated to ship by {formatDate(order.expectedShipBy)}</p>}
      <div className="divide-y">
        {order.items.map((item: any) => {
          const review = order.reviews.find((r: any) => r.listingId === item.listingId);
          return (
            <div key={item.listingId} className="py-4">
              <div className="flex gap-4">
                <Link to={`/listing/${item.listingId}`} className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-neutral-100">
                  {item.image && <img src={item.image} alt="" className="h-full w-full object-cover" />}
                </Link>
                <div className="flex-1 text-sm">
                  <Link to={`/listing/${item.listingId}`} className="hover:underline">{item.title}</Link>
                  <p className="text-neutral-600">{item.quantity} × {formatMoney(item.unitPrice)}</p>
                  {Object.entries(item.selections).map(([k, v]) => <p key={k} className="text-xs text-neutral-600">{k}: {String(v)}</p>)}
                  {item.personalization && <p className="text-xs text-neutral-600">Personalization: {item.personalization}</p>}
                  {item.digitalFileUrl && (
                    <a href={item.digitalFileUrl} download className="mt-2 inline-flex items-center gap-1 rounded-full bg-neutral-900 px-3 py-1 text-xs font-semibold text-white"><Download className="h-3 w-3" /> Download files</a>
                  )}
                  {review && reviewing !== item.listingId && (
                    <p className="mt-2 text-xs">Your review: {'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)} {review.text} <button className="underline" onClick={() => setReviewing(item.listingId)}>Edit</button></p>
                  )}
                  {canReview && !review && reviewing !== item.listingId && (
                    <button className="mt-2 rounded-full border px-3 py-1 text-xs font-semibold hover:bg-neutral-100" onClick={() => setReviewing(item.listingId)}>Write a review</button>
                  )}
                </div>
              </div>
              {reviewing === item.listingId && <ReviewForm orderId={order.id} item={item} existing={review} onDone={() => { setReviewing(null); onChange(); }} />}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2 border-t pt-3">
        {order.status === 'shipped' && (
          <Button variant="secondary" className="!py-1.5" onClick={async () => { await api(`/purchases/${order.id}/received`, { body: {} }); onChange(); }}>
            <CheckCircle2 className="h-4 w-4" /> Mark as received
          </Button>
        )}
        <Button variant="ghost" className="!py-1.5" onClick={() => setContact(true)}><MessageSquare className="h-4 w-4" /> Contact shop</Button>
      </div>
      {detailed && (
        <div className="mt-4 grid gap-6 border-t pt-4 text-sm sm:grid-cols-2">
          <div>
            <p className="font-semibold">Ship to</p>
            <p className="whitespace-pre-line text-neutral-700">{[order.shippingAddress.name, order.shippingAddress.line1, order.shippingAddress.line2, `${order.shippingAddress.city} ${order.shippingAddress.state ?? ''} ${order.shippingAddress.postalCode}`, order.shippingAddress.country].filter(Boolean).join('\n')}</p>
            {order.isGift && <p className="mt-2">🎁 Gift{order.giftMessage && `: “${order.giftMessage}”`}</p>}
          </div>
          <dl className="space-y-1">
            <div className="flex justify-between"><dt>Item total</dt><dd>{formatMoney(order.subtotal)}</dd></div>
            {order.discount > 0 && <div className="flex justify-between text-green-700"><dt>Discount {order.couponCode && `(${order.couponCode})`}</dt><dd>−{formatMoney(order.discount)}</dd></div>}
            <div className="flex justify-between"><dt>Shipping</dt><dd>{formatMoney(order.shipping)}</dd></div>
            <div className="flex justify-between border-t pt-1 font-bold"><dt>Order total</dt><dd>{formatMoney(order.total)}</dd></div>
          </dl>
        </div>
      )}
      {contact && order.shop && <ContactModal shopId={order.shop.id} shopName={order.shop.name} onClose={() => setContact(false)} />}
    </div>
  );
}

export function Purchases() {
  const { data, reload } = useApi<any[]>('/purchases');
  const [params] = useSearchParams();
  if (!data) return <Spinner />;
  return (
    <Page narrow>
      <h1 className="mb-6 font-serif text-3xl">Purchases</h1>
      {params.get('placed') && <div className="mb-6 rounded-xl bg-green-50 p-4 text-green-900">Thank you! Your order{params.get('placed') !== '1' ? 's have' : ' has'} been placed. The seller has been notified.</div>}
      {data.length === 0 ? <Empty title="No purchases yet"><Link to="/" className="underline">Start shopping</Link></Empty> : <div className="space-y-6">{data.map((o) => <OrderCard key={o.id} order={o} onChange={reload} />)}</div>}
    </Page>
  );
}

export function PurchaseDetail() {
  const { id } = useParams();
  const { data, error, reload } = useApi(`/purchases/${id}`);
  if (error) return <Page><Empty title={error} /></Page>;
  if (!data) return <Spinner />;
  return (
    <Page narrow>
      <Link to="/purchases" className="text-sm underline">← All purchases</Link>
      <h1 className="mb-6 mt-2 font-serif text-3xl">Order #{data.receiptNo}</h1>
      <OrderCard order={data} onChange={reload} detailed />
    </Page>
  );
}
