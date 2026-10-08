import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../useApi.ts';
import { api } from '../../api.ts';
import { Button, Empty, Spinner, Stars, formatDate } from '../../components/ui.tsx';

export default function Reviews() {
  const { data, reload } = useApi<any[]>('/seller/reviews');
  const [replying, setReplying] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  if (!data) return <Spinner />;
  const avg = data.length ? data.reduce((s, r) => s + r.rating, 0) / data.length : 0;
  return (
    <div>
      <h1 className="mb-2 font-serif text-3xl">Reviews</h1>
      {data.length > 0 && <p className="mb-6 flex items-center gap-2 text-sm"><Stars rating={avg} /> {avg.toFixed(1)} average from {data.length} reviews</p>}
      {data.length === 0 ? <Empty title="No reviews yet">Reviews appear here once buyers rate their orders.</Empty> : (
        <div className="divide-y rounded-xl border">
          {data.map((r) => (
            <div key={r.id} className="p-4 text-sm">
              <div className="flex justify-between"><Stars rating={r.rating} /><span className="text-xs text-neutral-500">{formatDate(r.createdAt)}</span></div>
              <p className="mt-2">{r.text || <span className="italic text-neutral-500">No written review</span>}</p>
              <p className="mt-1 text-xs text-neutral-500">{r.buyerName} · <Link to={`/listing/${r.listingId}`} className="underline">{r.listingTitle}</Link></p>
              {r.sellerReply && replying !== r.id && <p className="mt-2 rounded bg-neutral-50 p-2"><b>Your reply:</b> {r.sellerReply}</p>}
              {replying === r.id ? (
                <div className="mt-2 space-y-2">
                  <textarea className="input" value={reply} onChange={(e) => setReply(e.target.value)} />
                  <div className="flex gap-2">
                    <Button onClick={async () => { await api(`/seller/reviews/${r.id}/reply`, { body: { reply } }); setReplying(null); reload(); }}>Post reply</Button>
                    <Button variant="ghost" onClick={() => setReplying(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <button className="mt-2 text-xs font-semibold underline" onClick={() => { setReplying(r.id); setReply(r.sellerReply ?? ''); }}>{r.sellerReply ? 'Edit reply' : 'Reply'}</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
