import { FEES } from './config.ts';
import type { DiscountType, Listing, Promotion } from './types.ts';

export interface SaleFees {
  transactionFee: number;
  processingFee: number;
  listingRenewalFees: number;
}

/**
 * Fees the marketplace keeps from one order.
 * - transaction fee: rate × (items after discount + shipping)
 * - processing fee: rate × order total + flat
 * - renewal fees: listing fee for every additional unit sold, plus one renewal per
 *   listing that still has stock left and is set to auto-renew.
 */
export function calculateSaleFees(params: {
  itemsAfterDiscount: number;
  shipping: number;
  total: number;
  lines: { quantity: number; remainingStock: number; autoRenew: boolean }[];
}): SaleFees {
  const transactionFee = Math.round((params.itemsAfterDiscount + params.shipping) * FEES.transactionRate);
  const processingFee = params.total > 0 ? Math.round(params.total * FEES.processingRate) + FEES.processingFlat : 0;
  let renewals = 0;
  for (const line of params.lines) {
    renewals += Math.max(0, line.quantity - 1);
    if (line.autoRenew && line.remainingStock > 0) renewals += 1;
  }
  return { transactionFee, processingFee, listingRenewalFees: renewals * FEES.listingFee };
}

export function unitPrice(listing: Pick<Listing, 'price' | 'variations'>, selections: Record<string, string>): number {
  let price = listing.price;
  for (const variation of listing.variations) {
    const chosen = variation.options.find((o) => o.value === selections[variation.name]);
    if (chosen) price += chosen.priceDelta;
  }
  return price;
}

export function shippingFor(lines: { cost: number; additionalItemCost: number; freeShipping: boolean; quantity: number; isDigital: boolean }[]): number {
  // The most expensive "first item" rate applies once; every other unit pays its additional-item rate.
  const physical = lines.filter((l) => !l.isDigital && !l.freeShipping && l.quantity > 0);
  if (physical.length === 0) return 0;
  const primary = physical.reduce((a, b) => (b.cost > a.cost ? b : a));
  let total = primary.cost + primary.additionalItemCost * (primary.quantity - 1);
  for (const line of physical) {
    if (line === primary) continue;
    total += line.additionalItemCost * line.quantity;
  }
  return total;
}

export function applyDiscount(type: DiscountType, value: number, subtotal: number, shipping: number): { discount: number; shipping: number } {
  if (type === 'percent') return { discount: Math.round((subtotal * Math.min(value, 100)) / 100), shipping };
  if (type === 'fixed') return { discount: Math.min(value, subtotal), shipping };
  return { discount: 0, shipping: 0 };
}

export function isPromotionLive(p: Promotion, now = new Date()): boolean {
  if (!p.active) return false;
  if (new Date(p.startsAt) > now) return false;
  if (p.endsAt && new Date(p.endsAt) < now) return false;
  return true;
}

export function describePromotion(p: Pick<Promotion, 'discountType' | 'value'>, format: (c: number) => string): string {
  if (p.discountType === 'percent') return `${p.value}% off`;
  if (p.discountType === 'fixed') return `${format(p.value)} off`;
  return 'Free shipping';
}
