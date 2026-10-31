import express from 'express';
import { Pool } from 'pg';
import { randomUUID, randomBytes } from 'crypto';
import QRCode from 'qrcode';
import { GatewayError, bankTransfer, inspectCard, chargeCard, settleCardFunds } from './gateway.js';

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'finnova',
  password: process.env.DB_PASSWORD || 'finnova',
  database: process.env.DB_NAME || 'finnova',
});

const CUSTOMER_SERVICE_URL = process.env.CUSTOMER_SERVICE_URL || 'http://localhost:3002';
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://localhost:3000';
const LEDGER_SERVICE_URL = process.env.LEDGER_SERVICE_URL || 'http://localhost:3005';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3004';

const MAX_AMOUNT = 1_000_000;
const QR_DEFAULT_TTL_MINUTES = 15;
const QR_MAX_TTL_MINUTES = 24 * 60;
const QR_PAYLOAD_PREFIX = 'finnova://pay?token=';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id UUID PRIMARY KEY,
      customer_id UUID NOT NULL,
      currency TEXT NOT NULL,
      balance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (customer_id, currency)
    );
    CREATE TABLE IF NOT EXISTS wallet_transfers (
      id UUID PRIMARY KEY,
      from_wallet_id UUID NOT NULL REFERENCES wallets(id),
      to_wallet_id UUID NOT NULL REFERENCES wallets(id),
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT NOT NULL,
      transfer_type TEXT NOT NULL,
      description TEXT,
      qr_payment_id UUID,
      idempotency_key TEXT,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_transfers_idempotency
      ON wallet_transfers(from_wallet_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id UUID PRIMARY KEY,
      wallet_id UUID NOT NULL REFERENCES wallets(id),
      type TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT NOT NULL,
      balance_after NUMERIC(18,2) NOT NULL,
      counterparty_wallet_id UUID,
      reference_id UUID,
      payment_method TEXT,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS wallet_transactions_wallet ON wallet_transactions(wallet_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS qr_payment_requests (
      id UUID PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      payee_wallet_id UUID NOT NULL REFERENCES wallets(id),
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      expires_at TIMESTAMPTZ NOT NULL,
      paid_by_wallet_id UUID REFERENCES wallets(id),
      transfer_id UUID,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS gateway_transactions (
      id UUID PRIMARY KEY,
      wallet_id UUID NOT NULL REFERENCES wallets(id),
      operation TEXT NOT NULL,
      method TEXT NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      bank_account_id UUID,
      card_brand TEXT,
      card_last4 TEXT,
      gateway_reference TEXT,
      failure_code TEXT,
      failure_message TEXT,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS gateway_transactions_idempotency
      ON gateway_transactions(wallet_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS wallet_settlement_accounts (
      currency TEXT PRIMARY KEY,
      customer_id UUID NOT NULL,
      account_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function initDbWithRetry() {
  const maxAttempts = 15;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await initDb();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.error(`Database unavailable (attempt ${attempt}/${maxAttempts}); retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function parseAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return null;
  return Math.round(amount * 100) / 100;
}

function requireUuid(value, name) {
  if (!isUuid(value)) throw new ApiError(422, 'VALIDATION_ERROR', `${name} must be a valid UUID`);
}

function requireAmount(value) {
  const amount = parseAmount(value);
  if (amount === null) {
    throw new ApiError(422, 'VALIDATION_ERROR', `amount must be a positive number with at most 2 decimals and not more than ${MAX_AMOUNT}`);
  }
  return amount;
}

// An idempotency key may only be replayed with the same operation, method, and amount.
function assertSameGatewayRequest(prior, { operation, method, amount }) {
  if (prior.operation !== operation || prior.method !== method || Number(prior.amount) !== amount) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different request');
  }
}

async function getWallet(id, client = pool) {
  if (!isUuid(id)) throw new ApiError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
  const { rows } = await client.query('SELECT * FROM wallets WHERE id = $1', [id]);
  if (!rows[0]) throw new ApiError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
  return rows[0];
}

async function fetchJson(url, options = {}, unavailableCode = 'UPSTREAM_UNAVAILABLE') {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(503, unavailableCode, `Could not reach ${new URL(url).hostname}`);
  }
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, body };
}

async function postInternal(baseUrl, path, body) {
  try {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) console.error(`Internal request to ${path} failed with ${response.status}`);
  } catch (err) {
    console.error(`Internal request to ${path} failed`, err.message);
  }
}

// Ledger and notification calls cross bounded contexts. Like the Payment Service,
// they never roll back a completed wallet operation if the adapter is unavailable.
function publishSideEffects({ ledger = [], notifications = [] }) {
  return Promise.all([
    ...ledger.map((entry) => postInternal(LEDGER_SERVICE_URL, '/internal/ledger-entries', entry)),
    ...notifications.map((n) => postInternal(NOTIFICATION_SERVICE_URL, '/internal/notifications', n)),
  ]);
}

async function insertWalletTransaction(client, tx) {
  const { rows } = await client.query(
    `INSERT INTO wallet_transactions
       (id, wallet_id, type, direction, amount, currency, balance_after, counterparty_wallet_id, reference_id, payment_method, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [randomUUID(), tx.walletId, tx.type, tx.direction, tx.amount, tx.currency, tx.balanceAfter,
      tx.counterpartyWalletId || null, tx.referenceId || null, tx.paymentMethod || null, tx.description || null],
  );
  return rows[0];
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Settlement account: one FinNova bank account per currency that holds the
// money backing all wallet balances. It is created on first use.
// ---------------------------------------------------------------------------
async function ensureSettlementAccount(currency) {
  const existing = await pool.query('SELECT * FROM wallet_settlement_accounts WHERE currency = $1', [currency]);
  if (existing.rows[0]) return existing.rows[0];

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`wallet-settlement-${currency}`]);
    const again = await client.query('SELECT * FROM wallet_settlement_accounts WHERE currency = $1', [currency]);
    if (again.rows[0]) return again.rows[0];

    const suffix = randomBytes(4).toString('hex');
    const customer = await fetchJson(`${CUSTOMER_SERVICE_URL}/customers`, {
      method: 'POST',
      body: {
        firstName: 'FinNova', lastName: `Wallet Settlement ${currency}`,
        email: `wallet-settlement-${currency.toLowerCase()}-${suffix}@finnova.internal`, dateOfBirth: '2000-01-01',
      },
    }, 'CUSTOMER_SERVICE_UNAVAILABLE');
    if (!customer.ok) throw new ApiError(502, 'SETTLEMENT_SETUP_FAILED', 'Could not create settlement customer');

    const kyc = await fetchJson(`${CUSTOMER_SERVICE_URL}/customers/${customer.body.id}/kyc`, {
      method: 'POST', body: { documentType: 'COMPANY_REGISTRATION', result: 'APPROVED' },
    }, 'CUSTOMER_SERVICE_UNAVAILABLE');
    if (!kyc.ok) throw new ApiError(502, 'SETTLEMENT_SETUP_FAILED', 'Could not approve settlement customer');

    const account = await fetchJson(`${ACCOUNT_SERVICE_URL}/accounts`, {
      method: 'POST', body: { customerId: customer.body.id, accountType: 'CHECKING', currency },
    }, 'ACCOUNT_SERVICE_UNAVAILABLE');
    if (!account.ok) throw new ApiError(502, 'SETTLEMENT_SETUP_FAILED', 'Could not open settlement account');

    const { rows } = await client.query(
      'INSERT INTO wallet_settlement_accounts (currency, customer_id, account_id) VALUES ($1,$2,$3) RETURNING *',
      [currency, customer.body.id, account.body.id],
    );
    console.log(`Created ${currency} wallet settlement account ${account.body.id}`);
    return rows[0];
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`wallet-settlement-${currency}`]).catch(() => {});
    client.release();
  }
}

// A bank account used for top-up or withdrawal must belong to the wallet owner.
async function getOwnedBankAccount(accountId, wallet) {
  requireUuid(accountId, 'bankAccountId');
  const result = await fetchJson(`${ACCOUNT_SERVICE_URL}/accounts/${accountId}`, {}, 'ACCOUNT_SERVICE_UNAVAILABLE');
  if (result.status === 404) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Bank account not found');
  if (!result.ok) throw new ApiError(502, 'ACCOUNT_LOOKUP_FAILED', 'Could not load bank account');
  const account = result.body;
  if (account.customerId !== wallet.customer_id) {
    throw new ApiError(403, 'ACCOUNT_NOT_OWNED', 'Bank account does not belong to the wallet owner');
  }
  if (account.currency !== wallet.currency) {
    throw new ApiError(422, 'CURRENCY_MISMATCH', 'Bank account and wallet must use the same currency');
  }
  if (account.status !== 'ACTIVE') throw new ApiError(422, 'ACCOUNT_INACTIVE', 'Bank account is not active');
  return account;
}

// ---------------------------------------------------------------------------
// Core wallet-to-wallet transfer (used by P2P and QR payments).
// Locks both wallets in a stable order so concurrent transfers cannot deadlock.
// ---------------------------------------------------------------------------
async function executeWalletTransfer(client, { fromWalletId, toWalletId, amount, description, transferType, qrPaymentId, idempotencyKey }) {
  if (fromWalletId === toWalletId) throw new ApiError(422, 'SAME_WALLET', 'Source and destination wallets must be different');
  const { rows } = await client.query(
    'SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [[fromWalletId, toWalletId]],
  );
  const from = rows.find((w) => w.id === fromWalletId);
  const to = rows.find((w) => w.id === toWalletId);
  if (!from) throw new ApiError(404, 'WALLET_NOT_FOUND', 'Source wallet not found');
  if (!to) throw new ApiError(404, 'WALLET_NOT_FOUND', 'Destination wallet not found');
  if (from.status !== 'ACTIVE' || to.status !== 'ACTIVE') throw new ApiError(422, 'WALLET_INACTIVE', 'Both wallets must be active');
  if (from.currency !== to.currency) throw new ApiError(422, 'CURRENCY_MISMATCH', 'Wallets must use the same currency');
  if (Number(from.balance) < amount) throw new ApiError(402, 'INSUFFICIENT_FUNDS', 'Insufficient wallet balance');

  const transferId = randomUUID();
  const debit = await client.query('UPDATE wallets SET balance = balance - $1 WHERE id = $2 RETURNING *', [amount, fromWalletId]);
  const credit = await client.query('UPDATE wallets SET balance = balance + $1 WHERE id = $2 RETURNING *', [amount, toWalletId]);
  const transfer = await client.query(
    `INSERT INTO wallet_transfers (id, from_wallet_id, to_wallet_id, amount, currency, transfer_type, description, qr_payment_id, idempotency_key, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'COMPLETED') RETURNING *`,
    [transferId, fromWalletId, toWalletId, amount, from.currency, transferType, description || null, qrPaymentId || null, idempotencyKey || null],
  );
  const sentType = transferType === 'QR_PAYMENT' ? 'QR_PAYMENT_SENT' : 'P2P_SENT';
  const receivedType = transferType === 'QR_PAYMENT' ? 'QR_PAYMENT_RECEIVED' : 'P2P_RECEIVED';
  await insertWalletTransaction(client, {
    walletId: fromWalletId, type: sentType, direction: 'DEBIT', amount, currency: from.currency,
    balanceAfter: debit.rows[0].balance, counterpartyWalletId: toWalletId, referenceId: transferId, description,
  });
  await insertWalletTransaction(client, {
    walletId: toWalletId, type: receivedType, direction: 'CREDIT', amount, currency: from.currency,
    balanceAfter: credit.rows[0].balance, counterpartyWalletId: fromWalletId, referenceId: transferId, description,
  });
  return { transfer: transfer.rows[0], from: debit.rows[0], to: credit.rows[0] };
}

function transferSideEffects({ transfer, from, to }) {
  const amount = Number(transfer.amount);
  const sentType = transfer.transfer_type === 'QR_PAYMENT' ? 'QR_PAYMENT_SENT' : 'WALLET_TRANSFER_SENT';
  const receivedType = transfer.transfer_type === 'QR_PAYMENT' ? 'QR_PAYMENT_RECEIVED' : 'WALLET_TRANSFER_RECEIVED';
  const payload = { transferId: transfer.id, amount, currency: transfer.currency, fromWalletId: from.id, toWalletId: to.id };
  return publishSideEffects({
    ledger: [
      { transactionId: transfer.id, accountId: from.id, entryType: 'DEBIT', amount, currency: transfer.currency },
      { transactionId: transfer.id, accountId: to.id, entryType: 'CREDIT', amount, currency: transfer.currency },
    ],
    notifications: [
      { recipientId: from.customer_id, type: sentType, payload },
      { recipientId: to.customer_id, type: receivedType, payload },
    ],
  });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/readyz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.status(200).json({ status: 'ready' }); }
  catch { res.status(503).json({ status: 'not-ready' }); }
});

// ---------------------------------------------------------------------------
// Digital wallet
// ---------------------------------------------------------------------------
app.post('/wallets', asyncHandler(async (req, res) => {
  const { customerId, currency = 'EUR' } = req.body || {};
  requireUuid(customerId, 'customerId');
  if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(422, 'VALIDATION_ERROR', 'currency must be an ISO 4217 code such as EUR');

  const customer = await fetchJson(`${CUSTOMER_SERVICE_URL}/customers/${customerId}`, {}, 'CUSTOMER_SERVICE_UNAVAILABLE');
  if (customer.status === 404) throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'Referenced customer not found');
  if (!customer.ok) throw new ApiError(502, 'CUSTOMER_LOOKUP_FAILED', 'Could not validate customer');
  if (customer.body.kycStatus !== 'APPROVED') {
    throw new ApiError(422, 'KYC_REQUIRED', 'Customer KYC must be approved before opening a wallet');
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO wallets (id, customer_id, currency) VALUES ($1,$2,$3) RETURNING *`,
      [randomUUID(), customerId, currency],
    );
    await publishSideEffects({ notifications: [{ recipientId: customerId, type: 'WALLET_CREATED', payload: { walletId: rows[0].id, currency } }] });
    res.location(`/wallets/${rows[0].id}`).status(201).json(toWalletDto(rows[0]));
  } catch (err) {
    if (err.code === '23505') throw new ApiError(409, 'WALLET_EXISTS', `Customer already has a ${currency} wallet`);
    throw err;
  }
}));

app.get('/wallets', asyncHandler(async (req, res) => {
  const { customerId } = req.query;
  if (!isUuid(customerId)) throw new ApiError(400, 'BAD_REQUEST', 'customerId query parameter is required');
  const { rows } = await pool.query('SELECT * FROM wallets WHERE customer_id = $1 ORDER BY created_at', [customerId]);
  res.json(rows.map(toWalletDto));
}));

app.get('/wallets/:id', asyncHandler(async (req, res) => {
  res.json(toWalletDto(await getWallet(req.params.id)));
}));

app.patch('/wallets/:id', asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!['ACTIVE', 'FROZEN'].includes(status)) throw new ApiError(422, 'VALIDATION_ERROR', 'status must be ACTIVE or FROZEN');
  await getWallet(req.params.id);
  const { rows } = await pool.query('UPDATE wallets SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]);
  res.json(toWalletDto(rows[0]));
}));

// Top up a wallet through the payment gateway (bank account or card).
app.post('/wallets/:id/top-up', asyncHandler(async (req, res) => {
  const wallet = await getWallet(req.params.id);
  if (wallet.status !== 'ACTIVE') throw new ApiError(422, 'WALLET_INACTIVE', 'Wallet is not active');
  const { method, bankAccountId, card, idempotencyKey, description } = req.body || {};
  const amount = requireAmount(req.body?.amount);
  if (!['BANK_ACCOUNT', 'CARD'].includes(method)) throw new ApiError(422, 'VALIDATION_ERROR', 'method must be BANK_ACCOUNT or CARD');

  if (idempotencyKey) {
    const prior = await pool.query('SELECT * FROM gateway_transactions WHERE wallet_id = $1 AND idempotency_key = $2', [wallet.id, String(idempotencyKey)]);
    if (prior.rows[0]) {
      assertSameGatewayRequest(prior.rows[0], { operation: 'TOP_UP', method, amount });
      return res.status(200).json({ gatewayTransaction: toGatewayDto(prior.rows[0]), wallet: toWalletDto(await getWallet(wallet.id)) });
    }
  }

  let cardInfo = null;
  if (method === 'BANK_ACCOUNT') await getOwnedBankAccount(bankAccountId, wallet);
  else cardInfo = inspectCard(card);

  const settlement = await ensureSettlementAccount(wallet.currency);
  const gatewayId = randomUUID();
  await pool.query(
    `INSERT INTO gateway_transactions (id, wallet_id, operation, method, amount, currency, status, bank_account_id, card_brand, card_last4, idempotency_key)
     VALUES ($1,$2,'TOP_UP',$3,$4,$5,'PROCESSING',$6,$7,$8,$9)`,
    [gatewayId, wallet.id, method, amount, wallet.currency, method === 'BANK_ACCOUNT' ? bankAccountId : null,
      cardInfo?.brand || null, cardInfo?.last4 || null, idempotencyKey ? String(idempotencyKey) : null],
  );

  let reference;
  try {
    if (method === 'BANK_ACCOUNT') {
      ({ reference } = await bankTransfer({
        fromAccountId: bankAccountId, toAccountId: settlement.account_id, amount, currency: wallet.currency,
        description: description || 'Wallet top-up', idempotencyKey: gatewayId,
      }));
    } else {
      ({ reference } = await chargeCard(cardInfo, amount));
      await settleCardFunds(settlement.account_id, amount);
    }
  } catch (err) {
    if (!(err instanceof GatewayError)) throw err;
    const failed = await pool.query(
      `UPDATE gateway_transactions SET status = 'FAILED', failure_code = $2, failure_message = $3, completed_at = now() WHERE id = $1 RETURNING *`,
      [gatewayId, err.code, err.message],
    );
    return res.status(err.status === 503 ? 503 : err.status >= 500 ? 502 : err.status).json({
      code: err.code, message: err.message, gatewayTransaction: toGatewayDto(failed.rows[0]),
    });
  }

  const result = await withTransaction(async (client) => {
    const updated = await client.query('UPDATE wallets SET balance = balance + $1 WHERE id = $2 RETURNING *', [amount, wallet.id]);
    const tx = await insertWalletTransaction(client, {
      walletId: wallet.id, type: 'TOP_UP', direction: 'CREDIT', amount, currency: wallet.currency,
      balanceAfter: updated.rows[0].balance, referenceId: gatewayId, paymentMethod: method,
      description: description || (method === 'CARD' ? `Card top-up ${cardInfo.brand} ****${cardInfo.last4}` : 'Top-up from bank account'),
    });
    const gw = await client.query(
      `UPDATE gateway_transactions SET status = 'SUCCEEDED', gateway_reference = $2, completed_at = now() WHERE id = $1 RETURNING *`,
      [gatewayId, reference],
    );
    return { wallet: updated.rows[0], transaction: tx, gateway: gw.rows[0] };
  });

  await publishSideEffects({
    ledger: [{ transactionId: gatewayId, accountId: wallet.id, entryType: 'CREDIT', amount, currency: wallet.currency }],
    notifications: [{ recipientId: wallet.customer_id, type: 'WALLET_TOPPED_UP', payload: { walletId: wallet.id, amount, currency: wallet.currency, method } }],
  });
  res.status(201).json({
    gatewayTransaction: toGatewayDto(result.gateway), wallet: toWalletDto(result.wallet), transaction: toTransactionDto(result.transaction),
  });
}));

// Withdraw from a wallet back to the owner's bank account through the Payment Service.
app.post('/wallets/:id/withdraw', asyncHandler(async (req, res) => {
  const wallet = await getWallet(req.params.id);
  const { bankAccountId, idempotencyKey } = req.body || {};
  const amount = requireAmount(req.body?.amount);

  if (idempotencyKey) {
    const prior = await pool.query('SELECT * FROM gateway_transactions WHERE wallet_id = $1 AND idempotency_key = $2', [wallet.id, String(idempotencyKey)]);
    if (prior.rows[0]) {
      assertSameGatewayRequest(prior.rows[0], { operation: 'WITHDRAWAL', method: 'BANK_ACCOUNT', amount });
      return res.status(200).json({ gatewayTransaction: toGatewayDto(prior.rows[0]), wallet: toWalletDto(await getWallet(wallet.id)) });
    }
  }
  await getOwnedBankAccount(bankAccountId, wallet);
  const settlement = await ensureSettlementAccount(wallet.currency);
  const gatewayId = randomUUID();

  // Reserve the funds first so the wallet can never be overdrawn.
  await withTransaction(async (client) => {
    const debited = await client.query(
      `UPDATE wallets SET balance = balance - $1 WHERE id = $2 AND status = 'ACTIVE' AND balance >= $1 RETURNING *`,
      [amount, wallet.id],
    );
    if (!debited.rows[0]) throw new ApiError(402, 'INSUFFICIENT_FUNDS', 'Insufficient wallet balance or wallet inactive');
    await client.query(
      `INSERT INTO gateway_transactions (id, wallet_id, operation, method, amount, currency, status, bank_account_id, idempotency_key)
       VALUES ($1,$2,'WITHDRAWAL','BANK_ACCOUNT',$3,$4,'PROCESSING',$5,$6)`,
      [gatewayId, wallet.id, amount, wallet.currency, bankAccountId, idempotencyKey ? String(idempotencyKey) : null],
    );
    await insertWalletTransaction(client, {
      walletId: wallet.id, type: 'WITHDRAWAL', direction: 'DEBIT', amount, currency: wallet.currency,
      balanceAfter: debited.rows[0].balance, referenceId: gatewayId, paymentMethod: 'BANK_ACCOUNT', description: 'Withdrawal to bank account',
    });
  });

  try {
    const { reference } = await bankTransfer({
      fromAccountId: settlement.account_id, toAccountId: bankAccountId, amount, currency: wallet.currency,
      description: 'Wallet withdrawal', idempotencyKey: gatewayId,
    });
    const gw = await pool.query(
      `UPDATE gateway_transactions SET status = 'SUCCEEDED', gateway_reference = $2, completed_at = now() WHERE id = $1 RETURNING *`,
      [gatewayId, reference],
    );
    await publishSideEffects({
      ledger: [{ transactionId: gatewayId, accountId: wallet.id, entryType: 'DEBIT', amount, currency: wallet.currency }],
      notifications: [{ recipientId: wallet.customer_id, type: 'WALLET_WITHDRAWAL', payload: { walletId: wallet.id, amount, currency: wallet.currency } }],
    });
    res.status(201).json({ gatewayTransaction: toGatewayDto(gw.rows[0]), wallet: toWalletDto(await getWallet(wallet.id)) });
  } catch (err) {
    if (!(err instanceof GatewayError)) throw err;
    // Compensate: return the reserved funds to the wallet.
    const failed = await withTransaction(async (client) => {
      const refunded = await client.query('UPDATE wallets SET balance = balance + $1 WHERE id = $2 RETURNING *', [amount, wallet.id]);
      await insertWalletTransaction(client, {
        walletId: wallet.id, type: 'REVERSAL', direction: 'CREDIT', amount, currency: wallet.currency,
        balanceAfter: refunded.rows[0].balance, referenceId: gatewayId, paymentMethod: 'BANK_ACCOUNT', description: 'Withdrawal reversed',
      });
      const gw = await client.query(
        `UPDATE gateway_transactions SET status = 'FAILED', failure_code = $2, failure_message = $3, completed_at = now() WHERE id = $1 RETURNING *`,
        [gatewayId, err.code, err.message],
      );
      return gw.rows[0];
    });
    res.status(err.status >= 500 ? 502 : err.status).json({ code: err.code, message: err.message, gatewayTransaction: toGatewayDto(failed) });
  }
}));

// ---------------------------------------------------------------------------
// P2P transfer
// ---------------------------------------------------------------------------
app.post('/wallets/transfers', asyncHandler(async (req, res) => {
  const { fromWalletId, toWalletId, description, idempotencyKey } = req.body || {};
  requireUuid(fromWalletId, 'fromWalletId');
  requireUuid(toWalletId, 'toWalletId');
  const amount = requireAmount(req.body?.amount);
  if (description && String(description).length > 255) throw new ApiError(422, 'VALIDATION_ERROR', 'description must be at most 255 characters');

  if (idempotencyKey) {
    const prior = await pool.query('SELECT * FROM wallet_transfers WHERE from_wallet_id = $1 AND idempotency_key = $2', [fromWalletId, String(idempotencyKey)]);
    if (prior.rows[0]) {
      const p = prior.rows[0];
      if (p.to_wallet_id !== toWalletId || Number(p.amount) !== amount) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different transfer');
      }
      return res.status(200).json(toTransferDto(p));
    }
  }

  const result = await withTransaction((client) => executeWalletTransfer(client, {
    fromWalletId, toWalletId, amount, description, transferType: 'P2P', idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
  }));
  await transferSideEffects(result);
  res.status(201).json({ ...toTransferDto(result.transfer), fromWallet: toWalletDto(result.from), toWallet: toWalletDto(result.to) });
}));

// ---------------------------------------------------------------------------
// QR payments
// ---------------------------------------------------------------------------
async function qrResponse(row) {
  const payload = `${QR_PAYLOAD_PREFIX}${row.token}`;
  const qrCodeDataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  return { ...toQrDto(row), qrPayload: payload, qrCodeDataUrl };
}

function extractToken(value) {
  const raw = String(value || '');
  return raw.startsWith(QR_PAYLOAD_PREFIX) ? raw.slice(QR_PAYLOAD_PREFIX.length) : raw;
}

async function expireStaleQr(token) {
  await pool.query(`UPDATE qr_payment_requests SET status = 'EXPIRED' WHERE token = $1 AND status = 'PENDING' AND expires_at <= now()`, [token]);
}

// Payee (merchant or customer) generates a QR code for an amount.
app.post('/wallets/:id/qr-payments', asyncHandler(async (req, res) => {
  const wallet = await getWallet(req.params.id);
  if (wallet.status !== 'ACTIVE') throw new ApiError(422, 'WALLET_INACTIVE', 'Wallet is not active');
  const amount = requireAmount(req.body?.amount);
  const description = req.body?.description ? String(req.body.description).slice(0, 255) : null;
  const ttl = Number(req.body?.expiresInMinutes ?? QR_DEFAULT_TTL_MINUTES);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > QR_MAX_TTL_MINUTES) {
    throw new ApiError(422, 'VALIDATION_ERROR', `expiresInMinutes must be an integer between 1 and ${QR_MAX_TTL_MINUTES}`);
  }
  const token = randomBytes(18).toString('base64url');
  const { rows } = await pool.query(
    `INSERT INTO qr_payment_requests (id, token, payee_wallet_id, amount, currency, description, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7)) RETURNING *`,
    [randomUUID(), token, wallet.id, amount, wallet.currency, description, ttl],
  );
  res.location(`/qr-payments/${token}`).status(201).json(await qrResponse(rows[0]));
}));

app.get('/wallets/:id/qr-payments', asyncHandler(async (req, res) => {
  const wallet = await getWallet(req.params.id);
  await pool.query(`UPDATE qr_payment_requests SET status = 'EXPIRED' WHERE payee_wallet_id = $1 AND status = 'PENDING' AND expires_at <= now()`, [wallet.id]);
  const { rows } = await pool.query('SELECT * FROM qr_payment_requests WHERE payee_wallet_id = $1 ORDER BY created_at DESC LIMIT 50', [wallet.id]);
  res.json(rows.map(toQrDto));
}));

// Payer scans the QR code and previews the payment before confirming.
app.get('/qr-payments/:token', asyncHandler(async (req, res) => {
  const token = extractToken(req.params.token);
  await expireStaleQr(token);
  const { rows } = await pool.query('SELECT * FROM qr_payment_requests WHERE token = $1', [token]);
  if (!rows[0]) throw new ApiError(404, 'QR_PAYMENT_NOT_FOUND', 'QR payment request not found');
  res.json(await qrResponse(rows[0]));
}));

app.get('/qr-payments/:token/image.png', asyncHandler(async (req, res) => {
  const token = extractToken(req.params.token);
  const { rows } = await pool.query('SELECT token FROM qr_payment_requests WHERE token = $1', [token]);
  if (!rows[0]) throw new ApiError(404, 'QR_PAYMENT_NOT_FOUND', 'QR payment request not found');
  res.type('png').send(await QRCode.toBuffer(`${QR_PAYLOAD_PREFIX}${token}`, { errorCorrectionLevel: 'M', margin: 2, width: 320 }));
}));

// Payer confirms. The QR request is locked so it can be paid only once.
app.post('/qr-payments/:token/pay', asyncHandler(async (req, res) => {
  const token = extractToken(req.params.token);
  const { payerWalletId } = req.body || {};
  requireUuid(payerWalletId, 'payerWalletId');

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM qr_payment_requests WHERE token = $1 FOR UPDATE', [token]);
    const qr = rows[0];
    if (!qr) throw new ApiError(404, 'QR_PAYMENT_NOT_FOUND', 'QR payment request not found');
    if (qr.status === 'PAID') throw new ApiError(409, 'QR_ALREADY_PAID', 'This QR code has already been paid');
    if (qr.status === 'CANCELLED') throw new ApiError(410, 'QR_CANCELLED', 'This QR code was cancelled');
    if (qr.status === 'EXPIRED' || new Date(qr.expires_at) <= new Date()) {
      await client.query(`UPDATE qr_payment_requests SET status = 'EXPIRED' WHERE id = $1`, [qr.id]);
      return { expired: true };
    }
    const transferResult = await executeWalletTransfer(client, {
      fromWalletId: payerWalletId, toWalletId: qr.payee_wallet_id, amount: Number(qr.amount),
      description: qr.description || 'QR payment', transferType: 'QR_PAYMENT', qrPaymentId: qr.id,
    });
    const updated = await client.query(
      `UPDATE qr_payment_requests SET status = 'PAID', paid_by_wallet_id = $2, transfer_id = $3, paid_at = now() WHERE id = $1 RETURNING *`,
      [qr.id, payerWalletId, transferResult.transfer.id],
    );
    return { ...transferResult, qr: updated.rows[0] };
  });
  if (result.expired) throw new ApiError(410, 'QR_EXPIRED', 'This QR code has expired');

  await transferSideEffects(result);
  res.status(201).json({
    qrPayment: toQrDto(result.qr), transfer: toTransferDto(result.transfer),
    payerWallet: toWalletDto(result.from), payeeWallet: toWalletDto(result.to),
  });
}));

app.post('/qr-payments/:token/cancel', asyncHandler(async (req, res) => {
  const token = extractToken(req.params.token);
  const { rows } = await pool.query(
    `UPDATE qr_payment_requests SET status = 'CANCELLED' WHERE token = $1 AND status = 'PENDING' RETURNING *`, [token],
  );
  if (!rows[0]) throw new ApiError(409, 'QR_NOT_PENDING', 'Only a pending QR payment can be cancelled');
  res.json(toQrDto(rows[0]));
}));

// ---------------------------------------------------------------------------
// Payment history
// ---------------------------------------------------------------------------
app.get('/wallets/:id/transactions', asyncHandler(async (req, res) => {
  const wallet = await getWallet(req.params.id);
  const { type, from, to } = req.query;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const conditions = ['wallet_id = $1'];
  const params = [wallet.id];
  if (type) { params.push(String(type)); conditions.push(`type = $${params.length}`); }
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value && Number.isNaN(Date.parse(String(value)))) throw new ApiError(422, 'VALIDATION_ERROR', `${name} must be an ISO 8601 date-time`);
  }
  if (from) { params.push(String(from)); conditions.push(`created_at >= $${params.length}`); }
  if (to) { params.push(String(to)); conditions.push(`created_at <= $${params.length}`); }
  const where = conditions.join(' AND ');
  const count = await pool.query(`SELECT COUNT(*) FROM wallet_transactions WHERE ${where}`, params);
  const totalItems = Number(count.rows[0].count);
  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `SELECT * FROM wallet_transactions WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({
    data: rows.map(toTransactionDto),
    pageInfo: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) || 1 },
  });
}));

