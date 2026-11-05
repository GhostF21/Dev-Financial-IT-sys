import express from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

const app = express();
app.use(express.json());
const pool = new Pool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER || 'finnova', password: process.env.DB_PASSWORD || 'finnova', database: process.env.DB_NAME || 'finnova' });

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY, transaction_id UUID NOT NULL, account_id UUID NOT NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
    amount NUMERIC(18,2) NOT NULL, currency TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
app.post('/internal/ledger-entries', async (req, res) => {
  const { transactionId, accountId, entryType, amount, currency } = req.body || {};
  if (!transactionId || !accountId || !['DEBIT', 'CREDIT'].includes(entryType) || !Number.isFinite(amount) || amount <= 0 || !currency) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'transactionId, accountId, entryType, positive amount, and currency are required' });
  }
  const { rows } = await pool.query(
    'INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [randomUUID(), transactionId, accountId, entryType, amount, currency],
  );
  res.status(201).json(rows[0]);
});

// Double-entry view for one account or wallet (wallet entries use the wallet ID as accountId).
app.get('/ledger-entries', async (req, res) => {
  const { accountId } = req.query;
  if (!/^[0-9a-f-]{36}$/i.test(accountId || '')) return res.status(400).json({ code: 'BAD_REQUEST', message: 'accountId query parameter is required' });
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const { rows } = await pool.query('SELECT * FROM ledger_entries WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2', [accountId, limit]);
  res.json(rows.map((r) => ({
    id: r.id, transactionId: r.transaction_id, accountId: r.account_id, entryType: r.entry_type,
    amount: Number(r.amount), currency: r.currency, createdAt: r.created_at,
  })));
});

const port = process.env.PORT || 3005;
initDbWithRetry().then(() => app.listen(port, () => console.log(`ledger-service listening on ${port}`))).catch((err) => { console.error('DB init failed', err); process.exit(1); });
