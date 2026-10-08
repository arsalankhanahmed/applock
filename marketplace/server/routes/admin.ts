import { Router } from 'express';
import { db } from '../db.ts';
import { badRequest, handle, notFound } from '../http.ts';
import { publicUser, requireAdmin } from '../auth.ts';
import { notify } from '../services.ts';

export const adminRouter = Router();

// The marketplace's revenue is every fee charged to sellers, net of fee credits on refunds.
adminRouter.get(
  '/overview',
  handle((req) => {
    requireAdmin(req);
    const feeTypes = ['listing_fee', 'transaction_fee', 'processing_fee', 'ad_fee'];
    const revenueByType: Record<string, number> = {};
    for (const e of db.ledger) {
      if (!feeTypes.includes(e.type)) continue;
      revenueByType[e.type] = (revenueByType[e.type] ?? 0) - e.amount;
    }
    const liveOrders = db.orders.filter((o) => o.status !== 'cancelled' && o.status !== 'refunded');
    return {
      users: db.users.length,
      shops: db.shops.length,
      activeListings: db.listings.filter((l) => l.status === 'active').length,
      orders: db.orders.length,
      gmv: liveOrders.reduce((s, o) => s + o.total, 0),
      revenue: Object.values(revenueByType).reduce((s, v) => s + v, 0),
      revenueByType,
      openReports: db.reports.filter((r) => r.status === 'open').length,
    };
  }),
);

adminRouter.get(
  '/reports',
  handle((req) => {
    requireAdmin(req);
    return db.reports
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => {
        let target: { label: string; link: string } | undefined;
        if (r.targetType === 'listing') {
          const l = db.listings.find((x) => x.id === r.targetId);
          if (l) target = { label: l.title, link: `/listing/${l.id}` };
        } else if (r.targetType === 'shop') {
          const s = db.shops.find((x) => x.id === r.targetId);
          if (s) target = { label: s.name, link: `/shop/${s.slug}` };
        } else {
          const rev = db.reviews.find((x) => x.id === r.targetId);
          if (rev) target = { label: `Review: "${rev.text.slice(0, 60)}"`, link: `/listing/${rev.listingId}` };
        }
        return { ...r, target, reporterName: db.users.find((u) => u.id === r.reporterId)?.name };
      });
  }),
);

adminRouter.post(
  '/reports/:id',
  handle((req) => {
    requireAdmin(req);
    const report = db.reports.find((r) => r.id === req.params.id);
    if (!report) throw notFound();
    const action = String(req.body.action);
    if (action === 'dismiss') {
      report.status = 'dismissed';
    } else if (action === 'remove') {
      if (report.targetType === 'listing') {
        const listing = db.listings.find((l) => l.id === report.targetId);
        if (listing) {
          listing.status = 'inactive';
          const shop = db.shops.find((s) => s.id === listing.shopId);
          if (shop) notify(shop.ownerId, `Your listing "${listing.title}" was removed for violating marketplace policies`, `/seller/listings`);
        }
      } else if (report.targetType === 'shop') {
        const shop = db.shops.find((s) => s.id === report.targetId);
        if (shop) shop.status = 'suspended';
      } else {
        db.reviews = db.reviews.filter((r) => r.id !== report.targetId);
      }
      report.status = 'resolved';
    } else {
      throw badRequest('Unknown action');
    }
    return report;
  }),
);

adminRouter.get(
  '/users',
  handle((req) => {
    requireAdmin(req);
    return db.users.map((u) => ({ ...publicUser(u), shop: db.shops.find((s) => s.ownerId === u.id) }));
  }),
);

adminRouter.post(
  '/users/:id/suspend',
  handle((req) => {
    const admin = requireAdmin(req);
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) throw notFound();
    if (user.id === admin.id) throw badRequest("You can't suspend yourself");
    user.suspended = !user.suspended;
    const shop = db.shops.find((s) => s.ownerId === user.id);
    if (shop) shop.status = user.suspended ? 'suspended' : 'active';
    if (user.suspended) db.sessions = db.sessions.filter((s) => s.userId !== user.id);
    return { suspended: user.suspended };
  }),
);
