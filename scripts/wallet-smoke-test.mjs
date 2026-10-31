// End-to-end smoke test for the Digital Wallet feature.
// Usage: node scripts/wallet-smoke-test.mjs [gatewayUrl]
// Default gateway URL: http://localhost:8080 (requires Node.js 18 or newer).
import { randomUUID } from 'crypto';

const BASE = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
let failures = 0;

async function call(method, path, body, expected) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  const ok = Array.isArray(expected) ? expected.includes(response.status) : response.status === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${method} ${path} -> ${response.status}${data.code ? ` ${data.code}` : ''}`);
  if (!ok) { failures += 1; console.log('      ', JSON.stringify(data)); }
  return data;
}

function check(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures += 1;
}

async function onboard(firstName, lastName, deposit) {
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${Date.now()}@example.com`;
  const customer = await call('POST', '/customers', { firstName, lastName, email, dateOfBirth: '1992-03-14' }, 201);
  await call('POST', `/customers/${customer.id}/kyc`, { documentType: 'PASSPORT', result: 'APPROVED' }, 200);
  const account = await call('POST', '/accounts', { customerId: customer.id, accountType: 'CHECKING', currency: 'EUR', initialDeposit: deposit }, 201);
  const wallet = await call('POST', '/wallets', { customerId: customer.id, currency: 'EUR' }, 201);
  return { customer, account, wallet };
}

console.log(`Wallet smoke test against ${BASE}\n`);

const alice = await onboard('Alice', 'Kovacs', 1000);
const bob = await onboard('Bob', 'Nagy', 200);
await call('POST', '/wallets', { customerId: alice.customer.id, currency: 'EUR' }, 409);

// Top-up through the payment gateway: bank account and card.
await call('POST', `/wallets/${alice.wallet.id}/top-up`, { method: 'BANK_ACCOUNT', bankAccountId: alice.account.id, amount: 300 }, 201);
await call('POST', `/wallets/${alice.wallet.id}/top-up`, {
  method: 'CARD', amount: 50, card: { number: '4242 4242 4242 4242', expiryMonth: 12, expiryYear: 2030, cvc: '123' },
}, 201);
const declined = await call('POST', `/wallets/${alice.wallet.id}/top-up`, {
  method: 'CARD', amount: 20, card: { number: '4000 0000 0000 0002', expiryMonth: 12, expiryYear: 2030, cvc: '123' },
}, 402);
check('declined card recorded as FAILED gateway transaction', declined.gatewayTransaction?.status === 'FAILED');
await call('POST', `/wallets/${alice.wallet.id}/top-up`, { method: 'BANK_ACCOUNT', bankAccountId: bob.account.id, amount: 10 }, 403);
await call('POST', `/wallets/${bob.wallet.id}/top-up`, { method: 'BANK_ACCOUNT', bankAccountId: bob.account.id, amount: 5000 }, 402);

const bankAccount = await call('GET', `/accounts/${alice.account.id}`, null, 200);
check('bank account debited by bank top-up (1000 - 300 = 700)', bankAccount.balance === 700);

// P2P transfer with idempotency.
const key = randomUUID();
const transfer = { fromWalletId: alice.wallet.id, toWalletId: bob.wallet.id, amount: 75.25, description: 'Dinner split', idempotencyKey: key };
await call('POST', '/wallets/transfers', transfer, 201);
await call('POST', '/wallets/transfers', transfer, 200);
await call('POST', '/wallets/transfers', { ...transfer, amount: 1 }, 409);
await call('POST', '/wallets/transfers', { fromWalletId: bob.wallet.id, toWalletId: alice.wallet.id, amount: 99999 }, 402);

// QR payment: Bob requests, Alice scans and pays.
const qr = await call('POST', `/wallets/${bob.wallet.id}/qr-payments`, { amount: 12.5, description: 'Coffee and croissant' }, 201);
check('QR response includes PNG data URL', qr.qrCodeDataUrl?.startsWith('data:image/png;base64,'));
const preview = await call('GET', `/qr-payments/${encodeURIComponent(qr.qrPayload)}`, null, 200);
check('QR preview is PENDING', preview.status === 'PENDING');
await call('POST', `/qr-payments/${qr.token}/pay`, { payerWalletId: alice.wallet.id }, 201);
await call('POST', `/qr-payments/${qr.token}/pay`, { payerWalletId: alice.wallet.id }, 409);
const own = await call('POST', `/wallets/${bob.wallet.id}/qr-payments`, { amount: 1 }, 201);
await call('POST', `/qr-payments/${own.token}/pay`, { payerWalletId: bob.wallet.id }, 422);

// Withdrawal back to the bank account.
await call('POST', `/wallets/${bob.wallet.id}/withdraw`, { bankAccountId: bob.account.id, amount: 40 }, 201);

// Balances and history.
const aliceWallet = await call('GET', `/wallets/${alice.wallet.id}`, null, 200);
const bobWallet = await call('GET', `/wallets/${bob.wallet.id}`, null, 200);
check(`Alice wallet = 300 + 50 - 75.25 - 12.50 = 262.25 (got ${aliceWallet.balance})`, aliceWallet.balance === 262.25);
check(`Bob wallet = 75.25 + 12.50 - 40 = 47.75 (got ${bobWallet.balance})`, bobWallet.balance === 47.75);
const history = await call('GET', `/wallets/${alice.wallet.id}/transactions`, null, 200);
check(`Alice history has 4 entries (got ${history.pageInfo?.totalItems})`, history.pageInfo?.totalItems === 4);
const gateway = await call('GET', `/wallets/${alice.wallet.id}/gateway-transactions`, null, 200);
check('Alice gateway log has 2 SUCCEEDED and 1 FAILED', gateway.filter((g) => g.status === 'SUCCEEDED').length === 2 && gateway.filter((g) => g.status === 'FAILED').length === 1);
const bankTx = await call('GET', `/transactions?accountId=${alice.account.id}`, null, 200);
check('Payment Service recorded the bank top-up', bankTx.data?.some((t) => t.type === 'DEBIT' && t.amount === 300));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
console.log(`Alice wallet: ${alice.wallet.id}\nBob wallet:   ${bob.wallet.id}`);
process.exit(failures === 0 ? 0 : 1);
