# Hunar Bazaar: an Etsy-style marketplace

A full-stack marketplace for handmade, vintage and craft-supply goods. It follows Etsy's business model: anyone can open a shop, and the marketplace earns money from listing fees, transaction fees, payment processing and seller ads.

**Stack:** React 19 + Vite + Tailwind 4 on the front end. Express + TypeScript on the back end. Data is kept in a JSON file store.

## Run it

```bash
cd marketplace
npm install
npm run dev        # http://localhost:3000 (API + Vite dev server)
npm test           # fee unit tests + end-to-end API tests
npm run lint       # type-check
npm run build && npm start   # production build
```

On first start, demo data is seeded into `data/db.json`. Delete the `data/` folder to reset it. Every demo account uses the password `password123`:

| Role | Email |
| --- | --- |
| Buyer | `buyer@demo.test` |
| Sellers | `maya@demo.test`, `omar@demo.test`, `zara@demo.test`, `ali@demo.test` |
| Admin | `admin@demo.test` |

Demo coupon: `WELCOME10` at MayaCrafts. LoomHouse is running a 15% shop-wide sale.

## Business model (fees)

All amounts are set in `shared/config.ts` and calculated in `shared/fees.ts`. Every charge and credit is written to each shop's ledger, which the seller sees as "Finances".

| Fee | Default | When |
| --- | --- | --- |
| Listing fee | $0.20 | On publish, manual renewal, auto-renewal every 4 months, and auto-renewal after each sale (charged per extra unit sold) |
| Transaction fee | 6.5% | Of (items after discount + shipping), on every order. Credited back on refund |
| Payment processing | 3% + $0.25 | Of the order total. Not refunded |
| Ads | $0.25 per click | Only on promoted listings, capped by the shop's daily budget |

Admins see the marketplace's total revenue (all fees) and GMV in `/admin`.

## Features

**Buyers**
- Home page with category browsing, popular items, sales, new items, vintage and featured shops
- Search with relevance ranking. Filters: category tree, price range, free shipping, on sale, digital, personalizable, item type, shop location. Sorting and paging. An "Ad" row for promoted listings
- Listing page: photo gallery, variations with price changes, quantity, personalization, sale prices, item and shop reviews, shipping and return policies, "more from this shop", similar items, "in N carts"
- Favorite items and shops, plus public or private collections
- Cart grouped by shop, save for later, per-shop coupon codes, shipping that combines items within a shop
- Checkout: shipping address (can be saved), gift orders with a message, a note to the seller, and one order per shop
- Purchases: tracking, "mark as received", instant digital downloads, reviews with a 1–5 star rating and a photo
- Buyer–seller messaging tied to a listing or an order
- Notifications, account settings, public profile, and reporting a listing or shop

**Sellers (Shop Manager at `/seller`)**
- Open a shop: name, URL slug, icon, banner, announcement, about, sections, policies and vacation mode
- Listing editor: up to 10 photos, type (handmade, vintage or supply), category, 13 tags, materials, up to 2 variations, personalization, physical or digital file, shipping profile, auto-renew, featured, promoted
- Listing states: active, draft, sold out, inactive and expired. Listings can be renewed, copied or deleted
- Orders: ship with tracking, complete, cancel or refund (restores stock and credits fees back), packing slip, and a per-order breakdown of fees and earnings
- Reply to reviews
- Marketing: shop-wide sales, coupon codes (percent, fixed or free shipping, with a minimum order and an end date), ad budget
- Finances: balance, full ledger, payouts
- Dashboard: revenue chart, views, conversion, late-order alerts, top listings, Star Seller progress (rating ≥ 4.8, ≥ 95% on-time shipping with tracking, ≥ 5 orders)

**Admin (`/admin`)**
- Revenue split by fee type, GMV, user, shop and listing counts
- Report queue: dismiss, or take down the listing, shop or review
- Suspend or reinstate members (this also suspends their shop)

## Layout

```
shared/   types, fee math, categories, config (used by client and server)
server/   express app, routes (account, catalog, buyer, messages, seller, admin), services, seed
src/      React app: pages/, pages/seller/, components/
tests/    node:test unit + API tests
```

## Before going live

- **Payments:** checkout records orders as paid without charging anyone. Connect a real gateway (Stripe Connect, PayFast, JazzCash or Easypaisa) in `server/services.ts → checkout()`, and send payouts through it in `/seller/finances/payout`.
- **Database:** the JSON store suits one server. Move to Postgres (with Prisma or Drizzle) before you scale out.
- **File storage:** uploads go to `data/uploads`. Use S3 or Cloudflare R2 and a CDN in production.
- **Also missing:** email (order confirmations, password reset), sales tax/VAT, shipping-label purchase, multi-currency, gift cards, and an offsite-ads programme.
