import { useState } from 'react';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';
import { Page } from '../components/Layout.tsx';
import { Button, ErrorNote, ImageUploader } from '../components/ui.tsx';
import { AddressFields } from './Checkout.tsx';
import type { Address } from '../../shared/types.ts';

export default function AccountPage() {
  const { user, refresh } = useSession();
  const [profile, setProfile] = useState({ name: user?.name ?? '', bio: user?.bio ?? '', avatar: user?.avatar ? [user.avatar] : [] as string[] });
  const [address, setAddress] = useState<Address>(user?.address ?? { name: '', line1: '', city: '', postalCode: '', country: '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [msg, setMsg] = useState<{ section: string; text: string; error?: boolean }>();

  const save = async (section: string, body: Record<string, unknown>) => {
    try {
      await api('/me', { method: 'PATCH', body });
      await refresh();
      setMsg({ section, text: 'Saved' });
    } catch (e) {
      setMsg({ section, text: (e as Error).message, error: true });
    }
  };
  const note = (section: string) =>
    msg?.section === section && (msg.error ? <ErrorNote message={msg.text} /> : <p className="text-sm text-green-700">{msg.text}</p>);

  return (
    <Page narrow>
      <h1 className="mb-6 font-serif text-3xl">Account settings</h1>
      <div className="space-y-8">
        <section className="card space-y-4 p-6">
          <h2 className="text-lg font-semibold">Public profile</h2>
          <div><label className="label">Profile picture</label><ImageUploader images={profile.avatar} onChange={(avatar) => setProfile({ ...profile, avatar })} max={1} /></div>
          <div><label className="label">Name</label><input className="input" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></div>
          <div><label className="label">About</label><textarea className="input" value={profile.bio} onChange={(e) => setProfile({ ...profile, bio: e.target.value })} /></div>
          {note('profile')}
          <Button onClick={() => save('profile', { name: profile.name, bio: profile.bio, avatar: profile.avatar[0] ?? '' })}>Save profile</Button>
        </section>
        <section className="card space-y-4 p-6">
          <h2 className="text-lg font-semibold">Default shipping address</h2>
          <AddressFields value={address} onChange={setAddress} />
          {note('address')}
          <Button onClick={() => save('address', { address })}>Save address</Button>
        </section>
        <section className="card space-y-4 p-6">
          <h2 className="text-lg font-semibold">Password</h2>
          <p className="text-sm text-neutral-600">Signed in as {user?.email}</p>
          <div><label className="label">Current password</label><input type="password" className="input" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></div>
          <div><label className="label">New password</label><input type="password" minLength={8} className="input" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></div>
          {note('password')}
          <Button onClick={async () => { await save('password', pw); setPw({ currentPassword: '', newPassword: '' }); }}>Change password</Button>
        </section>
      </div>
    </Page>
  );
}
