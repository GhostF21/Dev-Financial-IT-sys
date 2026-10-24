import express from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

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
      kyc_status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS kyc_verifications (
      id UUID PRIMARY KEY,
      customer_id UUID NOT NULL REFERENCES customers(id),
      document_type TEXT NOT NULL,
      result TEXT NOT NULL,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'PENDING';
  `);
}

async function initDbWithRetry() {
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    try { await initDb(); return; }
    catch (error) {
      if (attempt === 15) throw error;
      console.error(`Database unavailable (attempt ${attempt}/15); retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/readyz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); }
  catch { res.status(503).json({ status: 'not-ready' }); }
});

app.post('/customers', async (req, res) => {
  const { firstName, lastName, email, phone, dateOfBirth, address } = req.body || {};
  if (!firstName || !lastName || !email || !dateOfBirth) {
    return res.status(422).json(error('VALIDATION_ERROR', 'firstName, lastName, email, and dateOfBirth are required'));
  }
  const id = randomUUID();
  try {
    const { rows } = await pool.query(
      `INSERT INTO customers (id, first_name, last_name, email, phone, date_of_birth, street, city, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, firstName, lastName, email, phone, dateOfBirth, address?.street, address?.city, address?.postalCode, address?.country],
    );
    res.location(`/customers/${id}`).status(201).json(toCustomer(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json(error('CUSTOMER_EXISTS', 'Customer with this email already exists'));
    console.error(err);
    res.status(500).json(error('INTERNAL_ERROR', 'Unexpected error'));
  }
});

app.get('/customers/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json(error('NOT_FOUND', 'Customer not found'));
  res.json(toCustomer(rows[0]));
});

app.post('/customers/:id/kyc', async (req, res) => {
  const { documentType, result } = req.body || {};
  if (!documentType || !['APPROVED', 'REJECTED'].includes(result)) {
    return res.status(422).json(error('VALIDATION_ERROR', 'documentType and result (APPROVED or REJECTED) are required'));
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query('UPDATE customers SET kyc_status = $1 WHERE id = $2 RETURNING *', [result, req.params.id]);
    if (!updated.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json(error('NOT_FOUND', 'Customer not found')); }
    await client.query('INSERT INTO kyc_verifications (id, customer_id, document_type, result) VALUES ($1,$2,$3,$4)', [randomUUID(), req.params.id, documentType, result]);
    await client.query('COMMIT');
    res.json(toCustomer(updated.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json(error('INTERNAL_ERROR', 'Unexpected error'));
  } finally { client.release(); }
});

function error(code, message) { return { code, message }; }
function toCustomer(row) {
  return {
    id: row.id, firstName: row.first_name, lastName: row.last_name, email: row.email, phone: row.phone,
    dateOfBirth: row.date_of_birth, kycStatus: row.kyc_status,
    address: { street: row.street, city: row.city, postalCode: row.postal_code, country: row.country },
    createdAt: row.created_at,
  };
}

const port = process.env.PORT || 3002;
initDbWithRetry().then(() => app.listen(port, () => console.log(`customer-service listening on ${port}`))).catch((err) => { console.error('DB init failed', err); process.exit(1); });
