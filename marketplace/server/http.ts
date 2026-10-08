import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { saveDatabase } from './db.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg);

/** Wraps a handler: converts thrown HttpErrors into JSON and persists the DB after writes. */
export function handle(fn: (req: Request, res: Response) => unknown): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await fn(req, res);
      if (req.method !== 'GET') saveDatabase();
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (err) {
      next(err);
    }
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
}

export function str(value: unknown, field: string, opts: { required?: boolean; max?: number } = {}): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (opts.required && !s) throw badRequest(`${field} is required`);
  if (opts.max && s.length > opts.max) throw badRequest(`${field} must be at most ${opts.max} characters`);
  return s;
}

export function int(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw badRequest(`${field} must be a whole number`);
  if (opts.min !== undefined && n < opts.min) throw badRequest(`${field} must be at least ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw badRequest(`${field} must be at most ${opts.max}`);
  return n;
}

export function strList(value: unknown, max = 13): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max);
}
