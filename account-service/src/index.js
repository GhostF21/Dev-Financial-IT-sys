import express from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { BASE_CURRENCY, RATES, convert, isSupported, rate } from './fx.js';

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
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3004';

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id UUID PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      date_of_birth DATE NOT NULL,
      street TEXT, city TEXT, postal_code TEXT, country TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY,
      customer_id UUID NOT NULL REFERENCES customers(id),
      account_type TEXT NOT NULL,
      currency TEXT NOT NULL,
      balance NUMERIC(18,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      account_number TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_number TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_number_unique ON accounts(account_number);
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

app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/readyz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.status(200).json({ status: 'ready' }); }
  catch { res.status(503).json({ status: 'not-ready' }); }
});

app.post('/accounts', async (req, res) => {
  const { customerId, accountType, currency, initialDeposit } = req.body || {};
  const openingBalance = Number(initialDeposit || 0);
  if (!customerId || !['CHECKING', 'SAVINGS'].includes(accountType) || !/^[A-Z]{3}$/.test(currency || '') || !Number.isFinite(openingBalance) || openingBalance < 0) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'customerId, accountType, currency are required' });
  }
  if (!isSupported(currency)) {
    return res.status(422).json({ code: 'UNSUPPORTED_CURRENCY', message: `currency must be one of ${Object.keys(RATES).join(', ')}` });
  }
  let customer;
  try {
    const response = await fetch(`${CUSTOMER_SERVICE_URL}/customers/${customerId}`);
    if (response.status === 404) return res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Referenced customer not found' });
    if (!response.ok) throw new Error(`Customer service returned ${response.status}`);
    customer = await response.json();
  } catch (err) {
    console.error('customer-service unavailable', err);
    return res.status(503).json({ code: 'CUSTOMER_SERVICE_UNAVAILABLE', message: 'Could not validate customer' });
  }
  if (customer.kycStatus !== 'APPROVED') {
    return res.status(422).json({ code: 'KYC_REQUIRED', message: 'Customer KYC must be approved before opening an account' });
  }
  const id = randomUUID();
  const accountNumber = `FN${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, customer_id, account_type, currency, balance, status, account_number)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6) RETURNING *`,
    [id, customerId, accountType, currency, openingBalance, accountNumber]
  );
  await publishNotification(customerId, 'ACCOUNT_OPENED', { accountId: id, accountNumber, accountType, currency, initialDeposit: openingBalance });
  res.set('Location', `/accounts/${id}`);
  res.status(201).json(toAccountDto(rows[0]));
});

async function publishNotification(recipientId, type, payload) {
  try {
    const response = await fetch(`${NOTIFICATION_SERVICE_URL}/internal/notifications`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientId, type, payload }),
    });
    if (!response.ok) console.error(`Notification request failed with ${response.status}`);
  } catch (err) {
    console.error('notification-service unavailable', err.message);
  }
}

// A customer's accounts, or the account with a given account number (to pay someone).
app.get('/accounts', async (req, res) => {
  const { customerId, accountNumber } = req.query;
  if (accountNumber) {
    const { rows } = await pool.query('SELECT * FROM accounts WHERE account_number = $1', [String(accountNumber)]);
    if (rows.length === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Account not found' });
    return res.json([toAccountDto(rows[0])]);
  }
  if (!/^[0-9a-f-]{36}$/i.test(customerId || '')) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'customerId or accountNumber query parameter is required' });
  }
  const { rows } = await pool.query('SELECT * FROM accounts WHERE customer_id = $1 ORDER BY created_at', [customerId]);
  res.json(rows.map(toAccountDto));
});

app.get('/fx/rates', (_req, res) => res.json({ base: BASE_CURRENCY, rates: RATES }));

app.get('/fx/quote', (req, res) => {
  const { from, to } = req.query;
  const amount = Number(req.query.amount);
  if (!isSupported(from) || !isSupported(to) || !Number.isFinite(amount) || amount <= 0) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: `from and to must be one of ${Object.keys(RATES).join(', ')}, amount must be positive` });
  }
  res.json({ from, to, amount, rate: rate(from, to), convertedAmount: convert(amount, from, to) });
});

app.get('/accounts/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM accounts WHERE id=$1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Account not found' });
  res.json(toAccountDto(rows[0]));
});

// Internal-only endpoint used by the Payment Service to post balance changes.
// Not part of the public OpenAPI contract and not routed through the API Gateway.
app.patch('/internal/accounts/:id/balance', async (req, res) => {
  const { delta } = req.body || {};
  if (typeof delta !== 'number') return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'delta must be a number' });
  const { rows } = await pool.query(
    `UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND status = 'ACTIVE' AND balance + $1 >= 0 RETURNING *`,
    [delta, req.params.id]
  );
  if (rows.length === 0) return res.status(422).json({ code: 'BALANCE_UPDATE_REJECTED', message: 'Account is unavailable or has insufficient funds' });
  res.json(toAccountDto(rows[0]));
});

// Account management owns the balance aggregate. A payment requests this operation
// instead of changing account rows itself, so debit and credit are atomic.
// `amount` / `currency` are in the source account's currency; if the destination account
// uses another currency, it is credited the amount converted at the fixed FX rate.
app.post('/internal/transfers', async (req, res) => {
  const { fromAccountId, toAccountId, amount, currency } = req.body || {};
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId || !Number.isFinite(amount) || amount <= 0 || !currency) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'Different account IDs, positive amount, and currency are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[fromAccountId, toAccountId]],
    );
    if (rows.length !== 2) { await client.query('ROLLBACK'); return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Source or destination account not found' }); }
    const from = rows.find((row) => row.id === fromAccountId);
    const to = rows.find((row) => row.id === toAccountId);
    if (from.status !== 'ACTIVE' || to.status !== 'ACTIVE' || from.currency !== currency) {
      await client.query('ROLLBACK');
      return res.status(422).json({ code: 'TRANSFER_REJECTED', message: 'Accounts must be active and the currency must be the source account currency' });
    }
    if (!isSupported(from.currency) || !isSupported(to.currency)) {
      await client.query('ROLLBACK');
      return res.status(422).json({ code: 'UNSUPPORTED_CURRENCY', message: `Cannot convert between ${from.currency} and ${to.currency}` });
    }
    if (Number(from.balance) < amount) { await client.query('ROLLBACK'); return res.status(402).json({ code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' }); }
    const creditAmount = convert(amount, from.currency, to.currency);
    const debit = await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 RETURNING *', [amount, fromAccountId]);
    const credit = await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING *', [creditAmount, toAccountId]);
    await client.query('COMMIT');
    res.json({
      fromAccount: toAccountDto(debit.rows[0]),
      toAccount: toAccountDto(credit.rows[0]),
      fx: { fromAmount: amount, fromCurrency: from.currency, toAmount: creditAmount, toCurrency: to.currency, rate: rate(from.currency, to.currency) },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Could not complete transfer' });
  } finally { client.release(); }
});

function toAccountDto(r) {
  return {
    id: r.id, customerId: r.customer_id, accountType: r.account_type, currency: r.currency,
    balance: Number(r.balance), accountNumber: r.account_number, status: r.status, createdAt: r.created_at,
  };
}

const port = process.env.PORT || 3000;
initDbWithRetry()
  .then(() => app.listen(port, () => console.log(`account-service listening on ${port}`)))
  .catch((err) => { console.error('DB init failed', err); process.exit(1); });
