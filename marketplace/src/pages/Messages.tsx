import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Send } from 'lucide-react';
import { useApi } from '../useApi.ts';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';
import { Page } from '../components/Layout.tsx';
import { Empty, Spinner } from '../components/ui.tsx';
import { formatMoney } from '../../shared/config.ts';

function Thread({ id, onSent }: { id: string; onSent: () => void }) {
  const { data, reload } = useApi(`/conversations/${id}`);
  const { refresh } = useSession();
  const [body, setBody] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
    if (data) {
      refresh();
      onSent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  useEffect(() => {
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [reload]);
  if (!data) return <Spinner />;
  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-4">
        <p className="font-semibold">{data.conversation.otherName}</p>
        <p className="text-sm text-neutral-600">{data.conversation.subject}</p>
        {data.listing && (
          <Link to={`/listing/${data.listing.id}`} className="mt-2 flex items-center gap-2 text-sm">
            {data.listing.image && <img src={data.listing.image} className="h-10 w-10 rounded object-cover" alt="" />}
            <span className="underline">{data.listing.title}</span> · {formatMoney(data.listing.price)}
          </Link>
        )}
        {data.order && <Link to={data.conversation.role === 'buyer' ? `/purchases/${data.order.id}` : `/seller/orders/${data.order.id}`} className="text-sm underline">Order #{data.order.receiptNo}</Link>}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {data.messages.map((m: any) => (
          <div key={m.id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${m.mine ? 'bg-neutral-900 text-white' : 'bg-neutral-100'}`}>
              <p className="whitespace-pre-line">{m.body}</p>
              <p className={`mt-1 text-[10px] ${m.mine ? 'text-neutral-400' : 'text-neutral-500'}`}>{new Date(m.createdAt).toLocaleString()}</p>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="flex gap-2 border-t p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!body.trim()) return;
          await api(`/conversations/${id}/messages`, { body: { body } });
          setBody('');
          reload();
        }}
      >
        <input className="input" placeholder="Type your message" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-neutral-900 text-white" aria-label="Send"><Send className="h-4 w-4" /></button>
      </form>
    </div>
  );
}

export default function MessagesPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, reload } = useApi<any[]>('/conversations');
  const [filter, setFilter] = useState<'all' | 'buyer' | 'seller'>('all');
  if (!data) return <Spinner />;
  const list = data.filter((c) => filter === 'all' || c.role === filter);
  return (
    <Page>
      <h1 className="mb-6 font-serif text-3xl">Messages</h1>
      {data.length === 0 ? (
        <Empty title="No messages yet">Contact a seller from any listing or shop page.</Empty>
      ) : (
        <div className="card grid h-[70vh] overflow-hidden md:grid-cols-[320px_1fr]">
          <div className={`flex flex-col border-r ${id ? 'max-md:hidden' : ''}`}>
            <div className="flex gap-1 border-b p-2 text-xs">
              {(['all', 'buyer', 'seller'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1 font-semibold ${filter === f ? 'bg-neutral-900 text-white' : 'hover:bg-neutral-100'}`}>
                  {f === 'all' ? 'All' : f === 'buyer' ? 'As buyer' : 'As seller'}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto">
              {list.map((c) => (
                <button key={c.id} onClick={() => navigate(`/messages/${c.id}`)} className={`flex w-full gap-3 border-b p-3 text-left hover:bg-neutral-50 ${c.id === id ? 'bg-neutral-100' : ''}`}>
                  {c.otherAvatar ? <img src={c.otherAvatar} alt="" className="h-10 w-10 rounded-full object-cover" /> : <div className="h-10 w-10 shrink-0 rounded-full bg-neutral-200" />}
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-sm ${c.unread ? 'font-bold' : 'font-medium'}`}>{c.otherName}</p>
                    <p className="truncate text-xs text-neutral-600">{c.subject}</p>
                    <p className="truncate text-xs text-neutral-500">{c.lastMessage}</p>
                  </div>
                  {c.unread > 0 && <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-brand-600" />}
                </button>
              ))}
            </div>
          </div>
          <div className={id ? '' : 'max-md:hidden'}>
            {id ? (
              <>
                <Link to="/messages" className="block border-b p-2 text-sm underline md:hidden">← All conversations</Link>
                <Thread key={id} id={id} onSent={reload} />
              </>
            ) : (
              <div className="grid h-full place-items-center text-sm text-neutral-500">Select a conversation</div>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
