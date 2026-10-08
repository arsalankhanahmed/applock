import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { BarChart3, ExternalLink, Megaphone, Package, Settings, Star, Tag, Wallet } from 'lucide-react';
import { useSession } from '../../session.tsx';
import { useApi } from '../../useApi.ts';
import { Spinner } from '../../components/ui.tsx';
import Dashboard from './Dashboard.tsx';
import Listings from './Listings.tsx';
import ListingEditor from './ListingEditor.tsx';
import { OrderDetail, Orders } from './Orders.tsx';
import Reviews from './Reviews.tsx';
import Marketing from './Marketing.tsx';
import Finances from './Finances.tsx';
import ShopSettings from './ShopSettings.tsx';

const NAV = [
  ['', 'Dashboard', BarChart3],
  ['listings', 'Listings', Tag],
  ['orders', 'Orders & shipping', Package],
  ['reviews', 'Reviews', Star],
  ['marketing', 'Marketing', Megaphone],
  ['finances', 'Finances', Wallet],
  ['settings', 'Settings', Settings],
] as const;

export default function SellerApp() {
  const { user } = useSession();
  const { data } = useApi(user?.shopId ? '/seller/shop' : null);
  if (!user?.shopId) return <Navigate to="/sell" replace />;
  if (!data) return <Spinner />;
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 md:flex-row">
      <aside className="shrink-0 md:w-56">
        <div className="mb-4 flex items-center gap-3">
          {data.shop.logo ? <img src={data.shop.logo} className="h-10 w-10 rounded-lg object-cover" alt="" /> : <div className="h-10 w-10 rounded-lg bg-neutral-200" />}
          <div className="min-w-0">
            <p className="truncate font-semibold">{data.shop.name}</p>
            <a href={`/shop/${data.shop.slug}`} className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:underline">View shop <ExternalLink className="h-3 w-3" /></a>
          </div>
        </div>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map(([path, label, Icon]) => (
            <NavLink
              key={path}
              end={path === ''}
              to={`/seller/${path}`}
              className={({ isActive }) => `flex items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-neutral-900 text-white' : 'hover:bg-neutral-100'}`}
            >
              <Icon className="h-4 w-4" /> {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="listings" element={<Listings />} />
          <Route path="listings/new" element={<ListingEditor />} />
          <Route path="listings/:id" element={<ListingEditor />} />
          <Route path="orders" element={<Orders />} />
          <Route path="orders/:id" element={<OrderDetail />} />
          <Route path="reviews" element={<Reviews />} />
          <Route path="marketing" element={<Marketing />} />
          <Route path="finances" element={<Finances />} />
          <Route path="settings" element={<ShopSettings />} />
        </Routes>
      </div>
    </div>
  );
}
