import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Award, Heart, ImagePlus, Loader2, Star, X } from 'lucide-react';
import { api, uploadFile } from '../api.ts';
import { useSession } from '../session.tsx';
import { formatMoney } from '../../shared/config.ts';
import type { ListingCard as Card } from '../../shared/types.ts';

export function Button({
  variant = 'primary',
  loading,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'brand'; loading?: boolean }) {
  const styles = {
    primary: 'bg-neutral-900 text-white hover:bg-neutral-700',
    brand: 'bg-brand-600 text-white hover:bg-brand-700',
    secondary: 'border-2 border-neutral-900 bg-white text-neutral-900 hover:bg-neutral-100',
    ghost: 'text-neutral-700 hover:bg-neutral-100',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  }[variant];
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-20">
      <Loader2 className="h-8 w-8 animate-spin text-neutral-400" />
    </div>
  );
}

export function ErrorNote({ message }: { message?: string }) {
  if (!message) return null;
  return <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-neutral-300 px-6 py-14 text-center">
      <p className="font-serif text-xl">{title}</p>
      {children && <div className="mt-3 text-sm text-neutral-600">{children}</div>}
    </div>
  );
}

export function Stars({ rating, count, size = 14 }: { rating: number; count?: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star key={i} width={size} height={size} className={i <= Math.round(rating) ? 'fill-neutral-900 text-neutral-900' : 'text-neutral-300'} />
        ))}
      </span>
      {count !== undefined && <span className="text-xs text-neutral-600">({count})</span>}
    </span>
  );
}

export function Price({ price, salePrice, className = '' }: { price: number; salePrice?: number; className?: string }) {
  if (salePrice !== undefined && salePrice < price) {
    const pct = Math.round(((price - salePrice) / price) * 100);
    return (
      <span className={`inline-flex flex-wrap items-baseline gap-x-2 ${className}`}>
        <span className="font-bold text-green-700">{formatMoney(salePrice)}</span>
        <span className="text-sm text-neutral-500 line-through">{formatMoney(price)}</span>
        <span className="text-sm text-neutral-600">({pct}% off)</span>
      </span>
    );
  }
  return <span className={`font-bold ${className}`}>{formatMoney(price)}</span>;
}

export function StarSellerBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-800">
      <Award className="h-3 w-3" /> Star Seller
    </span>
  );
}

export function FavoriteButton({ listingId, initial, className = '' }: { listingId: string; initial?: boolean; className?: string }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const [on, setOn] = useState(Boolean(initial));
  return (
    <button
      aria-label={on ? 'Remove from favorites' : 'Add to favorites'}
      className={`grid h-9 w-9 place-items-center rounded-full bg-white shadow-md transition hover:scale-110 ${className}`}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!user) return navigate('/login');
        const res = await api(`/favorites/${listingId}`, { body: {} });
        setOn(res.favorited);
      }}
    >
      <Heart className={`h-4 w-4 ${on ? 'fill-red-500 text-red-500' : 'text-neutral-700'}`} />
    </button>
  );
}

