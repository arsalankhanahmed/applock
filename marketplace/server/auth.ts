import crypto from 'node:crypto';
import type { Request } from 'express';
import { db } from './db.ts';
import { HttpError, forbidden } from './http.ts';
import type { PublicUser, Shop, User } from '../shared/types.ts';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ token, userId, createdAt: new Date().toISOString() });
  return token;
}

export function publicUser(user: User): PublicUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

function tokenFrom(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return undefined;
}

export function optionalUser(req: Request): User | undefined {
  const token = tokenFrom(req);
  if (!token) return undefined;
  const session = db.sessions.find((s) => s.token === token);
  const user = session && db.users.find((u) => u.id === session.userId);
  if (!user || user.suspended) return undefined;
  return user;
}

export function requireUser(req: Request): User {
  const user = optionalUser(req);
  if (!user) throw new HttpError(401, 'Please sign in to continue');
  return user;
}

export function requireAdmin(req: Request): User {
  const user = requireUser(req);
  if (user.role !== 'admin') throw forbidden();
  return user;
}

export function requireShop(req: Request): { user: User; shop: Shop } {
  const user = requireUser(req);
  const shop = db.shops.find((s) => s.ownerId === user.id);
  if (!shop) throw forbidden('Open a shop first');
  return { user, shop };
}
