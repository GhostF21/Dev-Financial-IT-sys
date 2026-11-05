import express from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

const app = express();
app.use(express.json());
const pool = new Pool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER || 'finnova', password: process.env.DB_PASSWORD || 'finnova', database: process.env.DB_NAME || 'finnova' });

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY, recipient_id UUID NOT NULL, channel TEXT NOT NULL,
    type TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}
async function initDbWithRetry() {
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    try { await initDb(); return; } catch (error) {
      if (attempt === 15) throw error;
      console.error(`Database unavailable (attempt ${attempt}/15); retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/readyz', async (_req, res) => { try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); } catch { res.status(503).json({ status: 'not-ready' }); } });
app.post('/internal/notifications', async (req, res) => {
  const { recipientId, type, payload, channel = 'IN_APP' } = req.body || {};
  if (!recipientId || !type || !payload) return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'recipientId, type, and payload are required' });
  const { rows } = await pool.query(
    `INSERT INTO notifications (id, recipient_id, channel, type, payload, status)
     VALUES ($1,$2,$3,$4,$5,'DELIVERED') RETURNING *`,
    [randomUUID(), recipientId, channel, type, payload],
  );
  res.status(201).json(rows[0]);
});
app.get('/internal/notifications/:recipientId', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM notifications WHERE recipient_id = $1 ORDER BY created_at DESC', [req.params.recipientId]);
  res.json(rows);
});

// In-app inbox for one customer (public, routed through the API Gateway).
app.get('/notifications', async (req, res) => {
  const { recipientId } = req.query;
  if (!/^[0-9a-f-]{36}$/i.test(recipientId || '')) return res.status(400).json({ code: 'BAD_REQUEST', message: 'recipientId query parameter is required' });
  const { rows } = await pool.query('SELECT * FROM notifications WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 100', [recipientId]);
  res.json(rows.map((r) => ({
    id: r.id, recipientId: r.recipient_id, channel: r.channel, type: r.type, payload: r.payload, status: r.status, createdAt: r.created_at,
  })));
});

const port = process.env.PORT || 3004;
initDbWithRetry().then(() => app.listen(port, () => console.log(`notification-service listening on ${port}`))).catch((err) => { console.error('DB init failed', err); process.exit(1); });
