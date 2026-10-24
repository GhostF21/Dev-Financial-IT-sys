import express from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'finnova',
  password: process.env.DB_PASSWORD || 'finnova',
  database: process.env.DB_NAME || 'finnova',
});

const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://localhost:3000';

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY,
      from_account_id UUID NOT NULL,
      to_account_id UUID NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT NOT NULL,
      description TEXT,
      idempotency_key UUID UNIQUE,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL,
      type TEXT NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT NOT NULL,
      balance_after NUMERIC(18,2) NOT NULL,
      description TEXT,
      related_payment_id UUID,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
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

app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/readyz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.status(200).json({ status: 'ready' }); }
  catch { res.status(503).json({ status: 'not-ready' }); }
});

app.post('/payments', async (req, res) => {
  const { fromAccountId, toAccountId, amount, currency, description, idempotencyKey } = req.body || {};
  if (!fromAccountId || !toAccountId || !amount || amount <= 0 || !currency) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'fromAccountId, toAccountId, amount>0, currency are required' });
  }

  if (idempotencyKey) {
    const existing = await pool.query('SELECT * FROM payments WHERE idempotency_key=$1', [idempotencyKey]);
    if (existing.rowCount > 0) return res.status(201).json(toPaymentDto(existing.rows[0]));
  }

  let fromRes, toRes;
  try {
    [fromRes, toRes] = await Promise.all([
      fetch(`${ACCOUNT_SERVICE_URL}/accounts/${fromAccountId}`),
      fetch(`${ACCOUNT_SERVICE_URL}/accounts/${toAccountId}`),
    ]);
  } catch (err) {
    console.error('account-service unreachable', err);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Could not reach account service' });
  }
  if (fromRes.status === 404 || toRes.status === 404) {
    return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Source or destination account not found' });
  }
  const fromAccount = await fromRes.json();
  if (Number(fromAccount.balance) < Number(amount)) {
    return res.status(402).json({ code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' });
  }

  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO payments (id, from_account_id, to_account_id, amount, currency, description, idempotency_key, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'COMPLETED') RETURNING *`,
    [id, fromAccountId, toAccountId, amount, currency, description, idempotencyKey || null]
  );

  const debitRes = await fetch(`${ACCOUNT_SERVICE_URL}/internal/accounts/${fromAccountId}/balance`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta: -amount }),
  }).then(r => r.json());
  const creditRes = await fetch(`${ACCOUNT_SERVICE_URL}/internal/accounts/${toAccountId}/balance`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta: amount }),
  }).then(r => r.json());

  await pool.query(
    `INSERT INTO transactions (id, account_id, type, amount, currency, balance_after, description, related_payment_id)
     VALUES ($1,$2,'DEBIT',$3,$4,$5,$6,$7)`,
    [randomUUID(), fromAccountId, amount, currency, debitRes.balance, description, id]
  );
  await pool.query(
    `INSERT INTO transactions (id, account_id, type, amount, currency, balance_after, description, related_payment_id)
     VALUES ($1,$2,'CREDIT',$3,$4,$5,$6,$7)`,
    [randomUUID(), toAccountId, amount, currency, creditRes.balance, description, id]
  );

  res.status(201).json(toPaymentDto(rows[0]));
});

app.get('/transactions', async (req, res) => {
  const { accountId, from, to, type, page = 1, pageSize = 20 } = req.query;
  if (!accountId) return res.status(400).json({ code: 'BAD_REQUEST', message: 'accountId is required' });

  const conditions = ['account_id = $1'];
  const params = [accountId];
  if (from) { params.push(from); conditions.push(`timestamp >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`timestamp <= $${params.length}`); }
  if (type) { params.push(type); conditions.push(`type = $${params.length}`); }

  const where = conditions.join(' AND ');
  const countRes = await pool.query(`SELECT COUNT(*) FROM transactions WHERE ${where}`, params);
  const totalItems = Number(countRes.rows[0].count);
  const limit = Math.min(Number(pageSize), 100);
  const offset = (Number(page) - 1) * limit;
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM transactions WHERE ${where} ORDER BY timestamp DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({
    data: rows.map(toTransactionDto),
    pageInfo: { page: Number(page), pageSize: limit, totalItems, totalPages: Math.ceil(totalItems / limit) || 1 },
  });
});

function toPaymentDto(r) {
  return {
    id: r.id, fromAccountId: r.from_account_id, toAccountId: r.to_account_id, amount: Number(r.amount),
    currency: r.currency, description: r.description, idempotencyKey: r.idempotency_key,
    status: r.status, createdAt: r.created_at,
  };
}
function toTransactionDto(r) {
  return {
    id: r.id, accountId: r.account_id, type: r.type, amount: Number(r.amount), currency: r.currency,
    balanceAfter: Number(r.balance_after), description: r.description,
    relatedPaymentId: r.related_payment_id, timestamp: r.timestamp,
  };
}

const port = process.env.PORT || 3001;
initDbWithRetry()
  .then(() => app.listen(port, () => console.log(`payment-service listening on ${port}`)))
  .catch((err) => { console.error('DB init failed', err); process.exit(1); });
