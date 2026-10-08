import { db, newId, now, resetDatabase, emptyDatabase } from './db.ts';
import { hashPassword } from './auth.ts';
import { chargeListingFee, checkout } from './services.ts';
import type { Listing, Shop, User } from '../shared/types.ts';

const img = (hue: number, emoji: string) => `/placeholder/${hue}/${encodeURIComponent(emoji)}.svg`;

function user(email: string, name: string, role: User['role'] = 'user'): User {
  const u: User = { id: newId('usr'), email, name, passwordHash: hashPassword('password123'), role, createdAt: now() };
  db.users.push(u);
  return u;
}

function shop(owner: User, name: string, tagline: string, location: string, logo: string, banner: string, sections: string[]): Shop {
  const s: Shop = {
    id: newId('shp'),
    ownerId: owner.id,
    name,
    slug: name.toLowerCase(),
    tagline,
    about: `Hi, I'm ${owner.name.split(' ')[0]}! Everything in ${name} is made or sourced by me with a lot of care. Message me any time with questions or custom requests.`,
    announcement: 'Welcome! Custom orders are open — send me a message.',
    location,
    logo,
    banner,
    sections: sections.map((n) => ({ id: newId('sec'), name: n })),
    policies: {
      processingDays: 3,
      shipping: 'Orders are carefully packed and shipped with tracking.',
      returns: 'Returns accepted within 14 days of delivery. Buyers pay return shipping.',
      acceptsReturns: true,
      returnWindowDays: 14,
      privacy: 'Your information is only used to complete your order.',
    },
    vacationMode: false,
    vacationMessage: '',
    adsDailyBudget: 500,
    status: 'active',
    createdAt: now(),
  };
  db.shops.push(s);
  owner.shopId = s.id;
  return s;
}

interface ListingSeed {
  title: string;
  price: number;
  categoryId: string;
  emoji: string;
  hue: number;
  tags: string[];
  materials?: string[];
  type?: Listing['type'];
  quantity?: number;
  isDigital?: boolean;
  variations?: Listing['variations'];
  personalize?: string;
  shipping?: number;
  freeShipping?: boolean;
  section?: number;
  promoted?: boolean;
  featured?: boolean;
  views?: number;
}

function listing(s: Shop, seed: ListingSeed): Listing {
  const l: Listing = {
    id: newId('lst'),
    shopId: s.id,
    title: seed.title,
    description: `${seed.title}.\n\nEach piece is made to order in my studio, so small variations make every item unique.\n\n• Carefully packaged, ready for gifting\n• Message me for custom sizes or colours`,
    price: seed.price,
    quantity: seed.quantity ?? 10,
    images: [img(seed.hue, seed.emoji), img(seed.hue + 30, seed.emoji), img(seed.hue + 60, seed.emoji)],
    categoryId: seed.categoryId,
    tags: seed.tags,
    materials: seed.materials ?? [],
    type: seed.type ?? 'handmade',
    isDigital: Boolean(seed.isDigital),
    digitalFileUrl: seed.isDigital ? img(seed.hue, seed.emoji) : undefined,
    variations: seed.variations ?? [],
    personalization: { enabled: Boolean(seed.personalize), required: false, instructions: seed.personalize ?? '' },
    shipping: {
      cost: seed.isDigital ? 0 : seed.shipping ?? 499,
      additionalItemCost: seed.isDigital ? 0 : 150,
      freeShipping: Boolean(seed.isDigital || seed.freeShipping),
      shipsFrom: s.location,
      processingDays: 3,
    },
    sectionId: seed.section !== undefined ? s.sections[seed.section]?.id : undefined,
    status: 'active',
    autoRenew: true,
    promoted: Boolean(seed.promoted),
    featured: Boolean(seed.featured),
    views: seed.views ?? Math.floor(Math.random() * 400),
    createdAt: now(),
  };
  chargeListingFee(l, 'Listing fee');
  db.listings.push(l);
  return l;
}

