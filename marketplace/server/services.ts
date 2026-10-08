import { db, newId, now } from './db.ts';
import { badRequest } from './http.ts';
import { FEES, STAR_SELLER, formatMoney } from '../shared/config.ts';
import { applyDiscount, calculateSaleFees, describePromotion, isPromotionLive, shippingFor, unitPrice } from '../shared/fees.ts';
import type {
  Address,
  CartItem,
  CartShopGroup,
  LedgerType,
  Listing,
  ListingCard,
  Order,
  Promotion,
  Shop,
  ShopStats,
  User,
} from '../shared/types.ts';

export function notify(userId: string, text: string, link: string): void {
  db.notifications.push({ id: newId('ntf'), userId, text, link, read: false, createdAt: now() });
}

export function ledger(shopId: string, type: LedgerType, amount: number, description: string, refs: { orderId?: string; listingId?: string } = {}): void {
  if (amount === 0) return;
  db.ledger.push({ id: newId('led'), shopId, type, amount, description, ...refs, createdAt: now() });
}

export function shopBalance(shopId: string): number {
  return db.ledger.filter((e) => e.shopId === shopId).reduce((sum, e) => sum + e.amount, 0);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Publishing (or renewing) a listing charges the listing fee and extends its expiry. */
export function chargeListingFee(listing: Listing, reason: string): void {
  ledger(listing.shopId, 'listing_fee', -FEES.listingFee, `${reason}: ${listing.title}`, { listingId: listing.id });
  listing.publishedAt = now();
  listing.expiresAt = addDays(new Date(), FEES.listingDurationDays).toISOString();
}

/** Marks listings whose 4-month window has passed as expired (or auto-renews them). */
export function sweepExpiredListings(): void {
  const t = Date.now();
  for (const listing of db.listings) {
    if (listing.status !== 'active' || !listing.expiresAt || new Date(listing.expiresAt).getTime() > t) continue;
    if (listing.autoRenew) chargeListingFee(listing, 'Auto-renewal');
    else listing.status = 'expired';
  }
}

export function liveSale(shopId: string): Promotion | undefined {
  return db.promotions.find((p) => p.shopId === shopId && p.kind === 'sale' && isPromotionLive(p));
}

export function shopStats(shopId: string): ShopStats {
  const orders = db.orders.filter((o) => o.shopId === shopId && o.status !== 'cancelled' && o.status !== 'refunded');
  const reviews = db.reviews.filter((r) => r.shopId === shopId);
  const rating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
  const shipped = orders.filter((o) => o.shippedAt && o.items.some((i) => !i.isDigital));
  const onTime = shipped.filter((o) => o.tracking && new Date(o.shippedAt!) <= new Date(o.expectedShipBy)).length;
  const onTimeShippingRate = shipped.length ? onTime / shipped.length : 1;
  const sales = orders.reduce((s, o) => s + o.items.reduce((n, i) => n + i.quantity, 0), 0);
  return {
    sales,
    orderCount: orders.length,
    rating: Math.round(rating * 10) / 10,
    reviewCount: reviews.length,
    favorites: db.shopFavorites.filter((f) => f.shopId === shopId).length,
    onTimeShippingRate,
    starSeller:
      orders.length >= STAR_SELLER.minOrders && rating >= STAR_SELLER.minRating && onTimeShippingRate >= STAR_SELLER.minOnTimeShippingRate,
  };
}

export function listingRating(listingId: string): { rating: number; reviewCount: number } {
  const reviews = db.reviews.filter((r) => r.listingId === listingId);
  const rating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
  return { rating: Math.round(rating * 10) / 10, reviewCount: reviews.length };
}

export function salePrice(listing: Listing): number | undefined {
  const sale = liveSale(listing.shopId);
  if (!sale || sale.discountType === 'free_shipping') return undefined;
  const { discount } = applyDiscount(sale.discountType, sale.value, listing.price, 0);
  return discount > 0 ? listing.price - discount : undefined;
}

export function toCard(listing: Listing, user?: User, statsCache = new Map<string, ShopStats>()): ListingCard {
  const shop = db.shops.find((s) => s.id === listing.shopId)!;
  if (!statsCache.has(shop.id)) statsCache.set(shop.id, shopStats(shop.id));
  return {
    id: listing.id,
    title: listing.title,
    price: listing.price,
    salePrice: salePrice(listing),
    image: listing.images[0],
    shopId: shop.id,
    shopName: shop.name,
    shopSlug: shop.slug,
    ...listingRating(listing.id),
    freeShipping: listing.shipping.freeShipping || listing.isDigital,
    isDigital: listing.isDigital,
    type: listing.type,
    favorited: user ? db.favorites.some((f) => f.userId === user.id && f.listingId === listing.id) : false,
    starSeller: statsCache.get(shop.id)!.starSeller,
  };
}

/** Listings a shopper may see: active, in-stock, from an open (non-vacation, non-suspended) shop. */
export function isBuyable(listing: Listing): boolean {
  if (listing.status !== 'active' || listing.quantity <= 0) return false;
  const shop = db.shops.find((s) => s.id === listing.shopId);
  return Boolean(shop && shop.status === 'active' && !shop.vacationMode);
}

// ---- Cart & checkout -------------------------------------------------------

export function findPromotion(shopId: string, code: string | undefined): Promotion | undefined {
  if (code) {
    const coupon = db.promotions.find(
      (p) => p.shopId === shopId && p.kind === 'coupon' && p.code?.toUpperCase() === code.toUpperCase() && isPromotionLive(p),
    );
    if (coupon) return coupon;
  }
  return liveSale(shopId);
}

export function priceCart(userId: string, coupons: Record<string, string> = {}): CartShopGroup[] {
  const items = db.cart.filter((c) => c.userId === userId && !c.savedForLater);
  const byShop = new Map<string, CartItem[]>();
  for (const item of items) {
    const listing = db.listings.find((l) => l.id === item.listingId);
    if (!listing) continue;
    byShop.set(listing.shopId, [...(byShop.get(listing.shopId) ?? []), item]);
  }
  const groups: CartShopGroup[] = [];
  for (const [shopId, shopItems] of byShop) {
    const shop = db.shops.find((s) => s.id === shopId)!;
    const lines = shopItems.map((item) => {
      const listing = db.listings.find((l) => l.id === item.listingId)!;
      const price = unitPrice(listing, item.selections);
      return {
        ...item,
        listing: {
          id: listing.id,
          title: listing.title,
          image: listing.images[0],
          quantity: listing.quantity,
          status: listing.status,
          isDigital: listing.isDigital,
        },
        unitPrice: price,
        lineTotal: price * item.quantity,
        _listing: listing,
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    let shipping = shippingFor(lines.map((l) => ({ ...l._listing.shipping, quantity: l.quantity, isDigital: l._listing.isDigital })));
    let discount = 0;
    let appliedPromotion: CartShopGroup['appliedPromotion'];
    const promo = findPromotion(shopId, coupons[shopId]);
    if (promo && subtotal >= promo.minOrder) {
      const result = applyDiscount(promo.discountType, promo.value, subtotal, shipping);
      discount = result.discount;
      shipping = result.shipping;
      appliedPromotion = { code: promo.code, label: describePromotion(promo, formatMoney) };
    }
    groups.push({
      shop: { id: shop.id, name: shop.name, slug: shop.slug, vacationMode: shop.vacationMode },
      items: lines.map(({ _listing, ...rest }) => rest),
      subtotal,
      discount,
      shipping,
      total: subtotal - discount + shipping,
      appliedPromotion,
    });
  }
  return groups;
}

export function validateAddress(raw: unknown): Address {
  const a = (raw ?? {}) as Record<string, unknown>;
  const field = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');
  const address: Address = {
    name: field('name'),
    line1: field('line1'),
    line2: field('line2'),
    city: field('city'),
    state: field('state'),
    postalCode: field('postalCode'),
    country: field('country'),
  };
  for (const k of ['name', 'line1', 'city', 'postalCode', 'country'] as const) {
    if (!address[k]) throw badRequest(`Shipping address: ${k} is required`);
  }
  return address;
}

/**
 * Turns the buyer's cart into one order per shop, decrements stock, and books the
 * seller's ledger: sale + shipping credits, minus transaction, processing and renewal fees.
 * Payment capture is simulated — plug a real gateway in here.
 */
export function checkout(user: User, input: { address: Address; coupons: Record<string, string>; giftShops: string[]; giftMessages: Record<string, string>; notes: Record<string, string> }): Order[] {
  const groups = priceCart(user.id, input.coupons);
  if (groups.length === 0) throw badRequest('Your cart is empty');

  for (const group of groups) {
    if (group.shop.vacationMode) throw badRequest(`${group.shop.name} is on vacation and not taking orders`);
    for (const item of group.items) {
      const listing = db.listings.find((l) => l.id === item.listingId)!;
      if (!isBuyable(listing)) throw badRequest(`"${listing.title}" is no longer available`);
      if (item.quantity > listing.quantity) throw badRequest(`Only ${listing.quantity} of "${listing.title}" left`);
      for (const v of listing.variations) {
        if (!item.selections[v.name]) throw badRequest(`Choose a ${v.name} for "${listing.title}"`);
      }
      if (listing.personalization.enabled && listing.personalization.required && !item.personalization) {
        throw badRequest(`"${listing.title}" needs personalization details`);
      }
    }
  }

  const orders: Order[] = [];
  for (const group of groups) {
    const shop = db.shops.find((s) => s.id === group.shop.id)!;
    const createdAt = new Date();
    const lines = group.items.map((item) => {
      const listing = db.listings.find((l) => l.id === item.listingId)!;
      listing.quantity -= item.quantity;
      if (listing.quantity === 0) listing.status = 'sold_out';
      return { item, listing };
    });
    const processingDays = Math.max(shop.policies.processingDays, ...lines.map((l) => l.listing.shipping.processingDays));
    const fees = calculateSaleFees({
      itemsAfterDiscount: group.subtotal - group.discount,
      shipping: group.shipping,
      total: group.total,
      lines: lines.map(({ item, listing }) => ({ quantity: item.quantity, remainingStock: listing.quantity, autoRenew: listing.autoRenew })),
    });
    const order: Order = {
      id: newId('ord'),
      receiptNo: ++db.counters.receiptNo,
      buyerId: user.id,
      shopId: shop.id,
      items: lines.map(({ item, listing }) => ({
        listingId: listing.id,
        title: listing.title,
        image: listing.images[0],
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        selections: item.selections,
        personalization: item.personalization,
        isDigital: listing.isDigital,
        digitalFileUrl: listing.digitalFileUrl,
      })),
      subtotal: group.subtotal,
      discount: group.discount,
      shipping: group.shipping,
      total: group.total,
      couponCode: group.appliedPromotion?.code,
      isGift: input.giftShops.includes(shop.id),
      giftMessage: input.giftMessages[shop.id] ?? '',
      noteToSeller: input.notes[shop.id] ?? '',
      shippingAddress: input.address,
      status: 'paid',
      fees,
      createdAt: createdAt.toISOString(),
      expectedShipBy: addDays(createdAt, processingDays).toISOString(),
    };
    if (order.items.every((i) => i.isDigital)) {
      order.status = 'completed';
      order.deliveredAt = order.createdAt;
    }
    db.orders.push(order);

    const promo = findPromotion(shop.id, input.coupons[shop.id]);
    if (promo && group.appliedPromotion) promo.timesUsed += 1;

    const ref = { orderId: order.id };
    ledger(shop.id, 'sale', group.subtotal - group.discount, `Sale — order #${order.receiptNo}`, ref);
    ledger(shop.id, 'shipping', group.shipping, `Shipping — order #${order.receiptNo}`, ref);
    ledger(shop.id, 'transaction_fee', -fees.transactionFee, `Transaction fee — order #${order.receiptNo}`, ref);
    ledger(shop.id, 'processing_fee', -fees.processingFee, `Payment processing fee — order #${order.receiptNo}`, ref);
    for (const { item, listing } of lines) {
      const renewals = Math.max(0, item.quantity - 1) + (listing.autoRenew && listing.quantity > 0 ? 1 : 0);
      if (renewals > 0) {
        ledger(shop.id, 'listing_fee', -renewals * FEES.listingFee, `Listing renewal (sold) ×${renewals}: ${listing.title}`, { ...ref, listingId: listing.id });
      }
      if (listing.autoRenew && listing.quantity > 0) {
        listing.publishedAt = now();
        listing.expiresAt = addDays(new Date(), FEES.listingDurationDays).toISOString();
      }
    }

    notify(shop.ownerId, `New order #${order.receiptNo} from ${user.name} — ${formatMoney(order.total)}`, `/seller/orders/${order.id}`);
    notify(user.id, `Order #${order.receiptNo} from ${shop.name} confirmed`, `/purchases/${order.id}`);
    orders.push(order);
  }

  db.cart = db.cart.filter((c) => c.userId !== user.id || c.savedForLater);
  return orders;
}

export function refundOrder(order: Order, shop: Shop): void {
  if (order.status === 'refunded' || order.status === 'cancelled') throw badRequest('Order already closed');
  // The seller returns what the buyer paid; the marketplace refunds its transaction fee
  // but (like Etsy) keeps the payment processing fee.
  const ref = { orderId: order.id };
  ledger(shop.id, 'refund', -order.total, `Refund — order #${order.receiptNo}`, ref);
  ledger(shop.id, 'transaction_fee', order.fees.transactionFee, `Transaction fee credit — order #${order.receiptNo}`, ref);
  for (const item of order.items) {
    const listing = db.listings.find((l) => l.id === item.listingId);
    if (!listing) continue;
    listing.quantity += item.quantity;
    if (listing.status === 'sold_out') listing.status = 'active';
  }
}

/** Charges the seller for an ad click if the shop still has budget left today. */
export function recordAdClick(listing: Listing): void {
  const shop = db.shops.find((s) => s.id === listing.shopId);
  if (!shop || !listing.promoted || shop.adsDailyBudget <= 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const spent = db.adClicks.filter((c) => c.shopId === shop.id && c.createdAt.startsWith(today)).reduce((s, c) => s + c.cost, 0);
  if (spent + FEES.adCostPerClick > shop.adsDailyBudget) return;
  db.adClicks.push({ id: newId('ad'), shopId: shop.id, listingId: listing.id, cost: FEES.adCostPerClick, createdAt: now() });
  ledger(shop.id, 'ad_fee', -FEES.adCostPerClick, `Ad click: ${listing.title}`, { listingId: listing.id });
}

export function adBudgetLeft(shop: Shop): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const spent = db.adClicks.filter((c) => c.shopId === shop.id && c.createdAt.startsWith(today)).reduce((s, c) => s + c.cost, 0);
  return spent + FEES.adCostPerClick <= shop.adsDailyBudget;
}
