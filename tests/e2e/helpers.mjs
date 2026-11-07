// Shared helpers for the end-to-end tests. They talk only to the API Gateway,
// exactly like the web app does. Base URL: E2E_BASE_URL (default http://localhost:8080).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const BASE_URL = (process.env.E2E_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

// Sandbox card gateway test cards (see wallet-service/src/gateway.js)
export const CARDS = {
  visa: { number: '4242 4242 4242 4242', expiryMonth: 12, expiryYear: 2035, cvc: '123' },
  declined: { number: '4000 0000 0000 0002', expiryMonth: 12, expiryYear: 2035, cvc: '123' },
  noFunds: { number: '4000 0000 0000 9995', expiryMonth: 12, expiryYear: 2035, cvc: '123' },
  invalid: { number: '4242 4242 4242 4241', expiryMonth: 12, expiryYear: 2035, cvc: '123' },
};

// Fixed demo FX rates (units per 1 EUR), see account-service/src/fx.js
export const RATES = { EUR: 1, USD: 1.08, GBP: 0.85, CHF: 0.95, PLN: 4.3, HUF: 395 };
export const convert = (amount, from, to) => Math.round(amount * (RATES[to] / RATES[from]) * 100) / 100;

// Calls the API and returns { status, body }.
export async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

// Calls the API and asserts the status code; returns the body.
export async function expectStatus(expected, method, path, body) {
  const res = await api(method, path, body);
  assert.equal(res.status, expected, `${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

let counter = 0;
const unique = () => `${Date.now()}${process.pid}${counter++}`;

// A customer, optionally KYC-approved, optionally with a bank account and a wallet.
export async function createCustomer({ firstName = 'Test', kyc = 'APPROVED' } = {}) {
  const customer = await expectStatus(201, 'POST', '/customers', {
    firstName, lastName: 'E2E', email: `e2e.${unique()}@example.com`, dateOfBirth: '1990-01-01',
  });
  if (kyc) await expectStatus(200, 'POST', `/customers/${customer.id}/kyc`, { documentType: 'PASSPORT', result: kyc });
  return customer;
}

export async function openAccount(customerId, currency = 'EUR', initialDeposit = 0) {
  return expectStatus(201, 'POST', '/accounts', { customerId, accountType: 'CHECKING', currency, initialDeposit });
}

export async function openWallet(customerId, currency = 'EUR') {
  return expectStatus(201, 'POST', '/wallets', { customerId, currency });
}

export async function topUpByCard(walletId, amount, card = CARDS.visa) {
  return expectStatus(201, 'POST', `/wallets/${walletId}/top-up`, { amount, method: 'CARD', card });
}

export async function getWallet(walletId) {
  return expectStatus(200, 'GET', `/wallets/${walletId}`);
}

// Customer with KYC approved and a funded wallet.
export async function fundedWallet({ currency = 'EUR', balance = 100, firstName } = {}) {
  const customer = await createCustomer({ firstName });
  const wallet = await openWallet(customer.id, currency);
  // The sandbox card gateway allows at most 5000 per charge.
  for (let left = balance; left > 0; left -= 5000) await topUpByCard(wallet.id, Math.min(left, 5000));
  return { customer, wallet: await getWallet(wallet.id) };
}

export { randomUUID };
