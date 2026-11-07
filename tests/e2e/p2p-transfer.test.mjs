// Feature: P2P Transfer - transfer funds between two customer wallets.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, convert, expectStatus, fundedWallet, getWallet, randomUUID } from './helpers.mjs';

const transfer = (fromWalletId, toWalletId, amount, extra = {}) => api('POST', '/wallets/transfers', { fromWalletId, toWalletId, amount, ...extra });

describe('P2P Transfer', () => {
  it('P2P-01 moves money between two wallets of the same currency', async () => {
    const alice = await fundedWallet({ balance: 100, firstName: 'Alice' });
    const bob = await fundedWallet({ balance: 0, firstName: 'Bob' });
    const res = await transfer(alice.wallet.id, bob.wallet.id, 25.5, { description: 'Lunch' });
    assert.equal(res.status, 201);
    assert.equal(res.body.type, 'P2P');
    assert.equal(res.body.status, 'COMPLETED');
    assert.equal(res.body.amount, 25.5);
    assert.equal(res.body.description, 'Lunch');
    assert.equal(res.body.fromWallet.balance, 74.5);
    assert.equal(res.body.toWallet.balance, 25.5);
    assert.equal((await getWallet(alice.wallet.id)).balance, 74.5);
    assert.equal((await getWallet(bob.wallet.id)).balance, 25.5);
  });

  it('P2P-02 rejects a transfer larger than the sender\'s balance and moves nothing', async () => {
    const alice = await fundedWallet({ balance: 10 });
    const bob = await fundedWallet({ balance: 5 });
    const res = await transfer(alice.wallet.id, bob.wallet.id, 10.01);
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'INSUFFICIENT_FUNDS');
    assert.equal((await getWallet(alice.wallet.id)).balance, 10);
    assert.equal((await getWallet(bob.wallet.id)).balance, 5);
  });

  it('P2P-03 rejects invalid requests (same wallet, bad amount, unknown or malformed wallet)', async () => {
    const alice = await fundedWallet({ balance: 50 });
    const bob = await fundedWallet({ balance: 0 });
    const same = await transfer(alice.wallet.id, alice.wallet.id, 5);
    assert.equal(same.status, 422);
    assert.equal(same.body.code, 'SAME_WALLET');
    for (const amount of [0, -1, 1.001]) assert.equal((await transfer(alice.wallet.id, bob.wallet.id, amount)).status, 422, `amount ${amount}`);
    const unknown = await transfer(alice.wallet.id, randomUUID(), 5);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'WALLET_NOT_FOUND');
    assert.equal((await transfer('nope', bob.wallet.id, 5)).status, 422);
    const longNote = await transfer(alice.wallet.id, bob.wallet.id, 5, { description: 'x'.repeat(256) });
    assert.equal(longNote.status, 422);
    assert.equal((await getWallet(alice.wallet.id)).balance, 50);
  });

  it('P2P-04 refuses transfers from or to a frozen wallet', async () => {
    const alice = await fundedWallet({ balance: 50 });
    const bob = await fundedWallet({ balance: 0 });
    await expectStatus(200, 'PATCH', `/wallets/${bob.wallet.id}`, { status: 'FROZEN' });
    const res = await transfer(alice.wallet.id, bob.wallet.id, 5);
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'WALLET_INACTIVE');
    assert.equal((await getWallet(alice.wallet.id)).balance, 50);
  });

  it('P2P-05 moves money only once when a request is retried with the same idempotency key', async () => {
    const alice = await fundedWallet({ balance: 100 });
    const bob = await fundedWallet({ balance: 0 });
    const idempotencyKey = randomUUID();
    const first = await transfer(alice.wallet.id, bob.wallet.id, 30, { idempotencyKey });
    const retry = await transfer(alice.wallet.id, bob.wallet.id, 30, { idempotencyKey });
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, first.body.id);
    assert.equal((await getWallet(alice.wallet.id)).balance, 70);
    const conflict = await transfer(alice.wallet.id, bob.wallet.id, 31, { idempotencyKey });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('P2P-06 never overdraws a wallet under concurrent transfers', async () => {
    const alice = await fundedWallet({ balance: 100 });
    const bob = await fundedWallet({ balance: 0 });
    const results = await Promise.all(Array.from({ length: 5 }, () => transfer(alice.wallet.id, bob.wallet.id, 30)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 201, 201, 402, 402]);
    assert.equal((await getWallet(alice.wallet.id)).balance, 10);
    assert.equal((await getWallet(bob.wallet.id)).balance, 90);
  });

  it('P2P-07 converts automatically between different currencies at the fixed rate', async () => {
    const alice = await fundedWallet({ currency: 'EUR', balance: 100 });
    const bela = await fundedWallet({ currency: 'HUF', balance: 0 });
    const res = await transfer(alice.wallet.id, bela.wallet.id, 20);
    assert.equal(res.status, 201);
    assert.equal(res.body.amount, 20);
    assert.equal(res.body.currency, 'EUR');
    assert.equal(res.body.toAmount, convert(20, 'EUR', 'HUF')); // 7900 HUF
    assert.equal(res.body.toCurrency, 'HUF');
    assert.equal((await getWallet(alice.wallet.id)).balance, 80);
    assert.equal((await getWallet(bela.wallet.id)).balance, 7900);
  });

  it('P2P-08 records a debit and a credit in the ledger and notifies both customers', async () => {
    const alice = await fundedWallet({ balance: 60 });
    const bob = await fundedWallet({ balance: 0 });
    const t = (await transfer(alice.wallet.id, bob.wallet.id, 15)).body;
    const debit = (await expectStatus(200, 'GET', `/ledger-entries?accountId=${alice.wallet.id}`)).find((e) => e.transactionId === t.id);
    const credit = (await expectStatus(200, 'GET', `/ledger-entries?accountId=${bob.wallet.id}`)).find((e) => e.transactionId === t.id);
    assert.equal(debit?.entryType, 'DEBIT');
    assert.equal(credit?.entryType, 'CREDIT');
    assert.equal(debit.amount, 15);
    assert.equal(credit.amount, 15);
    const sent = (await expectStatus(200, 'GET', `/notifications?recipientId=${alice.customer.id}`)).find((n) => n.payload?.transferId === t.id);
    const received = (await expectStatus(200, 'GET', `/notifications?recipientId=${bob.customer.id}`)).find((n) => n.payload?.transferId === t.id);
    assert.equal(sent?.type, 'WALLET_TRANSFER_SENT');
    assert.equal(received?.type, 'WALLET_TRANSFER_RECEIVED');
  });
});
