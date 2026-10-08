import { Router } from 'express';
import { db, newId, now } from '../db.ts';
import { badRequest, forbidden, handle, int, notFound, str } from '../http.ts';
import { requireUser } from '../auth.ts';
import { checkout, isBuyable, notify, priceCart, shopStats, toCard, validateAddress } from '../services.ts';
import { unitPrice } from '../../shared/fees.ts';
import type { Listing, ShopStats } from '../../shared/types.ts';

export const buyerRouter = Router();

// ---- Favorites -------------------------------------------------------------

buyerRouter.get(
  '/favorites',
  handle((req) => {
    const user = requireUser(req);
    const cache = new Map<string, ShopStats>();
    const listings = db.favorites
      .filter((f) => f.userId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((f) => db.listings.find((l) => l.id === f.listingId))
      .filter((l): l is Listing => Boolean(l))
      .map((l) => ({ ...toCard(l, user, cache), available: isBuyable(l) }));
    const shops = db.shopFavorites
      .filter((f) => f.userId === user.id)
      .map((f) => db.shops.find((s) => s.id === f.shopId))
      .filter((s) => s && s.status === 'active')
      .map((s) => ({ id: s!.id, name: s!.name, slug: s!.slug, logo: s!.logo, location: s!.location, ...shopStats(s!.id) }));
    const collections = db.collections.filter((c) => c.userId === user.id);
    return { listings, shops, collections };
  }),
);

buyerRouter.post(
  '/favorites/:listingId',
  handle((req) => {
    const user = requireUser(req);
    const listing = db.listings.find((l) => l.id === req.params.listingId);
    if (!listing) throw notFound('Listing not found');
    const existing = db.favorites.findIndex((f) => f.userId === user.id && f.listingId === listing.id);
    if (existing >= 0) {
      db.favorites.splice(existing, 1);
      return { favorited: false };
    }
    db.favorites.push({ userId: user.id, listingId: listing.id, createdAt: now() });
    return { favorited: true };
  }),
);

buyerRouter.post(
  '/shop-favorites/:shopId',
  handle((req) => {
    const user = requireUser(req);
    const shop = db.shops.find((s) => s.id === req.params.shopId);
    if (!shop) throw notFound('Shop not found');
    const existing = db.shopFavorites.findIndex((f) => f.userId === user.id && f.shopId === shop.id);
    if (existing >= 0) {
      db.shopFavorites.splice(existing, 1);
      return { favorited: false };
    }
    db.shopFavorites.push({ userId: user.id, shopId: shop.id, createdAt: now() });
    notify(shop.ownerId, `${user.name} favorited your shop`, `/shop/${shop.slug}`);
    return { favorited: true };
  }),
);

// ---- Collections -----------------------------------------------------------

buyerRouter.post(
  '/collections',
  handle((req) => {
    const user = requireUser(req);
    const collection = {
      id: newId('col'),
      userId: user.id,
      name: str(req.body.name, 'Collection name', { required: true, max: 60 }),
      isPublic: req.body.isPublic !== false,
      listingIds: [] as string[],
      createdAt: now(),
    };
    db.collections.push(collection);
    return collection;
  }),
);

function ownCollection(userId: string, id: string) {
  const collection = db.collections.find((c) => c.id === id);
  if (!collection) throw notFound('Collection not found');
  if (collection.userId !== userId) throw forbidden();
  return collection;
}

buyerRouter.post(
  '/collections/:id/toggle/:listingId',
  handle((req) => {
    const collection = ownCollection(requireUser(req).id, req.params.id);
    const idx = collection.listingIds.indexOf(req.params.listingId);
    if (idx >= 0) collection.listingIds.splice(idx, 1);
    else collection.listingIds.push(req.params.listingId);
    return collection;
  }),
);

buyerRouter.delete(
  '/collections/:id',
  handle((req) => {
    const collection = ownCollection(requireUser(req).id, req.params.id);
    db.collections = db.collections.filter((c) => c.id !== collection.id);
  }),
);

// ---- Cart ------------------------------------------------------------------

function cartView(userId: string, coupons: Record<string, string> = {}) {
  const cache = new Map<string, ShopStats>();
  const user = db.users.find((u) => u.id === userId);
  const groups = priceCart(userId, coupons);
  return {
    groups,
    total: groups.reduce((s, g) => s + g.total, 0),
    saved: db.cart
      .filter((c) => c.userId === userId && c.savedForLater)
      .map((c) => {
        const listing = db.listings.find((l) => l.id === c.listingId);
        return listing ? { ...c, card: toCard(listing, user, cache), available: isBuyable(listing) } : undefined;
      })
      .filter(Boolean),
  };
}

function couponsFrom(query: unknown): Record<string, string> {
  if (typeof query !== 'string' || !query) return {};
  try {
    const parsed = JSON.parse(query);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

buyerRouter.get('/cart', handle((req) => cartView(requireUser(req).id, couponsFrom(req.query.coupons))));

function validateSelections(listing: Listing, raw: unknown): Record<string, string> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const selections: Record<string, string> = {};
  for (const v of listing.variations) {
    const value = input[v.name];
    if (typeof value !== 'string' || !v.options.some((o) => o.value === value)) throw badRequest(`Please select a ${v.name}`);
    selections[v.name] = value;
  }
  return selections;
}

buyerRouter.post(
  '/cart',
  handle((req) => {
    const user = requireUser(req);
    const listing = db.listings.find((l) => l.id === req.body.listingId);
    if (!listing || !isBuyable(listing)) throw badRequest('This item is not available');
    const shop = db.shops.find((s) => s.id === listing.shopId)!;
    if (shop.ownerId === user.id) throw badRequest("You can't buy from your own shop");
    const quantity = int(req.body.quantity ?? 1, 'Quantity', { min: 1, max: listing.quantity });
    const selections = validateSelections(listing, req.body.selections);
    const personalization = str(req.body.personalization, 'Personalization', { max: 1024 });
    if (listing.personalization.enabled && listing.personalization.required && !personalization) {
      throw badRequest('Please add the personalization details');
    }
    const existing = db.cart.find(
      (c) =>
        c.userId === user.id &&
        !c.savedForLater &&
        c.listingId === listing.id &&
        JSON.stringify(c.selections) === JSON.stringify(selections) &&
        c.personalization === personalization,
    );
    if (existing) existing.quantity = Math.min(listing.quantity, existing.quantity + quantity);
    else
      db.cart.push({
        id: newId('crt'),
        userId: user.id,
        listingId: listing.id,
        quantity,
        selections,
        personalization: listing.personalization.enabled ? personalization : '',
        savedForLater: false,
        createdAt: now(),
      });
    return { unitPrice: unitPrice(listing, selections) };
  }),
);

function ownCartItem(userId: string, id: string) {
  const item = db.cart.find((c) => c.id === id && c.userId === userId);
  if (!item) throw notFound('Cart item not found');
  return item;
}

buyerRouter.patch(
  '/cart/:id',
  handle((req) => {
    const user = requireUser(req);
    const item = ownCartItem(user.id, req.params.id);
    const listing = db.listings.find((l) => l.id === item.listingId)!;
    if (req.body.quantity !== undefined) item.quantity = int(req.body.quantity, 'Quantity', { min: 1, max: Math.max(1, listing.quantity) });
    if (req.body.savedForLater !== undefined) item.savedForLater = Boolean(req.body.savedForLater);
    if (req.body.personalization !== undefined) item.personalization = str(req.body.personalization, 'Personalization', { max: 1024 });
    return cartView(user.id);
  }),
);

buyerRouter.delete(
  '/cart/:id',
  handle((req) => {
    const user = requireUser(req);
    const item = ownCartItem(user.id, req.params.id);
    db.cart = db.cart.filter((c) => c.id !== item.id);
    return cartView(user.id);
  }),
);

buyerRouter.post(
  '/checkout',
  handle((req) => {
    const user = requireUser(req);
    const address = validateAddress(req.body.address);
    if (req.body.saveAddress) user.address = address;
    const orders = checkout(user, {
      address,
      coupons: req.body.coupons ?? {},
      giftShops: Array.isArray(req.body.giftShops) ? req.body.giftShops : [],
      giftMessages: req.body.giftMessages ?? {},
      notes: req.body.notes ?? {},
    });
    return { orders: orders.map((o) => ({ id: o.id, receiptNo: o.receiptNo, total: o.total })) };
  }),
);

// ---- Purchases & reviews ---------------------------------------------------

function orderForBuyer(userId: string, id: string) {
  const order = db.orders.find((o) => o.id === id);
  if (!order || order.buyerId !== userId) throw notFound('Order not found');
  return order;
}

function buyerOrderView(order: (typeof db.orders)[number], userId: string) {
  const shop = db.shops.find((s) => s.id === order.shopId);
  const paid = order.status !== 'cancelled' && order.status !== 'refunded';
  return {
    ...order,
    fees: undefined,
    items: order.items.map((i) => ({ ...i, digitalFileUrl: paid ? i.digitalFileUrl : undefined })),
    shop: shop ? { id: shop.id, name: shop.name, slug: shop.slug, logo: shop.logo } : undefined,
    reviews: db.reviews.filter((r) => r.orderId === order.id && r.buyerId === userId),
  };
}

buyerRouter.get(
  '/purchases',
  handle((req) => {
    const user = requireUser(req);
    return db.orders
      .filter((o) => o.buyerId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((o) => buyerOrderView(o, user.id));
  }),
);

buyerRouter.get(
  '/purchases/:id',
  handle((req) => {
    const user = requireUser(req);
    return buyerOrderView(orderForBuyer(user.id, req.params.id), user.id);
  }),
);

buyerRouter.post(
  '/purchases/:id/received',
  handle((req) => {
    const user = requireUser(req);
    const order = orderForBuyer(user.id, req.params.id);
    if (order.status !== 'shipped') throw badRequest('Only shipped orders can be marked as received');
    order.status = 'delivered';
    order.deliveredAt = now();
    const shop = db.shops.find((s) => s.id === order.shopId)!;
    notify(shop.ownerId, `Order #${order.receiptNo} was marked as received`, `/seller/orders/${order.id}`);
  }),
);

buyerRouter.post(
  '/purchases/:id/reviews',
  handle((req) => {
    const user = requireUser(req);
    const order = orderForBuyer(user.id, req.params.id);
    if (!['shipped', 'delivered', 'completed'].includes(order.status)) throw badRequest('You can review an order once it has shipped');
    const listingId = String(req.body.listingId);
    if (!order.items.some((i) => i.listingId === listingId)) throw badRequest('That item is not in this order');
    const rating = int(req.body.rating, 'Rating', { min: 1, max: 5 });
    const text = str(req.body.text, 'Review', { max: 2000 });
    const image = str(req.body.image, 'Photo');
    const existing = db.reviews.find((r) => r.orderId === order.id && r.listingId === listingId);
    if (existing) {
      Object.assign(existing, { rating, text, image: image || existing.image });
      return existing;
    }
    const review = { id: newId('rev'), orderId: order.id, listingId, shopId: order.shopId, buyerId: user.id, rating, text, image: image || undefined, createdAt: now() };
    db.reviews.push(review);
    const shop = db.shops.find((s) => s.id === order.shopId)!;
    notify(shop.ownerId, `${user.name} left a ${rating}-star review`, `/seller/reviews`);
    return review;
  }),
);

// ---- Reports ---------------------------------------------------------------

buyerRouter.post(
  '/reports',
  handle((req) => {
    const user = requireUser(req);
    const targetType = req.body.targetType;
    if (!['listing', 'shop', 'review'].includes(targetType)) throw badRequest('Invalid report target');
    db.reports.push({
      id: newId('rpt'),
      reporterId: user.id,
      targetType,
      targetId: str(req.body.targetId, 'Target', { required: true }),
      reason: str(req.body.reason, 'Reason', { required: true, max: 1000 }),
      status: 'open',
      createdAt: now(),
    });
  }),
);