app.get('/wallets/:id/gateway-transactions', asyncHandler(async (req, res) => {
  const wallet = await getWallet(req.params.id);
  const { rows } = await pool.query('SELECT * FROM gateway_transactions WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 50', [wallet.id]);
  res.json(rows.map(toGatewayDto));
}));

// ---------------------------------------------------------------------------
// DTOs and errors
// ---------------------------------------------------------------------------
function toWalletDto(r) {
  return { id: r.id, customerId: r.customer_id, currency: r.currency, balance: Number(r.balance), status: r.status, createdAt: r.created_at };
}
function toTransactionDto(r) {
  return {
    id: r.id, walletId: r.wallet_id, type: r.type, direction: r.direction, amount: Number(r.amount), currency: r.currency,
    balanceAfter: Number(r.balance_after), counterpartyWalletId: r.counterparty_wallet_id, referenceId: r.reference_id,
    paymentMethod: r.payment_method, description: r.description, timestamp: r.created_at,
  };
}
function toTransferDto(r) {
  return {
    id: r.id, fromWalletId: r.from_wallet_id, toWalletId: r.to_wallet_id, amount: Number(r.amount), currency: r.currency,
    type: r.transfer_type, description: r.description, qrPaymentId: r.qr_payment_id, idempotencyKey: r.idempotency_key,
    status: r.status, createdAt: r.created_at,
  };
}
function toQrDto(r) {
  return {
    id: r.id, token: r.token, payeeWalletId: r.payee_wallet_id, amount: Number(r.amount), currency: r.currency,
    description: r.description, status: r.status, expiresAt: r.expires_at, paidByWalletId: r.paid_by_wallet_id,
    transferId: r.transfer_id, paidAt: r.paid_at, createdAt: r.created_at,
  };
}
function toGatewayDto(r) {
  return {
    id: r.id, walletId: r.wallet_id, operation: r.operation, method: r.method, amount: Number(r.amount), currency: r.currency,
    status: r.status, bankAccountId: r.bank_account_id, cardBrand: r.card_brand, cardLast4: r.card_last4,
    gatewayReference: r.gateway_reference, failureCode: r.failure_code, failureMessage: r.failure_message,
    createdAt: r.created_at, completedAt: r.completed_at,
  };
}

app.use((err, _req, res, _next) => {
  if (err instanceof ApiError || err instanceof GatewayError) return res.status(err.status).json({ code: err.code, message: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ code: 'BAD_REQUEST', message: 'Malformed JSON body' });
  // Two requests with the same idempotency key raced past the replay check; the unique index rejected the second one.
  if (err.code === '23505') return res.status(409).json({ code: 'DUPLICATE_REQUEST', message: 'A request with this idempotency key is already being processed' });
  console.error(err);
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
});

const port = process.env.PORT || 3006;
initDbWithRetry()
  .then(() => app.listen(port, () => console.log(`wallet-service listening on ${port}`)))
  .catch((err) => { console.error('DB init failed', err); process.exit(1); });