export function ListingCard({ card }: { card: Card & { soldOut?: boolean; available?: boolean } }) {
  const unavailable = card.soldOut || card.available === false;
  return (
    <Link to={`/listing/${card.id}${card.promoted ? '?ad=1' : ''}`} className="group block">
      <div className="relative aspect-square overflow-hidden rounded-xl bg-neutral-100">
        {card.image && <img src={card.image} alt={card.title} className={`h-full w-full object-cover transition duration-300 group-hover:scale-105 ${unavailable ? 'opacity-50' : ''}`} loading="lazy" />}
        <FavoriteButton listingId={card.id} initial={card.favorited} className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 max-md:opacity-100" />
        {unavailable && <span className="absolute left-2 top-2 rounded-full bg-white px-2 py-0.5 text-xs font-semibold">Sold out</span>}
        {card.isDigital && !unavailable && <span className="absolute bottom-2 left-2 rounded-full bg-white/90 px-2 py-0.5 text-xs font-medium">Digital download</span>}
      </div>
      <div className="mt-2 space-y-0.5">
        <p className="line-clamp-1 text-sm text-neutral-800">{card.title}</p>
        <div className="flex items-center gap-1 text-xs">
          {card.reviewCount > 0 && <Stars rating={card.rating} count={card.reviewCount} size={11} />}
          {card.starSeller && <Award className="h-3.5 w-3.5 text-purple-700" aria-label="Star Seller" />}
        </div>
        <Price price={card.price} salePrice={card.salePrice} className="text-sm" />
        {card.freeShipping && !card.isDigital && <p className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">FREE shipping</p>}
        <p className="text-xs text-neutral-500">
          {card.promoted ? 'Ad by ' : ''}
          {card.shopName}
        </p>
      </div>
    </Link>
  );
}

export function ListingGrid({ cards, cols = 'lg:grid-cols-4' }: { cards: Card[]; cols?: string }) {
  return (
    <div className={`grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 ${cols}`}>
      {cards.map((c) => (
        <ListingCard key={c.id + (c.promoted ? '-ad' : '')} card={c} />
      ))}
    </div>
  );
}

export function ImageUploader({ images, onChange, max = 10 }: { images: string[]; onChange: (next: string[]) => void; max?: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
        {images.map((src, i) => (
          <div key={src + i} className="group relative aspect-square overflow-hidden rounded-lg border bg-neutral-100">
            <img src={src} alt="" className="h-full w-full object-cover" />
            {i === 0 && <span className="absolute left-1 top-1 rounded bg-white px-1.5 text-xs font-semibold">Primary</span>}
            <button type="button" onClick={() => onChange(images.filter((_, j) => j !== i))} className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-white shadow" aria-label="Remove photo">
              <X className="h-3 w-3" />
            </button>
            {i > 0 && (
              <button type="button" onClick={() => onChange([src, ...images.filter((_, j) => j !== i)])} className="absolute bottom-1 left-1 hidden rounded bg-white px-1.5 text-xs group-hover:block">
                Make primary
              </button>
            )}
          </div>
        ))}
        {images.length < max && (
          <label className="flex aspect-square cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-neutral-300 text-xs text-neutral-600 hover:border-neutral-900">
            {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <ImagePlus className="h-6 w-6" />}
            <span className="mt-1">Add photo</span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []).slice(0, max - images.length);
                e.target.value = '';
                if (!files.length) return;
                setBusy(true);
                setError(undefined);
                try {
                  const urls = await Promise.all(files.map(uploadFile));
                  onChange([...images, ...urls]);
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-6 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-serif text-xl">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1 hover:bg-neutral-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const color: Record<string, string> = {
    active: 'bg-green-100 text-green-800',
    paid: 'bg-amber-100 text-amber-800',
    shipped: 'bg-blue-100 text-blue-800',
    delivered: 'bg-teal-100 text-teal-800',
    completed: 'bg-green-100 text-green-800',
    cancelled: 'bg-neutral-200 text-neutral-700',
    refunded: 'bg-neutral-200 text-neutral-700',
    draft: 'bg-neutral-200 text-neutral-700',
    inactive: 'bg-neutral-200 text-neutral-700',
    sold_out: 'bg-red-100 text-red-800',
    expired: 'bg-red-100 text-red-800',
    open: 'bg-amber-100 text-amber-800',
    resolved: 'bg-green-100 text-green-800',
    dismissed: 'bg-neutral-200 text-neutral-700',
  };
  const label = status === 'paid' ? 'Not shipped' : status.replace('_', ' ');
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${color[status] ?? 'bg-neutral-100'}`}>{label}</span>;
}

export function formatDate(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Text input for money that stores integer cents. */
export function MoneyInput({ value, onChange, id }: { value: number; onChange: (cents: number) => void; id?: string }) {
  const [text, setText] = useState((value / 100).toFixed(2));
  return (
    <input
      id={id}
      className="input"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.round(n * 100));
      }}
      onBlur={() => setText((value / 100).toFixed(2))}
    />
  );
}
