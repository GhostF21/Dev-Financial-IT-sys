// Feature: QR Payment - generate and process a payment using a QR code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_URL, api, convert, expectStatus, fundedWallet, getWallet } from './helpers.mjs';

const PREFIX = 'finnova://pay?token=';
const createQr = (walletId, body) => api('POST', `/wallets/${walletId}/qr-payments`, body);
const pay = (token, payerWalletId) => api('POST', `/qr-payments/${encodeURIComponent(token)}/pay`, { payerWalletId });

describe('QR Payment', () => {
  describe('generate', () => {
    it('QR-01 creates a pending QR payment request with a scannable code', async () => {
      const payee = await fundedWallet({ balance: 0 });
      const before = Date.now();
      const res = await createQr(payee.wallet.id, { amount: 12.5, description: 'Coffee', expiresInMinutes: 15 });
      assert.equal(res.status, 201);
      const qr = res.body;
      assert.equal(qr.status, 'PENDING');
      assert.equal(qr.amount, 12.5);
      assert.equal(qr.currency, 'EUR');
      assert.equal(qr.payeeWalletId, payee.wallet.id);
      assert.equal(qr.qrPayload, `${PREFIX}${qr.token}`);
      assert.match(qr.qrCodeDataUrl, /^data:image\/png;base64,/);
      const ttlMinutes = (new Date(qr.expiresAt) - before) / 60000;
      assert.ok(ttlMinutes > 14 && ttlMinutes <= 15.5, `expires in ${ttlMinutes} min`);
    });

    it('QR-02 validates amount, expiry and wallet state', async () => {
      const payee = await fundedWallet({ balance: 0 });
      for (const body of [{ amount: 0 }, { amount: -3 }, { amount: 5, expiresInMinutes: 0 }, { amount: 5, expiresInMinutes: 24 * 60 + 1 }, { amount: 5, expiresInMinutes: 1.5 }]) {
        assert.equal((await createQr(payee.wallet.id, body)).status, 422, JSON.stringify(body));
      }
      await expectStatus(200, 'PATCH', `/wallets/${payee.wallet.id}`, { status: 'FROZEN' });
      const frozen = await createQr(payee.wallet.id, { amount: 5 });
      assert.equal(frozen.status, 422);
      assert.equal(frozen.body.code, 'WALLET_INACTIVE');
    });

    it('QR-03 can be looked up by token or full payload and served as a PNG image', async () => {
      const payee = await fundedWallet({ balance: 0 });
      const qr = (await createQr(payee.wallet.id, { amount: 7 })).body;
      assert.equal((await expectStatus(200, 'GET', `/qr-payments/${qr.token}`)).id, qr.id);
      assert.equal((await expectStatus(200, 'GET', `/qr-payments/${encodeURIComponent(qr.qrPayload)}`)).id, qr.id);
      const png = await fetch(`${BASE_URL}/qr-payments/${qr.token}/image.png`);
      assert.equal(png.status, 200);
      assert.equal(png.headers.get('content-type'), 'image/png');
      const bytes = new Uint8Array(await png.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]); // PNG signature
      assert.equal((await api('GET', '/qr-payments/does-not-exist')).status, 404);
    });

    it('QR-04 lists the payee wallet\'s QR requests, newest first', async () => {
      const payee = await fundedWallet({ balance: 0 });
      const first = (await createQr(payee.wallet.id, { amount: 1 })).body;
      const second = (await createQr(payee.wallet.id, { amount: 2 })).body;
      const list = await expectStatus(200, 'GET', `/wallets/${payee.wallet.id}/qr-payments`);
      assert.deepEqual(list.map((q) => q.id), [second.id, first.id]);
    });
  });

  describe('pay', () => {
    it('QR-05 pays a QR code: payer debited, payee credited, request marked PAID', async () => {
      const payee = await fundedWallet({ balance: 0, firstName: 'Shop' });
      const payer = await fundedWallet({ balance: 50, firstName: 'Customer' });
      const qr = (await createQr(payee.wallet.id, { amount: 12.5, description: 'Coffee' })).body;
      const res = await pay(qr.qrPayload, payer.wallet.id);
      assert.equal(res.status, 201);
      assert.equal(res.body.qrPayment.status, 'PAID');
      assert.equal(res.body.qrPayment.paidByWalletId, payer.wallet.id);
      assert.equal(res.body.transfer.type, 'QR_PAYMENT');
      assert.equal(res.body.transfer.qrPaymentId, qr.id);
      assert.equal(res.body.payerWallet.balance, 37.5);
      assert.equal(res.body.payeeWallet.balance, 12.5);
      assert.equal((await expectStatus(200, 'GET', `/qr-payments/${qr.token}`)).status, 'PAID');
    });

    it('QR-06 can be paid only once', async () => {
      const payee = await fundedWallet({ balance: 0 });
      const payer = await fundedWallet({ balance: 50 });
      const qr = (await createQr(payee.wallet.id, { amount: 10 })).body;
      assert.equal((await pay(qr.token, payer.wallet.id)).status, 201);
      const again = await pay(qr.token, payer.wallet.id);
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'QR_ALREADY_PAID');
      assert.equal((await getWallet(payer.wallet.id)).balance, 40);
    });

    it('QR-07 is paid exactly once even when two payers scan it at the same time', async () => {
      const payee = await fundedWallet({ balance: 0 });
      const payerA = await fundedWallet({ balance: 50 });
      const payerB = await fundedWallet({ balance: 50 });
      const qr = (await createQr(payee.wallet.id, { amount: 20 })).body;
      const results = await Promise.all([pay(qr.token, payerA.wallet.id), pay(qr.token, payerB.wallet.id)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      assert.equal((await getWallet(payee.wallet.id)).balance, 20);
      const total = (await getWallet(payerA.wallet.id)).balance + (await getWallet(payerB.wallet.id)).balance;
      assert.equal(total, 80);
    });

    it('QR-08 keeps the request pending when the payer has insufficient funds', async () => {
      const payee = await fundedWallet({ balance: 0 });
      const payer = await fundedWallet({ balance: 5 });
      const qr = (await createQr(payee.wallet.id, { amount: 10 })).body;
      const res = await pay(qr.token, payer.wallet.id);
      assert.equal(res.status, 402);
      assert.equal(res.body.code, 'INSUFFICIENT_FUNDS');
      assert.equal((await expectStatus(200, 'GET', `/qr-payments/${qr.token}`)).status, 'PENDING');
      assert.equal((await getWallet(payer.wallet.id)).balance, 5);
    });

    it('QR-09 rejects paying your own QR code and unknown codes', async () => {
      const payee = await fundedWallet({ balance: 30 });
      const qr = (await createQr(payee.wallet.id, { amount: 10 })).body;
      const self = await pay(qr.token, payee.wallet.id);
      assert.equal(self.status, 422);
      assert.equal(self.body.code, 'SAME_WALLET');
      assert.equal((await pay('unknown-token', payee.wallet.id)).status, 404);
    });

    it('QR-10 a cancelled request cannot be paid, a paid one cannot be cancelled', async () => {
      const payee = await fundedWallet({ balance: 0 });
      const payer = await fundedWallet({ balance: 50 });
      const toCancel = (await createQr(payee.wallet.id, { amount: 10 })).body;
      assert.equal((await expectStatus(200, 'POST', `/qr-payments/${toCancel.token}/cancel`)).status, 'CANCELLED');
      const payCancelled = await pay(toCancel.token, payer.wallet.id);
      assert.equal(payCancelled.status, 410);
      assert.equal(payCancelled.body.code, 'QR_CANCELLED');

      const paid = (await createQr(payee.wallet.id, { amount: 10 })).body;
      await pay(paid.token, payer.wallet.id);
      const cancelPaid = await api('POST', `/qr-payments/${paid.token}/cancel`);
      assert.equal(cancelPaid.status, 409);
      assert.equal(cancelPaid.body.code, 'QR_NOT_PENDING');
    });

    it('QR-11 a payer in another currency pays the converted amount, the payee gets the exact amount', async () => {
      const payee = await fundedWallet({ currency: 'HUF', balance: 0 });
      const payer = await fundedWallet({ currency: 'EUR', balance: 20 });
      const qr = (await createQr(payee.wallet.id, { amount: 1975 })).body; // 1975 HUF = 5 EUR
      const res = await pay(qr.token, payer.wallet.id);
      assert.equal(res.status, 201);
      assert.equal(res.body.transfer.amount, convert(1975, 'HUF', 'EUR'));
      assert.equal(res.body.transfer.currency, 'EUR');
      assert.equal(res.body.payerWallet.balance, 15);
      assert.equal(res.body.payeeWallet.balance, 1975);
    });
  });
});
