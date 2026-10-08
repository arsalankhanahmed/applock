import { Link } from 'react-router-dom';
import { Award, MapPin } from 'lucide-react';
import { useApi } from '../useApi.ts';
import { ListingGrid, Spinner, Stars } from '../components/ui.tsx';
import { useSession } from '../session.tsx';
import { APP_NAME } from '../../shared/config.ts';
import { rootCategories } from '../../shared/categories.ts';
import type { ListingCard } from '../../shared/types.ts';

const CATEGORY_EMOJI: Record<string, string> = {
  jewelry: '💍', clothing: '👗', home: '🏡', wedding: '💐', toys: '🧸', art: '🎨', 'craft-supplies': '🧵', vintage: '📻', gifts: '🎁',
};

function Section({ title, link, cards }: { title: string; link?: string; cards: ListingCard[] }) {
  if (!cards.length) return null;
  return (
    <section className="mt-14">
      <div className="mb-5 flex items-end justify-between">
        <h2 className="font-serif text-2xl">{title}</h2>
        {link && <Link to={link} className="text-sm font-semibold underline">See more</Link>}
      </div>
      <ListingGrid cards={cards} />
    </section>
  );
}

export default function Home() {
  const { user } = useSession();
  const { data } = useApi('/home');
  return (
    <div className="mx-auto max-w-7xl px-4">
      <section className="-mx-4 bg-brand-50 px-4 pb-10 pt-8 text-center">
        <h1 className="font-serif text-3xl sm:text-4xl">{user ? `Welcome back, ${user.name.split(' ')[0]}!` : 'Find things you’ll love. Support independent sellers.'}</h1>
        <div className="mx-auto mt-8 flex max-w-4xl flex-wrap justify-center gap-4">
          {rootCategories().map((c) => (
            <Link key={c.id} to={`/c/${c.id}`} className="group w-24 text-center">
              <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-white text-4xl shadow-sm transition group-hover:shadow-md">{CATEGORY_EMOJI[c.id] ?? '🛍'}</div>
              <p className="mt-2 text-xs font-semibold leading-tight">{c.name}</p>
            </Link>
          ))}
        </div>
      </section>
      {!data ? (
        <Spinner />
      ) : (
        <>
          {data.recentlyFavorited.length > 0 && <Section title="Because you favorited these" link="/favorites" cards={data.recentlyFavorited} />}
          <Section title="Popular right now" link="/search?sort=relevance" cards={data.popular} />
          <Section title="Big sales on now" link="/search?onSale=1" cards={data.onSale} />
          <Section title="Fresh from the workshop" link="/search?sort=newest" cards={data.fresh} />
          <Section title="Vintage finds" link="/search?type=vintage" cards={data.vintage} />
          <section className="mt-14">
            <h2 className="mb-5 font-serif text-2xl">Shops we think you'll love</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.shops.map((s: any) => (
                <Link key={s.id} to={`/shop/${s.slug}`} className="card overflow-hidden transition hover:shadow-md">
                  <div className="h-24 bg-neutral-100">{s.banner && <img src={s.banner} alt="" className="h-full w-full object-cover" />}</div>
                  <div className="flex items-center gap-3 p-4">
                    <img src={s.logo} alt="" className="-mt-10 h-14 w-14 rounded-lg border-4 border-white bg-white object-cover" />
                    <div className="min-w-0">
                      <p className="flex items-center gap-1 font-semibold">{s.name} {s.starSeller && <Award className="h-4 w-4 text-purple-700" />}</p>
                      <p className="truncate text-xs text-neutral-600">{s.tagline}</p>
                      <p className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
                        {s.reviewCount > 0 && <Stars rating={s.rating} count={s.reviewCount} size={10} />}
                        <span className="inline-flex items-center gap-0.5"><MapPin className="h-3 w-3" />{s.location}</span>
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
          <section className="mt-14 rounded-2xl bg-neutral-900 p-8 text-center text-white">
            <h2 className="font-serif text-2xl">Got a craft? Start selling on {APP_NAME}</h2>
            <p className="mt-2 text-neutral-300">Open your shop in minutes. Only pay when you list and when you sell.</p>
            <Link to="/sell" className="mt-5 inline-block rounded-full bg-white px-6 py-2.5 font-semibold text-neutral-900">Get started</Link>
          </section>
        </>
      )}
    </div>
  );
}
