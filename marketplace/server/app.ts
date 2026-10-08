import express from 'express';
import { UPLOAD_DIR } from './db.ts';
import { errorHandler } from './http.ts';
import { sweepExpiredListings } from './services.ts';
import { accountRouter } from './routes/account.ts';
import { catalogRouter } from './routes/catalog.ts';
import { buyerRouter } from './routes/buyer.ts';
import { messagesRouter } from './routes/messages.ts';
import { sellerRouter } from './routes/seller.ts';
import { adminRouter } from './routes/admin.ts';

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '12mb' }));

  // Expire / auto-renew listings lazily, at most once a minute.
  let lastSweep = 0;
  app.use('/api', (_req, _res, next) => {
    if (Date.now() - lastSweep > 60_000) {
      lastSweep = Date.now();
      sweepExpiredListings();
    }
    next();
  });

  app.use('/api', accountRouter);
  app.use('/api', catalogRouter);
  app.use('/api', buyerRouter);
  app.use('/api', messagesRouter);
  app.use('/api/seller', sellerRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

  // Generated artwork used by the demo seed data.
  app.get('/placeholder/:hue/:label.svg', (req, res) => {
    const hue = Number(req.params.hue) % 360;
    const label = escapeXml(decodeURIComponent(req.params.label).slice(0, 4));
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=604800').send(
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,82%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},50%,62%)"/></linearGradient></defs>
<rect width="600" height="600" fill="url(#g)"/><circle cx="470" cy="120" r="90" fill="hsl(${hue},60%,92%)" opacity=".5"/>
<text x="300" y="350" font-size="220" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`,
    );
  });

  app.use(errorHandler);
  return app;
}
