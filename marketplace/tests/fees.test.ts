import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount, calculateSaleFees, shippingFor, unitPrice } from '../shared/fees.ts';

test('transaction, processing and renewal fees follow the fee schedule', () => {
  const fees = calculateSaleFees({
    itemsAfterDiscount: 10_000,
    shipping: 500,
    total: 10_500,
    lines: [
      { quantity: 3, remainingStock: 2, autoRenew: true }, // 2 extra units + 1 renewal
      { quantity: 1, remainingStock: 0, autoRenew: true }, // sold out: nothing
    ],
  });
  assert.equal(fees.transactionFee, 683); // 6.5% of 105.00
  assert.equal(fees.processingFee, 315 + 25); // 3% + 0.25
  assert.equal(fees.listingRenewalFees, 3 * 20);
});

test('variation price deltas are added to the base price', () => {
  const listing = { price: 1000, variations: [{ name: 'Size', options: [{ value: 'S', priceDelta: 0 }, { value: 'L', priceDelta: 250 }] }] };
  assert.equal(unitPrice(listing, { Size: 'L' }), 1250);
  assert.equal(unitPrice(listing, { Size: 'S' }), 1000);
});

test('shipping charges the highest first-item rate once and additional rates after', () => {
  const total = shippingFor([
    { cost: 500, additionalItemCost: 100, freeShipping: false, quantity: 2, isDigital: false },
    { cost: 800, additionalItemCost: 200, freeShipping: false, quantity: 1, isDigital: false },
    { cost: 900, additionalItemCost: 300, freeShipping: true, quantity: 1, isDigital: false },
  ]);
  assert.equal(total, 800 + 2 * 100);
});

test('discounts never exceed the subtotal', () => {
  assert.deepEqual(applyDiscount('fixed', 5000, 3000, 400), { discount: 3000, shipping: 400 });
  assert.deepEqual(applyDiscount('percent', 10, 3000, 400), { discount: 300, shipping: 400 });
  assert.deepEqual(applyDiscount('free_shipping', 0, 3000, 400), { discount: 0, shipping: 0 });
});