export function seed(): void {
  resetDatabase(emptyDatabase());

  user('admin@demo.test', 'Marketplace Admin', 'admin');
  const buyer = user('buyer@demo.test', 'Sara Khan');
  buyer.address = { name: 'Sara Khan', line1: '12 Garden Road', city: 'Lahore', postalCode: '54000', country: 'Pakistan' };
  const buyers = [buyer, user('hamza@demo.test', 'Hamza Ali'), user('emma@demo.test', 'Emma Brown')];
  for (const b of buyers.slice(1)) b.address = { name: b.name, line1: '1 Main Street', city: 'Karachi', postalCode: '74000', country: 'Pakistan' };

  const maya = shop(user('maya@demo.test', 'Maya Siddiqui'), 'MayaCrafts', 'Minimal handmade jewelry in silver & gold', 'Lahore, Pakistan', img(20, '💍'), img(25, '✨'), ['Necklaces', 'Earrings', 'Rings']);
  const omar = shop(user('omar@demo.test', 'Omar Farooq'), 'OldTownVintage', 'Curated vintage finds from the 60s–90s', 'Karachi, Pakistan', img(200, '📻'), img(210, '🕰'), ['Home', 'Fashion']);
  const zara = shop(user('zara@demo.test', 'Zara Ahmed'), 'PaperAndInk', 'Printable art & wedding stationery', 'Islamabad, Pakistan', img(300, '🖋'), img(310, '🎨'), ['Prints', 'Wedding']);
  const ali = shop(user('ali@demo.test', 'Ali Raza'), 'LoomHouse', 'Hand-woven rugs, throws & cushions', 'Multan, Pakistan', img(30, '🧶'), img(40, '🏺'), ['Rugs', 'Cushions', 'Pottery']);

  const metal = { name: 'Metal', options: [{ value: 'Sterling silver', priceDelta: 0 }, { value: '18k gold plated', priceDelta: 800 }] };
  const length = { name: 'Length', options: [{ value: '16 inch', priceDelta: 0 }, { value: '18 inch', priceDelta: 0 }, { value: '20 inch', priceDelta: 200 }] };
  const size = { name: 'Size', options: ['5', '6', '7', '8', '9'].map((v) => ({ value: v, priceDelta: 0 })) };

  const necklace = listing(maya, { title: 'Personalized name necklace — dainty script pendant', price: 3200, categoryId: 'necklaces', emoji: '📿', hue: 15, tags: ['name necklace', 'personalized', 'gift for her', 'minimal'], materials: ['sterling silver'], variations: [metal, length], personalize: 'Enter the name (max 10 letters)', section: 0, promoted: true, featured: true, views: 1200 });
  const hoops = listing(maya, { title: 'Hammered gold hoop earrings', price: 2400, categoryId: 'earrings', emoji: '⭕', hue: 40, tags: ['hoops', 'gold earrings', 'everyday'], materials: ['brass', 'gold plating'], section: 1, views: 800 });
  const ring = listing(maya, { title: 'Stackable birthstone ring', price: 1800, categoryId: 'rings', emoji: '💍', hue: 330, tags: ['birthstone', 'stacking ring', 'gift'], materials: ['sterling silver', 'gemstone'], variations: [size], section: 2, freeShipping: true });
  listing(maya, { title: 'Pearl drop earrings — bridal', price: 2900, categoryId: 'earrings', emoji: '🦪', hue: 190, tags: ['pearl', 'bridal', 'wedding jewelry'], materials: ['freshwater pearl'], section: 1 });
  listing(maya, { title: 'Initial charm bracelet', price: 2100, categoryId: 'jewelry', emoji: '🔗', hue: 50, tags: ['initial', 'bracelet', 'personalized'], personalize: 'Which initial?', section: 0 });

  const radio = listing(omar, { title: 'Vintage 1970s transistor radio — working', price: 8500, categoryId: 'vintage', emoji: '📻', hue: 210, tags: ['retro', 'radio', '70s', 'collectible'], type: 'vintage', quantity: 1, section: 0, promoted: true, views: 640 });
  listing(omar, { title: 'Mid-century brass table lamp', price: 12000, categoryId: 'lighting', emoji: '💡', hue: 45, tags: ['mid century', 'brass', 'lamp'], type: 'vintage', quantity: 1, shipping: 1999, section: 0 });
  listing(omar, { title: '90s denim jacket — oversized', price: 4500, categoryId: 'womens', emoji: '🧥', hue: 220, tags: ['90s', 'denim', 'jacket', 'streetwear'], type: 'vintage', quantity: 1, section: 1 });
  listing(omar, { title: 'Set of 4 vintage tea cups', price: 3800, categoryId: 'kitchen', emoji: '☕', hue: 170, tags: ['tea cups', 'china', 'floral'], type: 'vintage', quantity: 2, section: 0 });
  listing(omar, { title: 'Antique pocket watch', price: 15500, categoryId: 'vintage', emoji: '⏱', hue: 35, tags: ['antique', 'watch', 'gift for him'], type: 'vintage', quantity: 1 });

  const print = listing(zara, { title: 'Botanical wall art — printable download set of 3', price: 900, categoryId: 'digital-art', emoji: '🌿', hue: 110, tags: ['printable', 'botanical', 'wall art', 'digital download'], isDigital: true, quantity: 999, section: 0, featured: true, views: 900 });
  listing(zara, { title: 'Wedding invitation template — editable', price: 1500, categoryId: 'invitations', emoji: '💌', hue: 345, tags: ['wedding', 'invitation', 'template', 'editable'], isDigital: true, quantity: 999, section: 1, promoted: true });
  listing(zara, { title: 'Hand-lettered calligraphy name print', price: 2500, categoryId: 'prints', emoji: '🖋', hue: 280, tags: ['calligraphy', 'custom', 'nursery'], personalize: 'Name to letter', section: 0 });
  listing(zara, { title: 'Watercolor city skyline painting', price: 6000, categoryId: 'paintings', emoji: '🏙', hue: 195, tags: ['watercolor', 'original art', 'city'], quantity: 1, section: 0 });

  const rug = listing(ali, { title: 'Hand-woven kilim rug — 4×6 ft', price: 18900, categoryId: 'decor', emoji: '🟥', hue: 5, tags: ['kilim', 'rug', 'boho', 'handwoven'], materials: ['wool', 'cotton'], shipping: 2500, section: 0, featured: true, views: 500 });
  const cushion = listing(ali, { title: 'Block-print cushion cover', price: 1600, categoryId: 'decor', emoji: '🛋', hue: 25, tags: ['cushion', 'block print', 'cotton'], materials: ['cotton'], variations: [{ name: 'Size', options: [{ value: '16×16', priceDelta: 0 }, { value: '18×18', priceDelta: 300 }, { value: '20×20', priceDelta: 500 }] }], section: 1 });
  listing(ali, { title: 'Blue pottery serving bowl', price: 3400, categoryId: 'kitchen', emoji: '🥣', hue: 215, tags: ['blue pottery', 'multan', 'ceramic', 'bowl'], materials: ['ceramic'], section: 2 });
  listing(ali, { title: 'Chunky knit throw blanket', price: 7800, categoryId: 'decor', emoji: '🧶', hue: 60, tags: ['throw', 'knit', 'cozy'], materials: ['merino wool'], freeShipping: true, section: 1 });
  listing(ali, { title: 'Cotton yarn bundle — 6 colours', price: 2200, categoryId: 'fabric', emoji: '🧵', hue: 140, tags: ['yarn', 'craft supplies', 'cotton'], type: 'supplies', quantity: 40 });

  // Promotions: a shop-wide sale and a coupon.
  db.promotions.push(
    { id: newId('prm'), shopId: ali.id, kind: 'sale', discountType: 'percent', value: 15, minOrder: 0, startsAt: now(), active: true, timesUsed: 0, createdAt: now() },
    { id: newId('prm'), shopId: maya.id, kind: 'coupon', code: 'WELCOME10', discountType: 'percent', value: 10, minOrder: 2000, startsAt: now(), active: true, timesUsed: 0, createdAt: now() },
  );

  // Historic orders go through the real checkout so the ledger and stock stay consistent.
  const purchases: [User, Listing, Record<string, string>, number, string][] = [
    [buyers[0], necklace, { Metal: 'Sterling silver', Length: '18 inch' }, 5, 'Absolutely beautiful, the name is perfect. Fast shipping too!'],
    [buyers[1], necklace, { Metal: '18k gold plated', Length: '16 inch' }, 5, 'Bought for my sister, she loved it.'],
    [buyers[2], hoops, {}, 5, 'Lightweight and gorgeous.'],
    [buyers[0], ring, { Size: '7' }, 5, 'Dainty and well made.'],
    [buyers[1], hoops, {}, 4, 'Lovely, slightly smaller than expected.'],
    [buyers[2], necklace, { Metal: 'Sterling silver', Length: '20 inch' }, 5, 'Second one I have ordered. Love it!'],
    [buyers[1], print, {}, 5, 'Printed beautifully at A4.'],
    [buyers[2], rug, {}, 5, 'Colours are even richer in person.'],
    [buyers[0], cushion, { Size: '18×18' }, 4, 'Nice fabric.'],
    [buyers[2], radio, {}, 5, 'Works perfectly, great condition.'],
  ];
  for (const [b, l, selections, rating, text] of purchases) {
    db.cart.push({ id: newId('crt'), userId: b.id, listingId: l.id, quantity: 1, selections, personalization: l.personalization.enabled ? b.name.split(' ')[0] : '', savedForLater: false, createdAt: now() });
    const [order] = checkout(b, { address: b.address!, coupons: {}, giftShops: [], giftMessages: {}, notes: {} });
    if (order.status === 'paid') {
      order.status = 'completed';
      order.shippedAt = now();
      order.deliveredAt = now();
      order.tracking = { carrier: 'TCS', number: `TCS${order.receiptNo}PK` };
    }
    db.reviews.push({ id: newId('rev'), orderId: order.id, listingId: l.id, shopId: l.shopId, buyerId: b.id, rating, text, createdAt: now() });
  }

  // One open order for MayaCrafts to fulfil.
  db.cart.push({ id: newId('crt'), userId: buyers[1].id, listingId: ring.id, quantity: 2, selections: { Size: '6' }, personalization: '', savedForLater: false, createdAt: now() });
  checkout(buyers[1], { address: buyers[1].address!, coupons: {}, giftShops: [maya.id], giftMessages: { [maya.id]: 'Happy birthday!' }, notes: {} });

  db.favorites.push(
    { userId: buyer.id, listingId: rug.id, createdAt: now() },
    { userId: buyer.id, listingId: print.id, createdAt: now() },
  );
  db.shopFavorites.push({ userId: buyer.id, shopId: maya.id, createdAt: now() });
  db.collections.push({ id: newId('col'), userId: buyer.id, name: 'Home makeover', isPublic: true, listingIds: [rug.id, cushion.id], createdAt: now() });

  const convo = { id: newId('cnv'), buyerId: buyer.id, sellerId: maya.ownerId, shopId: maya.id, listingId: necklace.id, subject: `About: ${necklace.title}`, createdAt: now(), updatedAt: now() };
  db.conversations.push(convo);
  db.messages.push(
    { id: newId('msg'), conversationId: convo.id, senderId: buyer.id, body: 'Hi! Can you do the name in Urdu script?', readBy: [buyer.id], createdAt: now() },
    { id: newId('msg'), conversationId: convo.id, senderId: maya.ownerId, body: 'Yes, absolutely! Just add it in the personalization box and I will send you a proof before making it.', readBy: [maya.ownerId], createdAt: now() },
  );
}
