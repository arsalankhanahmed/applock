// Marketplace-wide settings. Change the name/currency here to rebrand the app.
export const APP_NAME = 'Hunar Bazaar';
export const APP_TAGLINE = 'Handmade, vintage & unique goods from independent sellers';
export const CURRENCY = 'USD';
export const LOCALE = 'en-US';

// Etsy-style fee schedule (amounts in cents, rates as fractions).
export const FEES = {
  // Charged when a listing is published, renewed, or auto-renews after a sale.
  listingFee: 20,
  // How long a published listing stays live before it must be renewed.
  listingDurationDays: 120,
  // Percentage of (item price + shipping) taken on every sale.
  transactionRate: 0.065,
  // Payment processing: percentage of order total plus a flat amount.
  processingRate: 0.03,
  processingFlat: 25,
  // Cost charged to the seller every time a buyer clicks a promoted (ad) listing.
  adCostPerClick: 25,
};

// Star Seller thresholds, evaluated over the shop's order history.
export const STAR_SELLER = {
  minOrders: 5,
  minRating: 4.8,
  minOnTimeShippingRate: 0.95,
};

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY }).format(cents / 100);
}
