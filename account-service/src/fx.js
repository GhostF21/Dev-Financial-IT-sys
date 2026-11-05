// Foreign exchange. Fixed demo rates (units of each currency per 1 EUR) - not market data.
// The Account Service owns them; the Payment and Wallet services read them via GET /fx/rates.
export const BASE_CURRENCY = 'EUR';
export const RATES = Object.freeze({
  EUR: 1,
  USD: 1.08,
  GBP: 0.85,
  CHF: 0.95,
  PLN: 4.3,
  HUF: 395,
});

export const isSupported = (currency) => Object.hasOwn(RATES, currency);

export function rate(from, to) {
  return RATES[to] / RATES[from];
}

// Amount in `from` converted to `to`, rounded to cents.
export function convert(amount, from, to) {
  if (from === to) return Math.round(amount * 100) / 100;
  return Math.round(amount * rate(from, to) * 100) / 100;
}
