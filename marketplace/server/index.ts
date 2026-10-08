import path from 'node:path';
import express from 'express';
import { createApp } from './app.ts';
import { loadDatabase, saveDatabase } from './db.ts';
import { seed } from './seed.ts';

const PORT = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === 'production';

if (!loadDatabase()) {
  seed();
  saveDatabase();
  console.log('Seeded demo data (admin@demo.test / buyer@demo.test / seller emails, password: password123)');
}

const app = createApp();

if (production) {
  const dist = path.resolve('dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(PORT, () => console.log(`Marketplace running on http://localhost:${PORT}`));
