import express from 'express';
import { createHash, randomUUID } from 'crypto';
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
const CUSTOMER_SERVICE_URL = process.env.CUSTOMER_SERVICE_URL || 'http://localhost:3002';

const hashPassword = (password) => createHash('sha256').update(password).digest('hex');

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_accounts (
      id UUID PRIMARY KEY,
      customer_id UUID NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS login_sessions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES user_accounts(id),
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
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

app.post('/auth/register', async (req, res) => {
  const { customerId, username, password } = req.body || {};
  if (!customerId || !username || !password || password.length < 8) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'customerId, username, and an 8-character password are required' });
  }
  try {
    const customerResponse = await fetch(`${CUSTOMER_SERVICE_URL}/customers/${customerId}`);
    if (customerResponse.status === 404) return res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Referenced customer not found' });
    if (!customerResponse.ok) throw new Error(`Customer service returned ${customerResponse.status}`);
  } catch (err) {
    console.error('customer-service unavailable', err);
    return res.status(503).json({ code: 'CUSTOMER_SERVICE_UNAVAILABLE', message: 'Could not validate customer' });
  }
  const id = randomUUID();
  try {
    const { rows } = await pool.query(
      'INSERT INTO user_accounts (id, customer_id, username, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, customer_id, username, status, created_at',
      [id, customerId, username, hashPassword(password)],
    );
    res.status(201).json(toUser(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ code: 'USERNAME_EXISTS', message: 'Username already exists' });
    console.error(err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'username and password are required' });
  const { rows } = await pool.query('SELECT * FROM user_accounts WHERE username = $1', [username]);
  const user = rows[0];
  if (!user || user.status !== 'ACTIVE' || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' });
  }
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await pool.query('INSERT INTO login_sessions (id, user_id, expires_at) VALUES ($1,$2,$3)', [sessionId, user.id, expiresAt]);
  res.json({ accessToken: sessionId, tokenType: 'Bearer', expiresAt, user: toUser(user) });
});

async function findSession(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return null;
  const { rows } = await pool.query(
    `SELECT s.id, s.expires_at, u.id AS user_id, u.customer_id, u.username, u.status, u.created_at
     FROM login_sessions s JOIN user_accounts u ON u.id = s.user_id WHERE s.id = $1`,
    [id],
  );
  const session = rows[0];
  if (!session || session.status !== 'ACTIVE' || new Date(session.expires_at) <= new Date()) return null;
  return session;
}

const bearerToken = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

app.get('/internal/sessions/:id', async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) return res.status(401).json({ code: 'INVALID_SESSION', message: 'Session is invalid or expired' });
  res.json({ userId: session.user_id, customerId: session.customer_id, expiresAt: session.expires_at });
});

// The signed-in user (Authorization: Bearer <accessToken from /auth/login>).
app.get('/auth/me', async (req, res) => {
  const session = await findSession(bearerToken(req));
  if (!session) return res.status(401).json({ code: 'INVALID_SESSION', message: 'Session is invalid or expired' });
  res.json({ user: toUser({ ...session, id: session.user_id }), expiresAt: session.expires_at });
});

app.post('/auth/logout', async (req, res) => {
  const token = bearerToken(req);
  if (/^[0-9a-f-]{36}$/i.test(token)) await pool.query('DELETE FROM login_sessions WHERE id = $1', [token]);
  res.status(204).end();
});

// Public lookup by username, used to send money to another user ("@username").
app.get('/auth/users/:username', async (req, res) => {
  const { rows } = await pool.query(`SELECT username, customer_id FROM user_accounts WHERE username = $1 AND status = 'ACTIVE'`, [req.params.username]);
  if (!rows[0]) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'No user with this username' });
  res.json({ username: rows[0].username, customerId: rows[0].customer_id });
});

function toUser(row) { return { id: row.id, customerId: row.customer_id, username: row.username, status: row.status, createdAt: row.created_at }; }

const port = process.env.PORT || 3003;
initDbWithRetry().then(() => app.listen(port, () => console.log(`identity-service listening on ${port}`))).catch((err) => { console.error('DB init failed', err); process.exit(1); });
