import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.DB_IN_MEMORY = '1';
process.env.DATA_DIR = (await import('node:os')).tmpdir() + '/marketplace-test';
const { createApp } = await import('../server/app.ts');
const { seed } = await import('../server/seed.ts');
const { loadDatabase } = await import('../server/db.ts');

let server: Server;
let base = '';

before(() => {
  loadDatabase();
  seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(() => server.close());

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
  return json;
}

async function register(email: string) {
  return (await call('POST', '/auth/register', { email, name: 'Test ' + email, password: 'password123' })).token as string;
}

test('full seller → buyer flow books fees in the seller ledger', async () => {
  const seller = await register('newseller@test.dev');
  const shop = await call('POST', '/seller/shop', { name: 'TestStudio', location: 'Lahore' }, seller);
  assert.equal(shop.slug, 'teststudio');

  const listing = await call('POST', '/seller/listings', {
    title: 'Handmade mug', description: 'A mug', price: 2000, quantity: 3, images: ['/x.png'],
    categoryId: 'kitchen', type: 'handmade', tags: ['mug'], shipping: { cost: 500, additionalItemCost: 100 }, publish: true,
  }, seller);
  assert.equal(listing.status, 'active');
  let fin = await call('GET', '/seller/finances', undefined, seller);
  assert.equal(fin.balance, -20, 'listing fee charged on publish');

  const search = await call('GET', '/search?q=handmade%20mug');
  assert.ok(search.results.some((r: { id: string }) => r.id === listing.id));

  await call('POST', '/seller/promotions', { kind: 'coupon', code: 'SAVE10', discountType: 'percent', value: 10 }, seller);

  const buyer = await register('newbuyer@test.dev');
  await assert.rejects(call('POST', '/cart', { listingId: listing.id, quantity: 1 }, seller), /own shop/);
  await call('POST', '/cart', { listingId: listing.id, quantity: 2 }, buyer);
  const cart = await call('GET', `/cart?coupons=${encodeURIComponent(JSON.stringify({ [shop.id]: 'save10' }))}`, undefined, buyer);
  assert.equal(cart.groups[0].subtotal, 4000);
  assert.equal(cart.groups[0].discount, 400);
  assert.equal(cart.groups[0].shipping, 600);

  const address = { name: 'B', line1: '1 St', city: 'Lahore', postalCode: '1', country: 'PK' };
  const { orders } = await call('POST', '/checkout', { address, coupons: { [shop.id]: 'SAVE10' } }, buyer);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].total, 4200);

  fin = await call('GET', '/seller/finances', undefined, seller);
  // sale 3600 + shipping 600 − tx 6.5% of 4200 (273) − processing 3% of 4200 + 25 (151)
  // − renewals: 1 extra unit + 1 auto-renew (40) − original listing fee (20)
  assert.equal(fin.balance, 3600 + 600 - 273 - 151 - 40 - 20);

  await assert.rejects(call('POST', `/purchases/${orders[0].id}/reviews`, { listingId: listing.id, rating: 5 }, buyer), /once it has shipped/);
  await call('POST', `/seller/orders/${orders[0].id}/ship`, { carrier: 'TCS', trackingNumber: '123' }, seller);
  await call('POST', `/purchases/${orders[0].id}/reviews`, { listingId: listing.id, rating: 5, text: 'Great' }, buyer);
  const detail = await call('GET', `/listings/${listing.id}`);
  assert.equal(detail.reviewCount, 1);
  assert.equal(detail.listing.quantity, 1);

  const convo = await call('POST', '/conversations', { shopId: shop.id, listingId: listing.id, body: 'Thanks!' }, buyer);
  const sellerMe = await call('GET', '/me', undefined, seller);
  assert.equal(sellerMe.unreadMessages, 1);
  await call('POST', `/conversations/${convo.id}/messages`, { body: 'You are welcome' }, seller);

  const payout = await call('POST', '/seller/finances/payout', {}, seller);
  assert.ok(payout.amount > 0);
  fin = await call('GET', '/seller/finances', undefined, seller);
  assert.equal(fin.balance, 0);
});

test('refunding an order restores stock and credits the transaction fee', async () => {
  const login = await call('POST', '/auth/login', { email: 'maya@demo.test', password: 'password123' });
  const open = (await call('GET', '/seller/orders?status=paid', undefined, login.token))[0];
  const before = (await call('GET', '/seller/finances', undefined, login.token)).balance;
  const result = await call('POST', `/seller/orders/${open.id}/refund`, { reason: 'Out of stock' }, login.token);
  assert.equal(result.status, 'cancelled');
  const afterBal = (await call('GET', '/seller/finances', undefined, login.token)).balance;
  assert.equal(afterBal, before - open.total + open.fees.transactionFee);
});

test('digital files are hidden from the public listing view', async () => {
  const search = await call('GET', '/search?digital=1');
  assert.ok(search.total > 0);
  const detail = await call('GET', `/listings/${search.results[0].id}`);
  assert.equal(detail.listing.digitalFileUrl, undefined);
});

test('admin sees marketplace revenue; regular users cannot', async () => {
  const admin = await call('POST', '/auth/login', { email: 'admin@demo.test', password: 'password123' });
  const overview = await call('GET', '/admin/overview', undefined, admin.token);
  assert.ok(overview.revenue > 0);
  const buyer = await call('POST', '/auth/login', { email: 'buyer@demo.test', password: 'password123' });
  await assert.rejects(call('GET', '/admin/overview', undefined, buyer.token), (e: { status: number }) => e.status === 403);
});
