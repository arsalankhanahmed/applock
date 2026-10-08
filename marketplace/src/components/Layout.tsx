import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, Heart, LogOut, Mail, Menu, Package, Search, Settings, Shield, ShoppingCart, Store, User as UserIcon, X } from 'lucide-react';
import { useSession } from '../session.tsx';
import { api } from '../api.ts';
import { APP_NAME, APP_TAGLINE } from '../../shared/config.ts';
import { rootCategories } from '../../shared/categories.ts';
import type { Notification } from '../../shared/types.ts';

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-brand-600 px-1 text-[10px] font-bold text-white">{n > 99 ? '99+' : n}</span>;
}

function SearchBar() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [q, setQ] = useState(params.get('q') ?? '');
  useEffect(() => setQ(params.get('q') ?? ''), [params]);
  return (
    <form
      className="relative flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        navigate(`/search?q=${encodeURIComponent(q.trim())}`);
      }}
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search for anything"
        className="w-full rounded-full border-2 border-neutral-900 py-2 pl-4 pr-12 text-sm outline-none focus:ring-4 focus:ring-brand-100"
      />
      <button className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-brand-600 text-white" aria-label="Search">
        <Search className="h-4 w-4" />
      </button>
    </form>
  );
}

function NotificationsMenu({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Notification[]>();
  const { refresh } = useSession();
  useEffect(() => {
    api<Notification[]>('/notifications').then((n) => {
      setItems(n);
      api('/notifications/read', { body: {} }).then(refresh);
    });
  }, [refresh]);
  return (
    <div className="absolute right-0 top-11 z-40 w-80 rounded-xl border bg-white p-2 shadow-xl">
      <p className="px-2 py-1 text-sm font-semibold">Notifications</p>
      <div className="max-h-96 overflow-y-auto">
        {items?.length === 0 && <p className="px-2 py-6 text-center text-sm text-neutral-500">You're all caught up</p>}
        {items?.map((n) => (
          <Link key={n.id} to={n.link} onClick={onClose} className={`block rounded-lg px-2 py-2 text-sm hover:bg-neutral-100 ${n.read ? 'text-neutral-600' : 'font-medium'}`}>
            {n.text}
            <span className="block text-xs text-neutral-400">{new Date(n.createdAt).toLocaleString()}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function AccountMenu({ onClose }: { onClose: () => void }) {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  if (!user) return null;
  const item = 'flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-neutral-100';
  return (
    <div className="absolute right-0 top-11 z-40 w-64 rounded-xl border bg-white p-2 shadow-xl" onClick={onClose}>
      <Link to={`/people/${user.id}`} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-100">
        <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-neutral-200">{user.avatar ? <img src={user.avatar} alt="" className="h-full w-full object-cover" /> : <UserIcon className="h-5 w-5" />}</div>
        <div>
          <p className="font-semibold">{user.name}</p>
          <p className="text-xs text-neutral-500">View your profile</p>
        </div>
      </Link>
      <hr className="my-1" />
      <Link to="/purchases" className={item}><Package className="h-4 w-4" /> Purchases and reviews</Link>
      <Link to="/messages" className={item}><Mail className="h-4 w-4" /> Messages</Link>
      <Link to="/account" className={item}><Settings className="h-4 w-4" /> Account settings</Link>
      <Link to={user.shopId ? '/seller' : '/sell'} className={item}><Store className="h-4 w-4" /> {user.shopId ? 'Shop Manager' : 'Sell on ' + APP_NAME}</Link>
      {user.role === 'admin' && <Link to="/admin" className={item}><Shield className="h-4 w-4" /> Admin</Link>}
      <hr className="my-1" />
      <button
        className={`${item} w-full`}
        onClick={async () => {
          await signOut();
          navigate('/');
        }}
      >
        <LogOut className="h-4 w-4" /> Sign out
      </button>
    </div>
  );
}

function Header() {
  const { user, cartCount, unreadNotifications, unreadMessages } = useSession();
  const [open, setOpen] = useState<'notifications' | 'account' | 'menu' | null>(null);
  const location = useLocation();
  useEffect(() => setOpen(null), [location.pathname]);
  const iconBtn = 'relative grid h-10 w-10 place-items-center rounded-full hover:bg-neutral-100';
  return (
    <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
        <button className={`${iconBtn} lg:hidden`} onClick={() => setOpen(open === 'menu' ? null : 'menu')} aria-label="Categories">
          <Menu className="h-5 w-5" />
        </button>
        <Link to="/" className="shrink-0 font-serif text-2xl font-bold text-brand-600">
          {APP_NAME}
        </Link>
        <div className="hidden flex-1 md:flex">
          <SearchBar />
        </div>
        <nav className="ml-auto flex items-center gap-1">
          {user ? (
            <>
              <Link to="/favorites" className={iconBtn} aria-label="Favorites"><Heart className="h-5 w-5" /></Link>
              <Link to="/messages" className={`${iconBtn} max-sm:hidden`} aria-label="Messages"><Mail className="h-5 w-5" /><Badge n={unreadMessages} /></Link>
              <div className="relative">
                <button className={iconBtn} aria-label="Notifications" onClick={() => setOpen(open === 'notifications' ? null : 'notifications')}>
                  <Bell className="h-5 w-5" />
                  <Badge n={unreadNotifications} />
                </button>
                {open === 'notifications' && <NotificationsMenu onClose={() => setOpen(null)} />}
              </div>
              <Link to={user.shopId ? '/seller' : '/sell'} className={`${iconBtn} max-sm:hidden`} aria-label="Shop Manager"><Store className="h-5 w-5" /></Link>
              <div className="relative">
                <button className={iconBtn} aria-label="Account" onClick={() => setOpen(open === 'account' ? null : 'account')}>
                  {user.avatar ? <img src={user.avatar} alt="" className="h-7 w-7 rounded-full object-cover" /> : <UserIcon className="h-5 w-5" />}
                </button>
                {open === 'account' && <AccountMenu onClose={() => setOpen(null)} />}
              </div>
            </>
          ) : (
            <Link to="/login" className="rounded-full px-4 py-2 text-sm font-semibold hover:bg-neutral-100">Sign in</Link>
          )}
          <Link to="/cart" className={iconBtn} aria-label="Cart"><ShoppingCart className="h-5 w-5" /><Badge n={cartCount} /></Link>
        </nav>
      </div>
      <div className="px-4 pb-3 md:hidden">
        <SearchBar />
      </div>
      <nav className="no-scrollbar mx-auto hidden max-w-7xl gap-6 overflow-x-auto px-4 pb-2 text-sm text-neutral-700 lg:flex">
        {rootCategories().map((c) => (
          <NavLink key={c.id} to={`/c/${c.id}`} className={({ isActive }) => `whitespace-nowrap border-b-2 pb-1 ${isActive ? 'border-neutral-900' : 'border-transparent hover:border-neutral-400'}`}>
            {c.name}
          </NavLink>
        ))}
      </nav>
      {open === 'menu' && (
        <div className="fixed inset-0 z-50 bg-black/40 lg:hidden" onClick={() => setOpen(null)}>
          <div className="h-full w-72 overflow-y-auto bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <p className="font-serif text-xl">Browse categories</p>
              <button onClick={() => setOpen(null)} aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
            {rootCategories().map((c) => (
              <Link key={c.id} to={`/c/${c.id}`} className="block rounded-lg px-2 py-2.5 hover:bg-neutral-100">{c.name}</Link>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="mt-20 bg-neutral-900 text-neutral-300">
      <div className="bg-brand-100 py-8 text-center text-neutral-900">
        <p className="font-serif text-lg">{APP_TAGLINE}</p>
      </div>
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 text-sm sm:grid-cols-3">
        <div>
          <p className="mb-3 font-semibold text-white">Shop</p>
          {rootCategories().slice(0, 5).map((c) => (
            <Link key={c.id} to={`/c/${c.id}`} className="block py-1 hover:underline">{c.name}</Link>
          ))}
        </div>
        <div>
          <p className="mb-3 font-semibold text-white">Sell</p>
          <Link to="/sell" className="block py-1 hover:underline">Sell on {APP_NAME}</Link>
          <Link to="/seller" className="block py-1 hover:underline">Shop Manager</Link>
          <Link to="/sell#fees" className="block py-1 hover:underline">Fees & payments</Link>
        </div>
        <div>
          <p className="mb-3 font-semibold text-white">About</p>
          <p className="text-neutral-400">{APP_NAME} connects buyers with independent makers, vintage collectors and craft-supply sellers.</p>
        </div>
      </div>
      <p className="border-t border-neutral-800 py-4 text-center text-xs text-neutral-500">© {new Date().getFullYear()} {APP_NAME}</p>
    </footer>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}

export function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <div className={`mx-auto px-4 py-8 ${narrow ? 'max-w-3xl' : 'max-w-7xl'}`}>{children}</div>;
}
