import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout, Page } from './components/Layout.tsx';
import { Empty, Spinner } from './components/ui.tsx';
import { useSession } from './session.tsx';
import Home from './pages/Home.tsx';
import SearchPage from './pages/Search.tsx';
import ListingPage from './pages/Listing.tsx';
import ShopPage from './pages/Shop.tsx';
import AuthPage from './pages/Auth.tsx';
import CartPage from './pages/Cart.tsx';
import CheckoutPage from './pages/Checkout.tsx';
import { PurchaseDetail, Purchases } from './pages/Purchases.tsx';
import FavoritesPage from './pages/Favorites.tsx';
import MessagesPage from './pages/Messages.tsx';
import AccountPage from './pages/Account.tsx';
import PersonPage from './pages/Person.tsx';
import SellPage from './pages/Sell.tsx';
import AdminPage from './pages/Admin.tsx';
import SellerApp from './pages/seller/SellerApp.tsx';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => window.scrollTo(0, 0), [pathname]);
  return null;
}

export default function App() {
  return (
    <Layout>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/c/:categoryId" element={<SearchPage />} />
        <Route path="/listing/:id" element={<ListingPage />} />
        <Route path="/shop/:slug" element={<ShopPage />} />
        <Route path="/people/:id" element={<PersonPage />} />
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="/sell" element={<SellPage />} />
        <Route path="/cart" element={<RequireAuth><CartPage /></RequireAuth>} />
        <Route path="/checkout" element={<RequireAuth><CheckoutPage /></RequireAuth>} />
        <Route path="/purchases" element={<RequireAuth><Purchases /></RequireAuth>} />
        <Route path="/purchases/:id" element={<RequireAuth><PurchaseDetail /></RequireAuth>} />
        <Route path="/favorites" element={<RequireAuth><FavoritesPage /></RequireAuth>} />
        <Route path="/messages" element={<RequireAuth><MessagesPage /></RequireAuth>} />
        <Route path="/messages/:id" element={<RequireAuth><MessagesPage /></RequireAuth>} />
        <Route path="/account" element={<RequireAuth><AccountPage /></RequireAuth>} />
        <Route path="/seller/*" element={<RequireAuth><SellerApp /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />
        <Route path="*" element={<Page><Empty title="We couldn't find that page" /></Page>} />
      </Routes>
    </Layout>
  );
}
