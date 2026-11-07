// Feature: Payment History - display the customer's previous payment transactions.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, api, createCustomer, expectStatus, fundedWallet, openAccount, openWallet, topUpByCard } from './helpers.mjs';

const history = (walletId, query = '') => expectStatus(200, 'GET', `/wallets/${walletId}/transactions${query ? `?${query}` : ''}`);

describe('Payment History', () => {
  // One customer with a known sequence of operations, shared by the read-only cases below:
  //   card top-up 100 -> P2P send 30 to Bob -> QR payment of 10 from Bob -> withdrawal 20
  const ctx = {};
  before(async () => {
    ctx.customer = await createCustomer({ firstName: 'Alice' });
    ctx.account = await openAccount(ctx.customer.id, 'EUR', 0);
    ctx.wallet = await openWallet(ctx.customer.id, 'EUR');
    ctx.bob = await fundedWallet({ balance: 50, firstName: 'Bob' });
    await topUpByCard(ctx.wallet.id, 100);
    ctx.p2p = await expectStatus(201, 'POST', '/wallets/transfers', { fromWalletId: ctx.wallet.id, toWalletId: ctx.bob.wallet.id, amount: 30, description: 'Rent share' });
    const qr = await expectStatus(201, 'POST', `/wallets/${ctx.wallet.id}/qr-payments`, { amount: 10, description: 'Pizza' });
    ctx.qr = await expectStatus(201, 'POST', `/qr-payments/${qr.token}/pay`, { payerWalletId: ctx.bob.wallet.id });
    await expectStatus(201, 'POST', `/wallets/${ctx.wallet.id}/withdraw`, { amount: 20, bankAccountId: ctx.account.id });
  });

  it('PH-01 lists every payment newest first with type, direction and running balance', async () => {
    const res = await history(ctx.wallet.id);
    assert.deepEqual(res.data.map((t) => t.type), ['WITHDRAWAL', 'QR_PAYMENT_RECEIVED', 'P2P_SENT', 'TOP_UP']);
    assert.deepEqual(res.data.map((t) => t.direction), ['DEBIT', 'CREDIT', 'DEBIT', 'CREDIT']);
    assert.deepEqual(res.data.map((t) => t.amount), [20, 10, 30, 100]);
    assert.deepEqual(res.data.map((t) => t.balanceAfter), [60, 80, 70, 100]);
    assert.ok(res.data.every((t) => t.walletId === ctx.wallet.id && t.currency === 'EUR'));
    assert.deepEqual(res.pageInfo, { page: 1, pageSize: 20, totalItems: 4, totalPages: 1 });
  });

  it('PH-02 links transfers to the counterparty wallet and the transfer reference', async () => {
    const res = await history(ctx.wallet.id);
    const sent = res.data.find((t) => t.type === 'P2P_SENT');
    assert.equal(sent.counterpartyWalletId, ctx.bob.wallet.id);
    assert.equal(sent.referenceId, ctx.p2p.id);
    assert.equal(sent.description, 'Rent share');
    const received = res.data.find((t) => t.type === 'QR_PAYMENT_RECEIVED');
    assert.equal(received.counterpartyWalletId, ctx.bob.wallet.id);
    assert.equal(received.referenceId, ctx.qr.transfer.id);
    const topUp = res.data.find((t) => t.type === 'TOP_UP');
    assert.equal(topUp.paymentMethod, 'CARD');
  });

  it('PH-03 shows the same payments on the other side as the mirror entries', async () => {
    const bob = await history(ctx.bob.wallet.id);
    const received = bob.data.find((t) => t.referenceId === ctx.p2p.id);
    assert.equal(received.type, 'P2P_RECEIVED');
    assert.equal(received.direction, 'CREDIT');
    assert.equal(received.amount, 30);
    const paid = bob.data.find((t) => t.referenceId === ctx.qr.transfer.id);
    assert.equal(paid.type, 'QR_PAYMENT_SENT');
    assert.equal(paid.direction, 'DEBIT');
  });

  it('PH-04 filters by transaction type', async () => {
    const res = await history(ctx.wallet.id, 'type=P2P_SENT');
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].type, 'P2P_SENT');
    assert.equal(res.pageInfo.totalItems, 1);
  });

  it('PH-05 paginates the history', async () => {
    const page1 = await history(ctx.wallet.id, 'page=1&pageSize=3');
    const page2 = await history(ctx.wallet.id, 'page=2&pageSize=3');
    assert.equal(page1.data.length, 3);
    assert.equal(page2.data.length, 1);
    assert.deepEqual(page1.pageInfo, { page: 1, pageSize: 3, totalItems: 4, totalPages: 2 });
    assert.equal(page2.data[0].type, 'TOP_UP');
    const ids = new Set([...page1.data, ...page2.data].map((t) => t.id));
    assert.equal(ids.size, 4);
  });

  it('PH-06 filters by date range and validates the dates', async () => {
    const inFuture = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal((await history(ctx.wallet.id, `from=${encodeURIComponent(inFuture)}`)).data.length, 0);
    const lastHour = new Date(Date.now() - 3_600_000).toISOString();
    assert.equal((await history(ctx.wallet.id, `from=${encodeURIComponent(lastHour)}&to=${encodeURIComponent(inFuture)}`)).data.length, 4);
    assert.equal((await api('GET', `/wallets/${ctx.wallet.id}/transactions?from=yesterday`)).status, 422);
  });

  it('PH-07 shows the card and bank processing log including failed attempts', async () => {
    const res = await api('POST', `/wallets/${ctx.wallet.id}/top-up`, { amount: 5, method: 'CARD', card: CARDS.declined });
    assert.equal(res.status, 402);
    const log = await expectStatus(200, 'GET', `/wallets/${ctx.wallet.id}/gateway-transactions`);
    assert.deepEqual(log.map((g) => `${g.operation}:${g.status}`), ['TOP_UP:FAILED', 'WITHDRAWAL:SUCCEEDED', 'TOP_UP:SUCCEEDED']);
    assert.equal(log[0].failureCode, 'CARD_DECLINED');
    // A failed attempt never appears as a wallet transaction.
    assert.equal((await history(ctx.wallet.id)).pageInfo.totalItems, 4);
  });

  it('PH-08 returns an empty history for a new wallet and 404 for an unknown wallet', async () => {
    const fresh = await fundedWallet({ balance: 0 });
    const res = await history(fresh.wallet.id);
    assert.deepEqual(res.data, []);
    assert.equal(res.pageInfo.totalItems, 0);
    assert.equal((await api('GET', '/wallets/00000000-0000-4000-8000-000000000000/transactions')).status, 404);
  });

  it('PH-09 shows wallet withdrawals on the bank account statement', async () => {
    const statement = await expectStatus(200, 'GET', `/transactions?accountId=${ctx.account.id}`);
    assert.equal(statement.data.length, 1);
    assert.equal(statement.data[0].type, 'CREDIT');
    assert.equal(statement.data[0].amount, 20);
    assert.equal(statement.data[0].balanceAfter, 20);
  });
});
