import { Router } from 'express';
import { db, newId, now } from '../db.ts';
import { badRequest, forbidden, handle, int, notFound, str, strList } from '../http.ts';
import { requireShop, requireUser } from '../auth.ts';
import { chargeListingFee, ledger, notify, refundOrder, shopBalance, shopStats } from '../services.ts';
import { categoryById } from '../../shared/categories.ts';
import { FEES, formatMoney } from '../../shared/config.ts';
import type { DiscountType, Listing, ListingType, Shop, Variation } from '../../shared/types.ts';

export const sellerRouter = Router();

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---- Shop ------------------------------------------------------------------

sellerRouter.post(
  '/shop',
  handle((req) => {
    const user = requireUser(req);
    if (db.shops.some((s) => s.ownerId === user.id)) throw badRequest('You already have a shop');
    const name = str(req.body.name, 'Shop name', { required: true, max: 20 });
    if (!/^[A-Za-z0-9]+$/.test(name)) throw badRequest('Shop names may only contain letters and numbers, without spaces');
    const slug = slugify(name);
    if (db.shops.some((s) => s.slug === slug)) throw badRequest('That shop name is taken');
    const shop: Shop = {
      id: newId('shp'),
      ownerId: user.id,
      name,
      slug,
      tagline: str(req.body.tagline, 'Tagline', { max: 55 }),
      about: '',
      announcement: '',
      location: str(req.body.location, 'Location', { max: 60 }),
      sections: [],
      policies: {
        processingDays: 3,
        shipping: 'Orders ship within the processing time shown on each listing.',
        returns: 'Contact me within 14 days of delivery to arrange a return.',
        acceptsReturns: true,
        returnWindowDays: 14,
        privacy: 'I only use your information to fulfil your order.',
      },
      vacationMode: false,
      vacationMessage: '',
      adsDailyBudget: 0,
      status: 'active',
      createdAt: now(),
    };
    db.shops.push(shop);
    user.shopId = shop.id;
    return shop;
  }),
);

sellerRouter.get(
  '/shop',
  handle((req) => {
    const { shop } = requireShop(req);
    return { shop, stats: shopStats(shop.id), balance: shopBalance(shop.id) };
  }),
);

sellerRouter.patch(
  '/shop',
  handle((req) => {
    const { shop } = requireShop(req);
    const b = req.body;
    if (b.tagline !== undefined) shop.tagline = str(b.tagline, 'Tagline', { max: 55 });
    if (b.about !== undefined) shop.about = str(b.about, 'About', { max: 5000 });
    if (b.announcement !== undefined) shop.announcement = str(b.announcement, 'Announcement', { max: 5000 });
    if (b.location !== undefined) shop.location = str(b.location, 'Location', { max: 60 });
    if (b.logo !== undefined) shop.logo = str(b.logo, 'Logo') || undefined;
    if (b.banner !== undefined) shop.banner = str(b.banner, 'Banner') || undefined;
    if (b.vacationMode !== undefined) shop.vacationMode = Boolean(b.vacationMode);
    if (b.vacationMessage !== undefined) shop.vacationMessage = str(b.vacationMessage, 'Vacation message', { max: 500 });
    if (b.adsDailyBudget !== undefined) shop.adsDailyBudget = int(b.adsDailyBudget, 'Daily ad budget', { min: 0, max: 100_000 });
    if (b.policies !== undefined) {
      const p = b.policies;
      shop.policies = {
        processingDays: int(p.processingDays ?? shop.policies.processingDays, 'Processing days', { min: 1, max: 70 }),
        shipping: str(p.shipping ?? shop.policies.shipping, 'Shipping policy', { max: 5000 }),
        returns: str(p.returns ?? shop.policies.returns, 'Returns policy', { max: 5000 }),
        acceptsReturns: Boolean(p.acceptsReturns ?? shop.policies.acceptsReturns),
        returnWindowDays: int(p.returnWindowDays ?? shop.policies.returnWindowDays, 'Return window', { min: 0, max: 90 }),
        privacy: str(p.privacy ?? shop.policies.privacy, 'Privacy policy', { max: 5000 }),
      };
    }
    if (b.sections !== undefined) {
      if (!Array.isArray(b.sections)) throw badRequest('Sections must be a list');
      shop.sections = b.sections
        .slice(0, 20)
        .map((s: { id?: string; name?: string }) => ({ id: s.id || newId('sec'), name: str(s.name, 'Section name', { required: true, max: 24 }) }));
      const valid = new Set(shop.sections.map((s) => s.id));
      for (const l of db.listings) if (l.shopId === shop.id && l.sectionId && !valid.has(l.sectionId)) l.sectionId = undefined;
    }
    return shop;
  }),
);

