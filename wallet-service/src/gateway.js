// Payment gateway adapters used to move money into and out of wallets.
//
// BANK_ACCOUNT  -> FinNova Payment Service (POST /payments). The customer's bank
//                  account and the wallet settlement account are both FinNova
//                  accounts, so the existing payment, transaction, ledger, and
//                  notification flow records the movement.
// CARD          -> Sandbox card gateway. It validates the card and returns an
//                  authorization the same way an external acquirer would. Captured
//                  funds are settled into the wallet settlement account.
import { randomBytes } from 'crypto';

const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3001';
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://localhost:3000';

export class GatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// FinNova Payment Service gateway (bank account <-> wallet settlement account)
// ---------------------------------------------------------------------------
export async function bankTransfer({ fromAccountId, toAccountId, amount, currency, description, idempotencyKey }) {
  let response;
  try {
    response = await fetch(`${PAYMENT_SERVICE_URL}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromAccountId, toAccountId, amount, currency, description, idempotencyKey }),
    });
  } catch (err) {
    throw new GatewayError(503, 'PAYMENT_SERVICE_UNAVAILABLE', 'Could not reach payment service');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GatewayError(response.status, body.code || 'PAYMENT_FAILED', body.message || 'Payment was rejected');
  }
  return { reference: body.id, payment: body };
}

// ---------------------------------------------------------------------------
// Sandbox card gateway
// ---------------------------------------------------------------------------
// Test cards (any future expiry, any 3 digit CVC):
//   4242 4242 4242 4242  Visa, approved
//   5555 5555 5555 4444  Mastercard, approved
//   4000 0000 0000 0002  declined (CARD_DECLINED)
//   4000 0000 0000 9995  declined (INSUFFICIENT_FUNDS)
//   4000 0000 0000 0069  declined (EXPIRED_CARD)
const DECLINED_TEST_CARDS = {
  '4000000000000002': ['CARD_DECLINED', 'The card issuer declined the payment'],
  '4000000000009995': ['INSUFFICIENT_FUNDS', 'The card has insufficient funds'],
  '4000000000000069': ['EXPIRED_CARD', 'The card has expired'],
};
const CARD_SINGLE_CHARGE_LIMIT = 5000;

function luhnValid(number) {
  let sum = 0;
  let double = false;
  for (let i = number.length - 1; i >= 0; i -= 1) {
    let digit = Number(number[i]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function cardBrand(number) {
  if (/^4/.test(number)) return 'VISA';
  if (/^(5[1-5]|2[2-7])/.test(number)) return 'MASTERCARD';
  if (/^3[47]/.test(number)) return 'AMEX';
  return 'CARD';
}

// Validates card data. Throws GatewayError(422) for malformed input.
export function inspectCard(card) {
  const number = String(card?.number || '').replace(/[\s-]/g, '');
  const expiryMonth = Number(card?.expiryMonth);
  let expiryYear = Number(card?.expiryYear);
  const cvc = String(card?.cvc || '');
  if (!/^\d{12,19}$/.test(number) || !luhnValid(number)) {
    throw new GatewayError(422, 'INVALID_CARD_NUMBER', 'Card number is not valid');
  }
  if (!Number.isInteger(expiryMonth) || expiryMonth < 1 || expiryMonth > 12 || !Number.isInteger(expiryYear)) {
    throw new GatewayError(422, 'INVALID_EXPIRY', 'Card expiry month and year are required');
  }
  if (expiryYear < 100) expiryYear += 2000;
  if (!/^\d{3,4}$/.test(cvc)) {
    throw new GatewayError(422, 'INVALID_CVC', 'Card CVC is not valid');
  }
  return { number, expiryMonth, expiryYear, brand: cardBrand(number), last4: number.slice(-4) };
}

// Authorizes and captures a card charge. Returns a gateway reference on success.
export async function chargeCard(card, amount) {
  const now = new Date();
  const expiresEnd = new Date(Date.UTC(card.expiryYear, card.expiryMonth, 1));
  if (expiresEnd <= now) throw new GatewayError(402, 'EXPIRED_CARD', 'The card has expired');
  const declined = DECLINED_TEST_CARDS[card.number];
  if (declined) throw new GatewayError(402, declined[0], declined[1]);
  if (amount > CARD_SINGLE_CHARGE_LIMIT) {
    throw new GatewayError(402, 'AMOUNT_LIMIT_EXCEEDED', `Card top-ups are limited to ${CARD_SINGLE_CHARGE_LIMIT} per charge`);
  }
  return { reference: `ch_${randomBytes(12).toString('hex')}`, authorizationCode: randomBytes(3).toString('hex').toUpperCase() };
}

// Settles captured card funds into the wallet settlement account.
export async function settleCardFunds(settlementAccountId, amount) {
  let response;
  try {
    response = await fetch(`${ACCOUNT_SERVICE_URL}/internal/accounts/${settlementAccountId}/balance`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta: amount }),
    });
  } catch {
    throw new GatewayError(503, 'ACCOUNT_SERVICE_UNAVAILABLE', 'Could not settle card funds');
  }
  if (!response.ok) throw new GatewayError(502, 'SETTLEMENT_FAILED', 'Card funds could not be settled');
}
