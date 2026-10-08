import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';
import { Button, ErrorNote } from '../components/ui.tsx';
import { APP_NAME } from '../../shared/config.ts';

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') || '/';
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const register = mode === 'register';

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <div className="card p-8">
        <h1 className="font-serif text-2xl">{register ? 'Create your account' : 'Sign in'}</h1>
        <p className="mt-1 text-sm text-neutral-600">{register ? `Registration is easy — join ${APP_NAME} to buy and sell.` : 'Welcome back!'}</p>
        <form
          className="mt-6 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(undefined);
            try {
              const res = await api(`/auth/${mode}`, { body: form });
              signIn(res.token, res.user);
              navigate(next.startsWith('/') ? next : '/');
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div>
            <label className="label" htmlFor="email">Email address</label>
            <input id="email" type="email" autoComplete="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </div>
          {register && (
            <div>
              <label className="label" htmlFor="name">First name</label>
              <input id="name" className="input" autoComplete="given-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
          )}
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 8 : undefined} className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          </div>
          <ErrorNote message={error} />
          <Button className="w-full" loading={busy}>{register ? 'Register' : 'Sign in'}</Button>
        </form>
        <p className="mt-6 text-center text-sm">
          {register ? 'Already have an account? ' : 'New here? '}
          <Link to={`${register ? '/login' : '/register'}?next=${encodeURIComponent(next)}`} className="font-semibold underline">{register ? 'Sign in' : 'Create an account'}</Link>
        </p>
        {!register && (
          <div className="mt-6 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
            <p className="font-semibold">Demo accounts (password: password123)</p>
            <p>Buyer: buyer@demo.test · Seller: maya@demo.test · Admin: admin@demo.test</p>
          </div>
        )}
      </div>
    </div>
  );
}