// ---- Listings --------------------------------------------------------------

function parseVariations(raw: unknown): Variation[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 2).map((v: { name?: unknown; options?: unknown }) => {
    const name = str(v.name, 'Variation name', { required: true, max: 30 });
    const options = Array.isArray(v.options)
      ? v.options.slice(0, 70).map((o: { value?: unknown; priceDelta?: unknown }) => ({
          value: str(o.value, `${name} option`, { required: true, max: 40 }),
          priceDelta: int(o.priceDelta ?? 0, 'Price difference', { min: -1_000_000, max: 1_000_000 }),
        }))
      : [];
    if (options.length === 0) throw badRequest(`${name} needs at least one option`);
    return { name, options };
  });
}

function applyListingInput(listing: Listing, shop: Shop, b: Record<string, any>): void {
  listing.title = str(b.title, 'Title', { required: true, max: 140 });
  listing.description = str(b.description, 'Description', { max: 10_000 });
  listing.price = int(b.price, 'Price', { min: 20, max: 5_000_000 });
  listing.quantity = int(b.quantity ?? 1, 'Quantity', { min: 0, max: 999 });
  listing.images = strList(b.images, 10);
  if (!categoryById(String(b.categoryId))) throw badRequest('Choose a category');
  listing.categoryId = String(b.categoryId);
  listing.tags = strList(b.tags, 13).map((t) => t.slice(0, 20).toLowerCase());
  listing.materials = strList(b.materials, 13);
  if (!['handmade', 'vintage', 'supplies'].includes(b.type)) throw badRequest('Choose what this item is');
  listing.type = b.type as ListingType;
  listing.isDigital = Boolean(b.isDigital);
  listing.digitalFileUrl = listing.isDigital ? str(b.digitalFileUrl, 'Digital file') || undefined : undefined;
  listing.variations = parseVariations(b.variations);
  listing.personalization = {
    enabled: Boolean(b.personalization?.enabled),
    required: Boolean(b.personalization?.required),
    instructions: str(b.personalization?.instructions, 'Personalization instructions', { max: 256 }),
  };
  const s = b.shipping ?? {};
  listing.shipping = {
    cost: listing.isDigital ? 0 : int(s.cost ?? 0, 'Shipping cost', { min: 0, max: 1_000_000 }),
    additionalItemCost: listing.isDigital ? 0 : int(s.additionalItemCost ?? 0, 'Additional item shipping', { min: 0, max: 1_000_000 }),
    freeShipping: listing.isDigital || Boolean(s.freeShipping),
    shipsFrom: str(s.shipsFrom, 'Ships from', { max: 60 }) || shop.location,
    processingDays: int(s.processingDays ?? shop.policies.processingDays, 'Processing time', { min: 1, max: 70 }),
  };
  const sectionId = typeof b.sectionId === 'string' && b.sectionId ? b.sectionId : undefined;
  listing.sectionId = sectionId && shop.sections.some((sec) => sec.id === sectionId) ? sectionId : undefined;
  listing.autoRenew = b.autoRenew !== false;
  listing.promoted = Boolean(b.promoted);
  listing.featured = Boolean(b.featured);
}

function assertPublishable(listing: Listing): void {
  if (listing.images.length === 0) throw badRequest('Add at least one photo before publishing');
  if (!listing.description) throw badRequest('Add a description before publishing');
  if (listing.quantity < 1) throw badRequest('Quantity must be at least 1 to publish');
  if (listing.isDigital && !listing.digitalFileUrl) throw badRequest('Upload the digital file buyers will download');
}

function ownListing(shop: Shop, id: string): Listing {
  const listing = db.listings.find((l) => l.id === id);
  if (!listing) throw notFound('Listing not found');
  if (listing.shopId !== shop.id) throw forbidden();
  return listing;
}

