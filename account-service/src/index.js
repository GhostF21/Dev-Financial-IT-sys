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

app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/readyz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.status(200).json({ status: 'ready' }); }
  catch { res.status(503).json({ status: 'not-ready' }); }
});

app.post('/customers', async (req, res) => {
  const { firstName, lastName, email, phone, dateOfBirth, address } = req.body || {};
  if (!firstName || !lastName || !email || !dateOfBirth) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'firstName, lastName, email, dateOfBirth are required' });
  }
  const id = randomUUID();
  try {
    const { rows } = await pool.query(
      `INSERT INTO customers (id, first_name, last_name, email, phone, date_of_birth, street, city, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, firstName, lastName, email, phone, dateOfBirth,
       address?.street, address?.city, address?.postalCode, address?.country]
    );
    res.set('Location', `/customers/${id}`);
    res.status(201).json(toCustomerDto(rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ code: 'CUSTOMER_EXISTS', message: 'Customer with this email already exists' });
    }
    console.error(err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  }
});

app.post('/accounts', async (req, res) => {
  const { customerId, accountType, currency, initialDeposit } = req.body || {};
  if (!customerId || !accountType || !currency) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'customerId, accountType, currency are required' });
  }
  const customer = await pool.query('SELECT id FROM customers WHERE id=$1', [customerId]);
  if (customer.rowCount === 0) {
    return res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Referenced customer not found' });
  }
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, customer_id, account_type, currency, balance, status)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE') RETURNING *`,
    [id, customerId, accountType, currency, initialDeposit || 0]
  );
  res.set('Location', `/accounts/${id}`);
  res.status(201).json(toAccountDto(rows[0]));
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
    `UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING *`,
    [delta, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Account not found' });
  res.json(toAccountDto(rows[0]));
});

function toCustomerDto(r) {
  return {
    id: r.id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone,
    dateOfBirth: r.date_of_birth,
    address: { street: r.street, city: r.city, postalCode: r.postal_code, country: r.country },
    createdAt: r.created_at,
  };
}
function toAccountDto(r) {
  return {
    id: r.id, customerId: r.customer_id, accountType: r.account_type, currency: r.currency,
    balance: Number(r.balance), status: r.status, createdAt: r.created_at,
  };
}

const port = process.env.PORT || 3000;
initDbWithRetry()
  .then(() => app.listen(port, () => console.log(`account-service listening on ${port}`)))
  .catch((err) => { console.error('DB init failed', err); process.exit(1); });
