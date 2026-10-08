import { Link, useParams } from 'react-router-dom';
import { useApi } from '../useApi.ts';
import { Page } from '../components/Layout.tsx';
import { Empty, ListingGrid, Spinner, formatDate } from '../components/ui.tsx';

export default function PersonPage() {
  const { id } = useParams();
  const { data, error } = useApi(`/people/${id}`);
  if (error) return <Page><Empty title={error} /></Page>;
  if (!data) return <Spinner />;
  return (
    <Page>
      <div className="flex items-center gap-5">
        {data.avatar ? <img src={data.avatar} alt="" className="h-24 w-24 rounded-full object-cover" /> : <div className="h-24 w-24 rounded-full bg-neutral-200" />}
        <div>
          <h1 className="font-serif text-3xl">{data.name}</h1>
          <p className="text-sm text-neutral-500">Joined {formatDate(data.joined)}</p>
          {data.shop && <p className="mt-1 text-sm">Owner of <Link to={`/shop/${data.shop.slug}`} className="font-semibold underline">{data.shop.name}</Link></p>}
        </div>
      </div>
      {data.bio && <p className="mt-6 max-w-2xl whitespace-pre-line">{data.bio}</p>}
      <h2 className="mb-4 mt-10 font-serif text-2xl">Collections</h2>
      {data.collections.length === 0 && <p className="text-sm text-neutral-500">No public collections.</p>}
      <div className="space-y-10">
        {data.collections.map((c: any) => (
          <section key={c.id}>
            <h3 className="mb-3 text-lg font-semibold">{c.name}</h3>
            {c.listings.length ? <ListingGrid cards={c.listings} cols="lg:grid-cols-6" /> : <p className="text-sm text-neutral-500">Empty collection</p>}
          </section>
        ))}
      </div>
    </Page>
  );
}
