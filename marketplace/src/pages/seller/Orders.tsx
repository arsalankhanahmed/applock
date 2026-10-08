import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Gift, MessageSquare, Printer, Truck } from 'lucide-react';
import { useApi } from '../../useApi.ts';
import { api } from '../../api.ts';
import { Button, Empty, ErrorNote, Modal, Spinner, StatusPill, formatDate } from '../../components/ui.tsx';
import { formatMoney } from '../../../shared/config.ts';

const FILTERS = [
  ['', 'All'],
  ['paid', 'New'],
  ['shipped', 'Shipped'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
  ['refunded', 'Refunded'],
];

export function Orders() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const { data } = useApi<any[]>(`/seller/orders${status ? `?status=${status}` : ''}`);
  return (
    <div>
      <h1 className="mb-6 font-serif text-3xl">Orders & shipping</h1>
      <div className="no-scrollbar mb-4 flex gap-2 overflow-x-auto">
        {FILTERS.map(([v, l]) => (
          <button key={v} onClick={() => setParams(v ? { status: v } : {})} className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-semibold ${status === v ? 'bg-neutral-900 text-white' : 'border hover:bg-neutral-100'}`}>{l}</button>
        ))}
      </div>
      {!data ? <Spinner /> : data.length === 0 ? <Empty title="No orders here" /> : (
        <div className="divide-y rounded-xl border">
          {data.map((o) => {
            const late = o.status === 'paid' && new Date(o.expectedShipBy) < new Date();
            return (
              <Link key={o.id} to={`/seller/orders/${o.id}`} className="flex flex-wrap items-center gap-4 p-4 hover:bg-neutral-50">
                <div className="flex -space-x-3">
                  {o.items.slice(0, 3).map((i: any) => <img key={i.listingId} src={i.image} alt="" className="h-12 w-12 rounded-lg border-2 border-white object-cover" />)}
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-semibold">#{o.receiptNo} · {o.buyer?.name}</p>
                  <p className="line-clamp-1 text-neutral-600">{o.items.map((i: any) => `${i.quantity}× ${i.title}`).join(', ')}</p>
                  <p className={`text-xs ${late ? 'font-semibold text-red-700' : 'text-neutral-500'}`}>
                    Ordered {formatDate(o.createdAt)}{o.status === 'paid' && ` · Ship by ${formatDate(o.expectedShipBy)}`}
                    {o.isGift && ' · 🎁 Gift'}
                  </p>
                </div>
                <StatusPill status={o.status} />
                <span className="font-bold">{formatMoney(o.total)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function OrderDetail() {
  const { id } = useParams();
  const { data, error, setData } = useApi(`/seller/orders/${id}`);
  const [modal, setModal] = useState<'ship' | 'refund' | null>(null);
  const [tracking, setTracking] = useState({ carrier: '', trackingNumber: '' });
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string>();
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Spinner />;
  const o = data;
  const run = async (path: string, body: object) => {
    setActionError(undefined);
    try {
      setData(await api(`/seller/orders/${o.id}/${path}`, { body }));
      setModal(null);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };
  const a = o.shippingAddress;
  return (
    <div className="space-y-6">
      <Link to="/seller/orders" className="text-sm underline">← All orders</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-serif text-3xl">Order #{o.receiptNo}</h1>
        <StatusPill status={o.status} />
      </div>
      <ErrorNote message={actionError} />
      <div className="flex flex-wrap gap-2 print:hidden">
        {o.status === 'paid' && <Button onClick={() => setModal('ship')}><Truck className="h-4 w-4" /> Mark as shipped</Button>}
        {(o.status === 'shipped' || o.status === 'delivered') && <Button onClick={() => run('complete', {})}>Mark as complete</Button>}
        {!['cancelled', 'refunded'].includes(o.status) && <Button variant="secondary" onClick={() => setModal('refund')}>{o.status === 'paid' ? 'Cancel order' : 'Issue refund'}</Button>}
        <Button variant="ghost" onClick={() => window.print()}><Printer className="h-4 w-4" /> Packing slip</Button>
        {o.buyer && <Link to="/messages" className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-neutral-100"><MessageSquare className="h-4 w-4" /> Messages</Link>}
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="card divide-y p-5">
          {o.items.map((i: any) => (
            <div key={i.listingId} className="flex gap-4 py-3">
              <img src={i.image} alt="" className="h-20 w-20 rounded-lg object-cover" />
              <div className="flex-1 text-sm">
                <p className="font-medium">{i.title}</p>
                <p>Quantity: {i.quantity}{!o.isGift && ` × ${formatMoney(i.unitPrice)}`}</p>
                {Object.entries(i.selections).map(([k, v]) => <p key={k}>{k}: <b>{String(v)}</b></p>)}
                {i.personalization && <p className="mt-1 rounded bg-amber-50 p-2">Personalization: <b>{i.personalization}</b></p>}
                {i.isDigital && <p className="text-xs text-neutral-500">Digital download — delivered automatically</p>}
              </div>
            </div>
          ))}
          {o.noteToSeller && <p className="py-3 text-sm"><b>Note from buyer:</b> {o.noteToSeller}</p>}
          {o.isGift && <p className="flex items-center gap-2 py-3 text-sm"><Gift className="h-4 w-4" /> Gift order{o.giftMessage && `: “${o.giftMessage}”`}</p>}
        </div>
        <div className="space-y-4">
          <div className="card p-5 text-sm">
            <p className="mb-2 font-semibold">Ship to</p>
            <p>{a.name}<br />{a.line1}{a.line2 && <><br />{a.line2}</>}<br />{a.city} {a.state} {a.postalCode}<br />{a.country}</p>
            {o.tracking && <p className="mt-3">Tracking: {o.tracking.carrier} {o.tracking.number}</p>}
            {o.status === 'paid' && <p className="mt-3 text-neutral-600">Ship by {formatDate(o.expectedShipBy)}</p>}
          </div>
          <div className="card p-5 text-sm print:hidden">
            <p className="mb-2 font-semibold">Payment</p>
            <dl className="space-y-1">
              <div className="flex justify-between"><dt>Items</dt><dd>{formatMoney(o.subtotal)}</dd></div>
              {o.discount > 0 && <div className="flex justify-between"><dt>Discount {o.couponCode && `(${o.couponCode})`}</dt><dd>−{formatMoney(o.discount)}</dd></div>}
              <div className="flex justify-between"><dt>Shipping</dt><dd>{formatMoney(o.shipping)}</dd></div>
              <div className="flex justify-between font-semibold"><dt>Buyer paid</dt><dd>{formatMoney(o.total)}</dd></div>
              <div className="flex justify-between text-neutral-600"><dt>Transaction fee</dt><dd>−{formatMoney(o.fees.transactionFee)}</dd></div>
              <div className="flex justify-between text-neutral-600"><dt>Processing fee</dt><dd>−{formatMoney(o.fees.processingFee)}</dd></div>
              {o.fees.listingRenewalFees > 0 && <div className="flex justify-between text-neutral-600"><dt>Listing renewals</dt><dd>−{formatMoney(o.fees.listingRenewalFees)}</dd></div>}
              <div className="flex justify-between border-t pt-1 font-bold"><dt>Your earnings</dt><dd>{formatMoney(o.net)}</dd></div>
            </dl>
          </div>
          {o.reviews.length > 0 && (
            <div className="card p-5 text-sm">
              <p className="mb-2 font-semibold">Buyer review</p>
              {o.reviews.map((r: any) => <p key={r.id}>{'★'.repeat(r.rating)} {r.text}</p>)}
            </div>
          )}
        </div>
      </div>
      {modal === 'ship' && (
        <Modal title="Mark as shipped" onClose={() => setModal(null)}>
          <p className="mb-3 text-sm text-neutral-600">Adding tracking keeps your on-time shipping rate up for Star Seller.</p>
          <div className="space-y-3">
            <input className="input" placeholder="Carrier (e.g. TCS, Leopards, DHL)" value={tracking.carrier} onChange={(e) => setTracking({ ...tracking, carrier: e.target.value })} />
            <input className="input" placeholder="Tracking number" value={tracking.trackingNumber} onChange={(e) => setTracking({ ...tracking, trackingNumber: e.target.value })} />
            <Button className="w-full" onClick={() => run('ship', tracking)}>Complete order</Button>
          </div>
        </Modal>
      )}
      {modal === 'refund' && (
        <Modal title={o.status === 'paid' ? 'Cancel order' : 'Refund order'} onClose={() => setModal(null)}>
          <p className="mb-3 text-sm text-neutral-600">The buyer is refunded {formatMoney(o.total)}. Your transaction fee is credited back; the processing fee isn't refundable. Stock is restored.</p>
          <textarea className="input" placeholder="Reason (shared with buyer)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button variant="danger" className="mt-3 w-full" onClick={() => run('refund', { reason })}>Confirm</Button>
        </Modal>
      )}
    </div>
  );
}
