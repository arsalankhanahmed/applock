import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, newId, now, UPLOAD_DIR } from '../db.ts';
import { badRequest, handle, HttpError, str } from '../http.ts';
import { createSession, hashPassword, optionalUser, publicUser, requireUser, verifyPassword } from '../auth.ts';
import { validateAddress } from '../services.ts';

export const accountRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

accountRouter.post(
  '/auth/register',
  handle((req) => {
    const email = str(req.body.email, 'Email', { required: true }).toLowerCase();
    const name = str(req.body.name, 'Name', { required: true, max: 60 });
    const password = String(req.body.password ?? '');
    if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email');
    if (password.length < 8) throw badRequest('Password must be at least 8 characters');
    if (db.users.some((u) => u.email === email)) throw badRequest('An account with this email already exists');
    const user = { id: newId('usr'), email, name, passwordHash: hashPassword(password), role: 'user' as const, createdAt: now() };
    db.users.push(user);
    return { token: createSession(user.id), user: publicUser(user) };
  }),
);

accountRouter.post(
  '/auth/login',
  handle((req) => {
    const email = str(req.body.email, 'Email', { required: true }).toLowerCase();
    const user = db.users.find((u) => u.email === email);
    if (!user || !verifyPassword(String(req.body.password ?? ''), user.passwordHash)) {
      throw new HttpError(401, 'Incorrect email or password');
    }
    if (user.suspended) throw new HttpError(403, 'This account has been suspended');
    return { token: createSession(user.id), user: publicUser(user) };
  }),
);

accountRouter.post(
  '/auth/logout',
  handle((req) => {
    const token = req.headers.authorization?.slice(7);
    db.sessions = db.sessions.filter((s) => s.token !== token);
  }),
);

accountRouter.get(
  '/me',
  handle((req) => {
    const user = optionalUser(req);
    if (!user) return { user: null };
    return {
      user: publicUser(user),
      cartCount: db.cart.filter((c) => c.userId === user.id && !c.savedForLater).reduce((n, c) => n + c.quantity, 0),
      unreadNotifications: db.notifications.filter((n) => n.userId === user.id && !n.read).length,
      unreadMessages: db.messages.filter((m) => {
        if (m.senderId === user.id || m.readBy.includes(user.id)) return false;
        const convo = db.conversations.find((c) => c.id === m.conversationId);
        return convo && (convo.buyerId === user.id || convo.sellerId === user.id);
      }).length,
    };
  }),
);

accountRouter.patch(
  '/me',
  handle((req) => {
    const user = requireUser(req);
    if (req.body.name !== undefined) user.name = str(req.body.name, 'Name', { required: true, max: 60 });
    if (req.body.bio !== undefined) user.bio = str(req.body.bio, 'Bio', { max: 500 });
    if (req.body.avatar !== undefined) user.avatar = str(req.body.avatar, 'Avatar');
    if (req.body.address !== undefined) user.address = validateAddress(req.body.address);
    if (req.body.newPassword) {
      if (!verifyPassword(String(req.body.currentPassword ?? ''), user.passwordHash)) throw badRequest('Current password is incorrect');
      if (String(req.body.newPassword).length < 8) throw badRequest('Password must be at least 8 characters');
      user.passwordHash = hashPassword(String(req.body.newPassword));
    }
    return { user: publicUser(user) };
  }),
);

accountRouter.get(
  '/notifications',
  handle((req) => {
    const user = requireUser(req);
    return db.notifications.filter((n) => n.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }),
);

accountRouter.post(
  '/notifications/read',
  handle((req) => {
    const user = requireUser(req);
    for (const n of db.notifications) if (n.userId === user.id) n.read = true;
  }),
);

const UPLOAD_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
};
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

accountRouter.post(
  '/uploads',
  handle((req) => {
    requireUser(req);
    const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(req.body.dataUrl ?? ''));
    if (!match) throw badRequest('Upload must be a base64 data URL');
    const ext = UPLOAD_TYPES[match[1]];
    if (!ext) throw badRequest('Unsupported file type');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > MAX_UPLOAD_BYTES) throw badRequest('File is larger than 8 MB');
    const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), bytes);
    return { url: `/uploads/${name}` };
  }),
);