sellerRouter.get(
  '/listings',
  handle((req) => {
    const { shop } = requireShop(req);
    return db.listings
      .filter((l) => l.shopId === shop.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((l) => ({ ...l, favorites: db.favorites.filter((f) => f.listingId === l.id).length }));
  }),
);

sellerRouter.get('/listings/:id', handle((req) => ownListing(requireShop(req).shop, req.params.id)));

sellerRouter.post(
  '/listings',
  handle((req) => {
    const { shop } = requireShop(req);
    const listing = { id: newId('lst'), shopId: shop.id, status: 'draft', views: 0, createdAt: now() } as Listing;
    applyListingInput(listing, shop, req.body);
    if (req.body.publish) {
      assertPublishable(listing);
      listing.status = 'active';
      chargeListingFee(listing, 'Listing fee');
    }
    db.listings.push(listing);
    return listing;
  }),
);

sellerRouter.put(
  '/listings/:id',
  handle((req) => {
    const { shop } = requireShop(req);
    const listing = ownListing(shop, req.params.id);
    applyListingInput(listing, shop, req.body);
    if (listing.status === 'sold_out' && listing.quantity > 0) {
      // Restocking a sold-out listing relists it, which costs a listing fee.
      listing.status = 'active';
      chargeListingFee(listing, 'Restock renewal');
    }
    if (listing.status === 'active') {
      assertPublishable(listing);
      if (listing.quantity === 0) listing.status = 'sold_out';
    }
    if (req.body.publish && (listing.status === 'draft' || listing.status === 'inactive' || listing.status === 'expired')) {
      assertPublishable(listing);
      listing.status = 'active';
      chargeListingFee(listing, 'Listing fee');
    }
    return listing;
  }),
);

sellerRouter.post(
  '/listings/:id/status',
  handle((req) => {
    const { shop } = requireShop(req);
    const listing = ownListing(shop, req.params.id);
    const action = String(req.body.action);
    if (action === 'deactivate') {
      if (listing.status !== 'active') throw badRequest('Only active listings can be deactivated');
      listing.status = 'inactive';
    } else if (action === 'activate') {
      if (listing.status !== 'inactive') throw badRequest('Only inactive listings can be activated');
      if (listing.expiresAt && new Date(listing.expiresAt) < new Date()) throw badRequest('This listing expired — renew it instead');
      assertPublishable(listing);
      listing.status = 'active';
    } else if (action === 'renew') {
      assertPublishable(listing);
      listing.status = 'active';
      chargeListingFee(listing, 'Manual renewal');
    } else {
      throw badRequest('Unknown action');
    }
    return listing;
  }),
);

sellerRouter.post(
  '/listings/:id/copy',
  handle((req) => {
    const { shop } = requireShop(req);
    const source = ownListing(shop, req.params.id);
    const copy: Listing = {
      ...structuredClone(source),
      id: newId('lst'),
      title: `${source.title} (copy)`.slice(0, 140),
      status: 'draft',
      views: 0,
      createdAt: now(),
      publishedAt: undefined,
      expiresAt: undefined,
    };
    db.listings.push(copy);
    return copy;
  }),
);

sellerRouter.delete(
  '/listings/:id',
  handle((req) => {
    const { shop } = requireShop(req);
    const listing = ownListing(shop, req.params.id);
    if (db.orders.some((o) => o.items.some((i) => i.listingId === listing.id))) {
      // Keep sold listings for order history; just take them off the market.
      listing.status = 'inactive';
      return { archived: true };
    }
    db.listings = db.listings.filter((l) => l.id !== listing.id);
    db.cart = db.cart.filter((c) => c.listingId !== listing.id);
    db.favorites = db.favorites.filter((f) => f.listingId !== listing.id);
    return { deleted: true };
  }),
);

// ---- Orders ----------------------------------------------------------------

function ownOrder(shop: Shop, id: string) {
  const order = db.orders.find((o) => o.id === id);
  if (!order || order.shopId !== shop.id) throw notFound('Order not found');
  return order;
}

function sellerOrderView(order: (typeof db.orders)[number]) {
  const buyer = db.users.find((u) => u.id === order.buyerId);
  return {
    ...order,
    buyer: buyer ? { id: buyer.id, name: buyer.name, email: buyer.email } : undefined,
    reviews: db.reviews.filter((r) => r.orderId === order.id),
    net: order.total - order.fees.transactionFee - order.fees.processingFee - order.fees.listingRenewalFees,
  };
}

sellerRouter.get(
  '/orders',
  handle((req) => {
    const { shop } = requireShop(req);
    const status = String(req.query.status ?? '');
    return db.orders
      .filter((o) => o.shopId === shop.id && (!status || o.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(sellerOrderView);
  }),
);

sellerRouter.get('/orders/:id', handle((req) => sellerOrderView(ownOrder(requireShop(req).shop, req.params.id))));

sellerRouter.post(
  '/orders/:id/ship',
  handle((req) => {
    const { shop } = requireShop(req);
    const order = ownOrder(shop, req.params.id);
    if (order.status !== 'paid') throw badRequest('Only paid orders can be marked as shipped');
    const carrier = str(req.body.carrier, 'Carrier', { max: 40 });
    const number = str(req.body.trackingNumber, 'Tracking number', { max: 60 });
    order.tracking = carrier && number ? { carrier, number } : undefined;
    order.status = 'shipped';
    order.shippedAt = now();
    notify(order.buyerId, `Your order #${order.receiptNo} from ${shop.name} has shipped${number ? ` (${carrier} ${number})` : ''}`, `/purchases/${order.id}`);
    return sellerOrderView(order);
  }),
);

sellerRouter.post(
  '/orders/:id/complete',
  handle((req) => {
    const { shop } = requireShop(req);
    const order = ownOrder(shop, req.params.id);
    if (!['shipped', 'delivered'].includes(order.status)) throw badRequest('Ship the order first');
    order.status = 'completed';
    order.deliveredAt ??= now();
    return sellerOrderView(order);
  }),
);

sellerRouter.post(
  '/orders/:id/refund',
  handle((req) => {
    const { shop } = requireShop(req);
    const order = ownOrder(shop, req.params.id);
    const cancel = order.status === 'paid';
    refundOrder(order, shop);
    order.status = cancel ? 'cancelled' : 'refunded';
    const reason = str(req.body.reason, 'Reason', { max: 500 });
    notify(order.buyerId, `Order #${order.receiptNo} was ${order.status} by ${shop.name}${reason ? `: ${reason}` : ''}`, `/purchases/${order.id}`);
    return sellerOrderView(order);
  }),
);

// ---- Reviews ---------------------------------------------------------------

sellerRouter.get(
  '/reviews',
  handle((req) => {
    const { shop } = requireShop(req);
    return db.reviews
      .filter((r) => r.shopId === shop.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r, buyerName: db.users.find((u) => u.id === r.buyerId)?.name, listingTitle: db.listings.find((l) => l.id === r.listingId)?.title }));
  }),
);

sellerRouter.post(
  '/reviews/:id/reply',
  handle((req) => {
    const { shop } = requireShop(req);
    const review = db.reviews.find((r) => r.id === req.params.id && r.shopId === shop.id);
    if (!review) throw notFound('Review not found');
    review.sellerReply = str(req.body.reply, 'Reply', { required: true, max: 2000 });
    return review;
  }),
);

// ---- Promotions (sales & coupons) -------------------------------------------

sellerRouter.get(
  '/promotions',
  handle((req) => {
    const { shop } = requireShop(req);
    return db.promotions.filter((p) => p.shopId === shop.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }),
);

sellerRouter.post(
  '/promotions',
  handle((req) => {
    const { shop } = requireShop(req);
    const kind = req.body.kind === 'coupon' ? 'coupon' : 'sale';
    const discountType = String(req.body.discountType) as DiscountType;
    if (!['percent', 'fixed', 'free_shipping'].includes(discountType)) throw badRequest('Choose a discount type');
    const value = discountType === 'free_shipping' ? 0 : int(req.body.value, 'Discount', { min: 1, max: discountType === 'percent' ? 75 : 1_000_000 });
    let code: string | undefined;
    if (kind === 'coupon') {
      code = str(req.body.code, 'Coupon code', { required: true, max: 20 }).toUpperCase();
      if (!/^[A-Z0-9]+$/.test(code)) throw badRequest('Coupon codes may only use letters and numbers');
      if (db.promotions.some((p) => p.shopId === shop.id && p.code === code)) throw badRequest('You already have a coupon with that code');
    } else if (discountType === 'free_shipping') {
      throw badRequest('Sales must be a percent or fixed discount — use a coupon for free shipping');
    }
    const promotion = {
      id: newId('prm'),
      shopId: shop.id,
      kind,
      code,
      discountType,
      value,
      minOrder: int(req.body.minOrder ?? 0, 'Minimum order', { min: 0 }),
      startsAt: req.body.startsAt ? new Date(req.body.startsAt).toISOString() : now(),
      endsAt: req.body.endsAt ? new Date(req.body.endsAt).toISOString() : undefined,
      active: true,
      timesUsed: 0,
      createdAt: now(),
    } as const;
    if (kind === 'sale') {
      // Only one shop-wide sale runs at a time.
      for (const p of db.promotions) if (p.shopId === shop.id && p.kind === 'sale') p.active = false;
    }
    db.promotions.push({ ...promotion });
    return promotion;
  }),
);

sellerRouter.post(
  '/promotions/:id/end',
  handle((req) => {
    const { shop } = requireShop(req);
    const promo = db.promotions.find((p) => p.id === req.params.id && p.shopId === shop.id);
    if (!promo) throw notFound('Promotion not found');
    promo.active = false;
    promo.endsAt = now();
    return promo;
  }),
);

// ---- Finances & stats ------------------------------------------------------

sellerRouter.get(
  '/finances',
  handle((req) => {
    const { shop } = requireShop(req);
    const entries = db.ledger.filter((e) => e.shopId === shop.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const sum = (types: string[]) => entries.filter((e) => types.includes(e.type)).reduce((s, e) => s + e.amount, 0);
    return {
      balance: shopBalance(shop.id),
      totals: {
        sales: sum(['sale', 'shipping']),
        fees: sum(['listing_fee', 'transaction_fee', 'processing_fee', 'ad_fee']),
        refunds: sum(['refund']),
        payouts: sum(['payout']),
      },
      feeSchedule: FEES,
      entries,
    };
  }),
);

sellerRouter.post(
  '/finances/payout',
  handle((req) => {
    const { shop, user } = requireShop(req);
    const balance = shopBalance(shop.id);
    if (balance <= 0) throw badRequest('No funds available for payout');
    ledger(shop.id, 'payout', -balance, `Payout to bank account`);
    notify(user.id, `Payout of ${formatMoney(balance)} is on its way`, '/seller/finances');
    return { amount: balance };
  }),
);

sellerRouter.get(
  '/stats',
  handle((req) => {
    const { shop } = requireShop(req);
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30) || 30));
    const since = Date.now() - days * 86_400_000;
    const orders = db.orders.filter((o) => o.shopId === shop.id && new Date(o.createdAt).getTime() >= since && o.status !== 'cancelled');
    const listings = db.listings.filter((l) => l.shopId === shop.id);
    const daily = new Map<string, { date: string; orders: number; revenue: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      daily.set(date, { date, orders: 0, revenue: 0 });
    }
    for (const o of orders) {
      const d = daily.get(o.createdAt.slice(0, 10));
      if (d) {
        d.orders += 1;
        d.revenue += o.total;
      }
    }
    const views = listings.reduce((s, l) => s + l.views, 0);
    const adClicks = db.adClicks.filter((c) => c.shopId === shop.id && new Date(c.createdAt).getTime() >= since);
    return {
      ...shopStats(shop.id),
      orders: orders.length,
      revenue: orders.reduce((s, o) => s + o.total, 0),
      views,
      conversionRate: views ? orders.length / views : 0,
      activeListings: listings.filter((l) => l.status === 'active').length,
      openOrders: db.orders.filter((o) => o.shopId === shop.id && o.status === 'paid').length,
      lateOrders: db.orders.filter((o) => o.shopId === shop.id && o.status === 'paid' && new Date(o.expectedShipBy) < new Date()).length,
      adClicks: adClicks.length,
      adSpend: adClicks.reduce((s, c) => s + c.cost, 0),
      daily: [...daily.values()],
      topListings: listings
        .map((l) => ({
          id: l.id,
          title: l.title,
          image: l.images[0],
          views: l.views,
          favorites: db.favorites.filter((f) => f.listingId === l.id).length,
          sold: db.orders.filter((o) => o.status !== 'cancelled').flatMap((o) => o.items).filter((i) => i.listingId === l.id).reduce((s, i) => s + i.quantity, 0),
        }))
        .sort((a, b) => b.sold - a.sold || b.views - a.views)
        .slice(0, 5),
    };
  }),
);
