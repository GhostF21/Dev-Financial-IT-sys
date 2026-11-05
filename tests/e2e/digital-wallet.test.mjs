// Feature: Digital Wallet - create and manage a wallet balance for a customer.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARDS, api, convert, createCustomer, expectStatus, fundedWallet, getWallet, openAccount, openWallet, randomUUID, topUpByCard,
} from './helpers.mjs';

describe('Digital Wallet', () => {
  describe('create', () => {
    it('DW-01 creates an active wallet with zero balance for a KYC-approved customer', async () => {
      const customer = await createCustomer();
      const res = await api('POST', '/wallets', { customerId: customer.id, currency: 'EUR' });
      assert.equal(res.status, 201);
      assert.equal(res.body.customerId, customer.id);
      assert.equal(res.body.currency, 'EUR');
      assert.equal(res.body.balance, 0);
      assert.equal(res.body.status, 'ACTIVE');
      assert.equal(res.headers.get('location'), `/wallets/${res.body.id}`);
    });

    it('DW-02 rejects a wallet when the customer KYC is not approved', async () => {
      const pending = await createCustomer({ kyc: null });
      const rejected = await createCustomer({ kyc: 'REJECTED' });
      for (const customer of [pending, rejected]) {
        const res = await api('POST', '/wallets', { customerId: customer.id, currency: 'EUR' });
        assert.equal(res.status, 422);
        assert.equal(res.body.code, 'KYC_REQUIRED');
      }
    });

    it('DW-03 allows one wallet per currency per customer', async () => {
      const customer = await createCustomer();
      await openWallet(customer.id, 'EUR');
      const duplicate = await api('POST', '/wallets', { customerId: customer.id, currency: 'EUR' });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.code, 'WALLET_EXISTS');
      await openWallet(customer.id, 'USD'); // another currency is fine
    });

    it('DW-04 rejects unknown customers, invalid IDs and unsupported currencies', async () => {
      assert.equal((await api('POST', '/wallets', { customerId: randomUUID(), currency: 'EUR' })).status, 404);
      assert.equal((await api('POST', '/wallets', { customerId: 'not-a-uuid', currency: 'EUR' })).status, 422);
      const customer = await createCustomer();
      const res = await api('POST', '/wallets', { customerId: customer.id, currency: 'XYZ' });
      assert.equal(res.status, 422);
      assert.equal(res.body.code, 'UNSUPPORTED_CURRENCY');
    });

    it('DW-05 lists all wallets of a customer and returns a single wallet by ID', async () => {
      const customer = await createCustomer();
      const eur = await openWallet(customer.id, 'EUR');
      const huf = await openWallet(customer.id, 'HUF');
      const list = await expectStatus(200, 'GET', `/wallets?customerId=${customer.id}`);
      assert.deepEqual(list.map((w) => w.id).sort(), [eur.id, huf.id].sort());
      assert.equal((await getWallet(huf.id)).currency, 'HUF');
      assert.equal((await api('GET', `/wallets/${randomUUID()}`)).status, 404);
    });
  });

  describe('top-up', () => {
    it('DW-06 adds money with an approved card and records a SUCCEEDED gateway transaction', async () => {
      const { wallet } = await fundedWallet({ balance: 0 });
      const res = await topUpByCard(wallet.id, 120.5);
      assert.equal(res.wallet.balance, 120.5);
      assert.equal(res.gatewayTransaction.status, 'SUCCEEDED');
      assert.equal(res.gatewayTransaction.cardBrand, 'VISA');
      assert.equal(res.gatewayTransaction.cardLast4, '4242');
      assert.equal(res.transaction.type, 'TOP_UP');
    });

    it('DW-07 keeps the balance unchanged when the card is declined', async () => {
      const { wallet } = await fundedWallet({ balance: 50 });
      for (const [card, code] of [[CARDS.declined, 'CARD_DECLINED'], [CARDS.noFunds, 'INSUFFICIENT_FUNDS']]) {
        const res = await api('POST', `/wallets/${wallet.id}/top-up`, { amount: 10, method: 'CARD', card });
        assert.equal(res.status, 402);
        assert.equal(res.body.code, code);
        assert.equal(res.body.gatewayTransaction.status, 'FAILED');
      }
      assert.equal((await getWallet(wallet.id)).balance, 50);
    });

    it('DW-08 validates card data and amounts', async () => {
      const { wallet } = await fundedWallet({ balance: 0 });
      const invalidCard = await api('POST', `/wallets/${wallet.id}/top-up`, { amount: 10, method: 'CARD', card: CARDS.invalid });
      assert.equal(invalidCard.status, 422);
      assert.equal(invalidCard.body.code, 'INVALID_CARD_NUMBER');
      for (const amount of [0, -5, 10.123, 'abc']) {
        const res = await api('POST', `/wallets/${wallet.id}/top-up`, { amount, method: 'CARD', card: CARDS.visa });
        assert.equal(res.status, 422, `amount ${amount}`);
      }
      const overLimit = await api('POST', `/wallets/${wallet.id}/top-up`, { amount: 5000.01, method: 'CARD', card: CARDS.visa });
      assert.equal(overLimit.status, 402);
      assert.equal(overLimit.body.code, 'AMOUNT_LIMIT_EXCEEDED');
      assert.equal((await getWallet(wallet.id)).balance, 0);
    });

    it('DW-09 adds money from the customer\'s own bank account and debits that account', async () => {
      const customer = await createCustomer();
      const account = await openAccount(customer.id, 'EUR', 300);
      const wallet = await openWallet(customer.id, 'EUR');
      const res = await expectStatus(201, 'POST', `/wallets/${wallet.id}/top-up`, { amount: 75, method: 'BANK_ACCOUNT', bankAccountId: account.id });
      assert.equal(res.wallet.balance, 75);
      assert.equal(res.gatewayTransaction.method, 'BANK_ACCOUNT');
      assert.equal((await expectStatus(200, 'GET', `/accounts/${account.id}`)).balance, 225);
    });

    it('DW-10 refuses a top-up from somebody else\'s bank account', async () => {
      const owner = await createCustomer();
      const stranger = await createCustomer();
      const strangersAccount = await openAccount(stranger.id, 'EUR', 300);
      const wallet = await openWallet(owner.id, 'EUR');
      const res = await api('POST', `/wallets/${wallet.id}/top-up`, { amount: 10, method: 'BANK_ACCOUNT', bankAccountId: strangersAccount.id });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'ACCOUNT_NOT_OWNED');
      assert.equal((await expectStatus(200, 'GET', `/accounts/${strangersAccount.id}`)).balance, 300);
    });

    it('DW-11 converts the currency when the bank account and the wallet differ', async () => {
      const customer = await createCustomer();
      const usdAccount = await openAccount(customer.id, 'USD', 500);
      const wallet = await openWallet(customer.id, 'EUR');
      const res = await expectStatus(201, 'POST', `/wallets/${wallet.id}/top-up`, { amount: 50, method: 'BANK_ACCOUNT', bankAccountId: usdAccount.id });
      assert.equal(res.wallet.balance, 50);
      const after = await expectStatus(200, 'GET', `/accounts/${usdAccount.id}`);
      assert.equal(after.balance, 500 - convert(50, 'EUR', 'USD')); // 54 USD debited
    });

    it('DW-12 does not charge twice when a top-up is retried with the same idempotency key', async () => {
      const { wallet } = await fundedWallet({ balance: 0 });
      const body = { amount: 40, method: 'CARD', card: CARDS.visa, idempotencyKey: randomUUID() };
      const first = await expectStatus(201, 'POST', `/wallets/${wallet.id}/top-up`, body);
      const retry = await expectStatus(200, 'POST', `/wallets/${wallet.id}/top-up`, body);
      assert.equal(retry.gatewayTransaction.id, first.gatewayTransaction.id);
      assert.equal((await getWallet(wallet.id)).balance, 40);
    });
  });

  describe('withdraw and freeze', () => {
    it('DW-13 withdraws to the customer\'s bank account', async () => {
      const customer = await createCustomer();
      const account = await openAccount(customer.id, 'EUR', 0);
      const wallet = await openWallet(customer.id, 'EUR');
      await topUpByCard(wallet.id, 100);
      const res = await expectStatus(201, 'POST', `/wallets/${wallet.id}/withdraw`, { amount: 30, bankAccountId: account.id });
      assert.equal(res.wallet.balance, 70);
      assert.equal(res.gatewayTransaction.operation, 'WITHDRAWAL');
      assert.equal(res.gatewayTransaction.status, 'SUCCEEDED');
      assert.equal((await expectStatus(200, 'GET', `/accounts/${account.id}`)).balance, 30);
    });

    it('DW-14 rejects a withdrawal larger than the balance', async () => {
      const customer = await createCustomer();
      const account = await openAccount(customer.id, 'EUR', 0);
      const wallet = await openWallet(customer.id, 'EUR');
      await topUpByCard(wallet.id, 20);
      const res = await api('POST', `/wallets/${wallet.id}/withdraw`, { amount: 20.01, bankAccountId: account.id });
      assert.equal(res.status, 402);
      assert.equal(res.body.code, 'INSUFFICIENT_FUNDS');
      assert.equal((await getWallet(wallet.id)).balance, 20);
      assert.equal((await expectStatus(200, 'GET', `/accounts/${account.id}`)).balance, 0);
    });

    it('DW-15 blocks a frozen wallet and allows it again after unfreezing', async () => {
      const { wallet } = await fundedWallet({ balance: 10 });
      const frozen = await expectStatus(200, 'PATCH', `/wallets/${wallet.id}`, { status: 'FROZEN' });
      assert.equal(frozen.status, 'FROZEN');
      const blocked = await api('POST', `/wallets/${wallet.id}/top-up`, { amount: 5, method: 'CARD', card: CARDS.visa });
      assert.equal(blocked.status, 422);
      assert.equal(blocked.body.code, 'WALLET_INACTIVE');
      await expectStatus(200, 'PATCH', `/wallets/${wallet.id}`, { status: 'ACTIVE' });
      assert.equal((await topUpByCard(wallet.id, 5)).wallet.balance, 15);
      assert.equal((await api('PATCH', `/wallets/${wallet.id}`, { status: 'DELETED' })).status, 422);
    });
  });
});
