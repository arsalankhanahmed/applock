import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Database } from '../shared/types.ts';

// A small JSON-file store: the whole database lives in memory and is flushed to disk
// after every mutating request. Good for a single-instance deployment; swap for
// Postgres when you need horizontal scaling.

export const DATA_DIR = process.env.DATA_DIR ?? path.resolve('data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

export function emptyDatabase(): Database {
  return {
    users: [],
    sessions: [],
    shops: [],
    listings: [],
    favorites: [],
    shopFavorites: [],
    collections: [],
    cart: [],
    promotions: [],
    orders: [],
    reviews: [],
    conversations: [],
    messages: [],
    ledger: [],
    notifications: [],
    reports: [],
    adClicks: [],
    counters: { receiptNo: 1000 },
  };
}

export let db: Database = emptyDatabase();

export function loadDatabase(): boolean {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return false;
  db = { ...emptyDatabase(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  return true;
}

export function resetDatabase(next: Database = emptyDatabase()): void {
  db = next;
}

export function saveDatabase(): void {
  if (process.env.DB_IN_MEMORY === '1') return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function now(): string {
  return new Date().toISOString();
}
