import { Router } from 'express';
import { db } from '../db.ts';
import { handle, notFound } from '../http.ts';
import { optionalUser } from '../auth.ts';
import { adBudgetLeft, isBuyable, liveSale, listingRating, recordAdClick, salePrice, shopStats, toCard } from '../services.ts';
import { CATEGORIES, categoryPath, categoryTree } from '../../shared/categories.ts';
import type { Listing, ShopStats, User } from '../../shared/types.ts';

export const catalogRouter = Router();

catalogRouter.get('/categories', handle(() => CATEGORIES));

function reviewView(r: (typeof db.reviews)[number]) {
  const buyer = db.users.find((u) => u.id === r.buyerId);
  const listing = db.listings.find((l) => l.id === r.listingId);
  return { ...r, buyerName: buyer?.name ?? 'Former member', buyerAvatar: buyer?.avatar, listingTitle: listing?.title, listingImage: listing?.images[0] };
}

catalogRouter.get(
  '/home',
  handle((req) => {
    const user = optionalUser(req);
    const cache = new Map<string, ShopStats>();
    const live = db.listings.filter(isBuyable);
    const popularity = (l: Listing) => l.views + db.favorites.filter((f) => f.listingId === l.id).length * 5 + listingRating(l.id).reviewCount * 10;
    const onSale = live.filter((l) => salePrice(l) !== undefined);
    const shops = db.shops
      .filter((s) => s.status === 'active')
      .map((s) => ({ id: s.id, name: s.name, slug: s.slug, logo: s.logo, banner: s.banner, tagline: s.tagline, location: s.location, ...shopStats(s.id) }))
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 6);
    return {
      popular: [...live].sort((a, b) => popularity(b) - popularity(a)).slice(0, 12).map((l) => toCard(l, user, cache)),
      fresh: [...live].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')).slice(0, 8).map((l) => toCard(l, user, cache)),
      onSale: onSale.slice(0, 8).map((l) => toCard(l, user, cache)),
      vintage: live.filter((l) => l.type === 'vintage').slice(0, 4).map((l) => toCard(l, user, cache)),
      shops,
      recentlyFavorited: user
        ? db.favorites
            .filter((f) => f.userId === user.id)
            .map((f) => db.listings.find((l) => l.id === f.listingId))
            .filter((l): l is Listing => Boolean(l && isBuyable(l)))
            .slice(-6)
            .map((l) => toCard(l, user, cache))
        : [],
    };
  }),
);

function textScore(listing: Listing, terms: string[], shopName: string): number {
  if (terms.length === 0) return 1;
  const title = listing.title.toLowerCase();
  const tags = listing.tags.join(' ').toLowerCase();
  const materials = listing.materials.join(' ').toLowerCase();
  const desc = listing.description.toLowerCase();
  const shop = shopName.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let termScore = 0;
    if (title.includes(term)) termScore += 5;
    if (tags.includes(term)) termScore += 3;
    if (materials.includes(term)) termScore += 2;
    if (shop.includes(term)) termScore += 2;
    if (desc.includes(term)) termScore += 1;
    if (termScore === 0) return 0; // every term must match somewhere
    score += termScore;
  }
  return score;
}

catalogRouter.get(
  '/search',
  handle((req) => {
    const user = optionalUser(req);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const category = String(req.query.category ?? '');
    const min = req.query.min ? Number(req.query.min) * 100 : undefined;
    const max = req.query.max ? Number(req.query.max) * 100 : undefined;
    const type = String(req.query.type ?? '');
    const shipsFrom = String(req.query.shipsFrom ?? '').toLowerCase();
    const sort = String(req.query.sort ?? 'relevance');
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = 24;
    const allowedCategories = category ? new Set(categoryTree(category)) : undefined;

    const matches: { listing: Listing; score: number; price: number }[] = [];
    for (const listing of db.listings) {
      if (!isBuyable(listing)) continue;
      if (allowedCategories && !allowedCategories.has(listing.categoryId)) continue;
      if (type && listing.type !== type) continue;
      if (req.query.freeShipping === '1' && !(listing.shipping.freeShipping || listing.isDigital)) continue;
      if (req.query.digital === '1' && !listing.isDigital) continue;
      if (req.query.personalizable === '1' && !listing.personalization.enabled) continue;
      if (shipsFrom && !listing.shipping.shipsFrom.toLowerCase().includes(shipsFrom)) continue;
      const price = salePrice(listing) ?? listing.price;
      if (req.query.onSale === '1' && price === listing.price) continue;
      if (min !== undefined && price < min) continue;
      if (max !== undefined && price > max) continue;
      const shop = db.shops.find((s) => s.id === listing.shopId)!;
      const score = textScore(listing, terms, shop.name);
      if (score === 0) continue;
      matches.push({ listing, score, price });
    }

    const sorters: Record<string, (a: (typeof matches)[number], b: (typeof matches)[number]) => number> = {
      relevance: (a, b) => b.score - a.score || b.listing.views - a.listing.views,
      price_asc: (a, b) => a.price - b.price,
      price_desc: (a, b) => b.price - a.price,
      newest: (a, b) => (b.listing.publishedAt ?? '').localeCompare(a.listing.publishedAt ?? ''),
      top_rated: (a, b) => listingRating(b.listing.id).rating - listingRating(a.listing.id).rating,
    };
    matches.sort(sorters[sort] ?? sorters.relevance);

    // Promoted listings matching the query appear in a separate "Ad" row, Etsy-style.
    const cache = new Map<string, ShopStats>();
    const ads = page === 1
      ? matches
          .filter((m) => m.listing.promoted && adBudgetLeft(db.shops.find((s) => s.id === m.listing.shopId)!))
          .slice(0, 4)
          .map((m) => ({ ...toCard(m.listing, user, cache), promoted: true }))
      : [];

    return {
      ads,
      results: matches.slice((page - 1) * pageSize, page * pageSize).map((m) => toCard(m.listing, user, cache)),
      total: matches.length,
      page,
      pages: Math.max(1, Math.ceil(matches.length / pageSize)),
      categoryPath: category ? categoryPath(category) : [],
    };
  }),
);

