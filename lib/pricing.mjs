// Order pricing lives on the server so the receipt, the stored order and the admin revenue figures always agree.
// (public/index.html shows the same numbers for the cart preview; tests/api.test.mjs checks the two stay equal.)
export const DEALS = { 'VB-100': 10, 'VB-104': 20, 'VB-113': 15, 'VB-118': 25 }; // percent off
export const COUPONS = { VOLT10: 10 };                                              // percent off the subtotal
export const ADDONS = { del: ['Home delivery', 99], war: ['Extended warranty (+1 year)', 499], ret: ['30-day return cover', 149], set: ['Installation and setup', 199] };

/** lines: [{id, qty, price}]. Counter sales pass online:false and get no deals, coupon or add-ons. */
export function priceOrder(lines, { coupon = '', addons = [], online = true } = {}) {
  const subtotal = lines.reduce((t, l) => t + l.price * l.qty, 0);
  if (!online) return { subtotal, deals: 0, coupon: '', couponOff: 0, addons: [], addonsTotal: 0, total: subtotal };
  const deals = lines.reduce((t, l) => t + (DEALS[l.id] ? Math.round(l.price * l.qty * DEALS[l.id] / 100) : 0), 0);
  const code = String(coupon || '').toUpperCase(), couponOff = COUPONS[code] ? Math.round(subtotal * COUPONS[code] / 100) : 0;
  const keys = [...new Set(addons)].filter(k => ADDONS[k]);
  const priced = keys.map(k => ({ key: k, name: ADDONS[k][0], price: k === 'del' && subtotal >= 999 ? 0 : ADDONS[k][1] }));
  const addonsTotal = priced.reduce((t, a) => t + a.price, 0);
  return { subtotal, deals, coupon: couponOff ? code : '', couponOff, addons: priced, addonsTotal, total: subtotal - couponOff - deals + addonsTotal };
}