function canSeeListing(listing: Listing, user?: User): boolean {
  if (isBuyable(listing) || listing.status === 'sold_out') return true;
  const shop = db.shops.find((s) => s.id === listing.shopId);
  return Boolean(user && (shop?.ownerId === user.id || user.role === 'admin'));
}

catalogRouter.get(
  '/listings/:id',
  handle((req) => {
    const user = optionalUser(req);
    const listing = db.listings.find((l) => l.id === req.params.id);
    if (!listing || !canSeeListing(listing, user)) throw notFound('Listing not found');
    const shop = db.shops.find((s) => s.id === listing.shopId)!;
    const isOwner = user?.id === shop.ownerId;
    if (!isOwner) {
      listing.views += 1;
      if (req.query.ad === '1') recordAdClick(listing);
    }
    const cache = new Map<string, ShopStats>();
    const owner = db.users.find((u) => u.id === shop.ownerId);
    const reviews = db.reviews.filter((r) => r.listingId === listing.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const shopReviews = db.reviews.filter((r) => r.shopId === shop.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const sale = liveSale(shop.id);
    const { digitalFileUrl: _secret, ...publicListing } = listing;
    return {
      listing: isOwner ? listing : publicListing,
      salePrice: salePrice(listing),
      sale: sale ? { discountType: sale.discountType, value: sale.value, endsAt: sale.endsAt, minOrder: sale.minOrder } : undefined,
      favorites: db.favorites.filter((f) => f.listingId === listing.id).length,
      favorited: user ? db.favorites.some((f) => f.userId === user.id && f.listingId === listing.id) : false,
      inCarts: db.cart.filter((c) => c.listingId === listing.id && !c.savedForLater).length,
      isOwner,
      shop: {
        id: shop.id,
        name: shop.name,
        slug: shop.slug,
        logo: shop.logo,
        location: shop.location,
        policies: shop.policies,
        vacationMode: shop.vacationMode,
        vacationMessage: shop.vacationMessage,
        ownerName: owner?.name,
        ownerAvatar: owner?.avatar,
        ...shopStats(shop.id),
      },
      ...listingRating(listing.id),
      reviews: reviews.slice(0, 20).map(reviewView),
      shopReviews: shopReviews.slice(0, 10).map(reviewView),
      categoryPath: categoryPath(listing.categoryId),
      moreFromShop: db.listings
        .filter((l) => l.shopId === shop.id && l.id !== listing.id && isBuyable(l))
        .slice(0, 8)
        .map((l) => toCard(l, user, cache)),
      similar: db.listings
        .filter((l) => l.categoryId === listing.categoryId && l.shopId !== shop.id && isBuyable(l))
        .slice(0, 8)
        .map((l) => toCard(l, user, cache)),
    };
  }),
);

catalogRouter.get(
  '/shops/:slug',
  handle((req) => {
    const user = optionalUser(req);
    const shop = db.shops.find((s) => s.slug === req.params.slug);
    if (!shop || (shop.status !== 'active' && user?.role !== 'admin' && user?.id !== shop.ownerId)) throw notFound('Shop not found');
    const owner = db.users.find((u) => u.id === shop.ownerId);
    const cache = new Map<string, ShopStats>();
    const listings = db.listings.filter((l) => l.shopId === shop.id && (l.status === 'active' || l.status === 'sold_out'));
    const sale = liveSale(shop.id);
    return {
      shop,
      owner: owner ? { id: owner.id, name: owner.name, avatar: owner.avatar, bio: owner.bio } : undefined,
      stats: shopStats(shop.id),
      favorited: user ? db.shopFavorites.some((f) => f.userId === user.id && f.shopId === shop.id) : false,
      isOwner: user?.id === shop.ownerId,
      sale: sale ? { discountType: sale.discountType, value: sale.value, endsAt: sale.endsAt, minOrder: sale.minOrder } : undefined,
      listings: listings
        .sort((a, b) => Number(b.featured) - Number(a.featured))
        .map((l) => ({ ...toCard(l, user, cache), sectionId: l.sectionId, soldOut: l.status === 'sold_out', featured: l.featured })),
      reviews: db.reviews.filter((r) => r.shopId === shop.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(reviewView),
    };
  }),
);

catalogRouter.get(
  '/people/:id',
  handle((req) => {
    const viewer = optionalUser(req);
    const person = db.users.find((u) => u.id === req.params.id);
    if (!person) throw notFound('Member not found');
    const shop = db.shops.find((s) => s.ownerId === person.id && s.status === 'active');
    const cache = new Map<string, ShopStats>();
    return {
      id: person.id,
      name: person.name,
      avatar: person.avatar,
      bio: person.bio,
      joined: person.createdAt,
      shop: shop ? { name: shop.name, slug: shop.slug } : undefined,
      collections: db.collections
        .filter((c) => c.userId === person.id && (c.isPublic || viewer?.id === person.id))
        .map((c) => ({
          ...c,
          listings: c.listingIds
            .map((id) => db.listings.find((l) => l.id === id))
            .filter((l): l is Listing => Boolean(l && isBuyable(l)))
            .map((l) => toCard(l, viewer, cache)),
        })),
    };
  }),
);
