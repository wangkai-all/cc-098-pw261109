import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, now } from './db.js';
import { SyncEngine } from './engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.APP_PORT ? Number(process.env.APP_PORT) : 4000;
const SAMPLE_URL = process.env.SAMPLE_URL || 'http://localhost:4001';
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', '..', 'data', 'sync.db');

const db = openDb(DB_PATH);
const engine = new SyncEngine(db, { sampleUrl: SAMPLE_URL });
engine.start();

const app = express();
app.use(express.json());

// 代理示例服务管理接口，UI 无需跨域
async function proxyToSample(req, res, subPath, { method } = {}) {
  try {
    const init = { method: method || req.method, headers: { 'Content-Type': 'application/json' } };
    if (req.body && (init.method === 'POST' || init.method === 'PATCH' || init.method === 'DELETE')) {
      init.body = JSON.stringify(req.body);
    }
    const r = await fetch(`${SAMPLE_URL}${subPath}`, init);
    const body = await r.json().catch(() => ({}));
    res.status(r.status).json(body);
  } catch (err) {
    res.status(502).json({ error: `无法连接示例服务: ${err.message}` });
  }
}

// ---------- 同步控制 ----------
app.get('/api/state', (_req, res) => {
  const states = db.prepare('SELECT * FROM sync_state ORDER BY collection').all();
  const result = states.map((s) => {
    const active = s.active_round_id ? db.prepare('SELECT * FROM sync_rounds WHERE id = ?').get(s.active_round_id) : null;
    const last = s.last_round_id ? db.prepare('SELECT * FROM sync_rounds WHERE id = ?').get(s.last_round_id) : null;
    const counts = db.prepare(
      `SELECT
         SUM(CASE WHEN status != 'tombstoned' THEN 1 ELSE 0 END) AS live,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'orphan' THEN 1 ELSE 0 END) AS orphan,
         SUM(CASE WHEN status = 'tombstoned' THEN 1 ELSE 0 END) AS tombstoned,
         COUNT(*) AS total
       FROM entities WHERE collection = ?`
    ).get(s.collection);
    const staging = s.active_round_id
      ? db.prepare('SELECT COUNT(*) AS n FROM staging_entities WHERE round_id = ? AND collection = ?')
          .get(s.active_round_id, s.collection).n
      : 0;
    return { ...s, activeRound: active, lastRound: last, counts, stagingRows: staging };
  });
  res.json({ collections: result, serverTime: now() });
});

app.post('/api/collections/:name/enable', (req, res) => {
  engine.setEnabled(req.params.name, req.body?.enabled ?? true);
  res.json({ ok: true });
});

app.post('/api/collections/:name/retry', (req, res) => {
  const r = engine.manualRetry(req.params.name);
  res.status(r.ok ? 200 : 409).json(r);
});

app.post('/api/collections/:name/cancel', (req, res) => {
  const r = engine.requestCancel(req.params.name);
  res.status(r.ok ? 200 : 409).json(r);
});

app.get('/api/rounds', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare(
    `SELECT r.*,
       (SELECT COUNT(*) FROM sync_pages p WHERE p.round_id = r.id) AS page_ledger_rows
     FROM sync_rounds r
     ${req.query.collection ? 'WHERE r.collection = ?' : ''}
     ORDER BY r.id DESC LIMIT ?`
  ).all(...(req.query.collection ? [req.query.collection, limit] : [limit]));
  res.json({ rounds: rows });
});

app.get('/api/rounds/:id', (req, res) => {
  const round = db.prepare('SELECT * FROM sync_rounds WHERE id = ?').get(req.params.id);
  if (!round) return res.status(404).json({ error: 'round not found' });
  const pages = db.prepare('SELECT * FROM sync_pages WHERE round_id = ? ORDER BY id').all(round.id);
  res.json({ round, pages });
});

// ---------- 数据浏览 ----------
app.get('/api/entities/:name', (req, res) => {
  const status = req.query.status;
  const rows = db.prepare(
    `SELECT * FROM entities WHERE collection = ?
     ${status ? 'AND status = ?' : ''} ORDER BY entity_key`
  ).all(...(status ? [req.params.name, status] : [req.params.name]));
  res.json({
    value: rows.map((r) => ({
      key: r.entity_key,
      status: r.status,
      orphanReason: r.orphan_reason,
      sourceSeq: r.source_seq,
      firstRoundId: r.first_round_id,
      lastRoundId: r.last_round_id,
      data: r.data_json ? JSON.parse(r.data_json) : null,
    })),
  });
});

app.get('/api/entities/:name/:key/provenance', (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM entity_provenance WHERE collection = ? AND entity_key = ? ORDER BY id`
  ).all(req.params.name, Number(req.params.key));
  const entity = db.prepare('SELECT * FROM entities WHERE collection = ? AND entity_key = ?')
    .get(req.params.name, Number(req.params.key));
  res.json({
    entity: entity ? {
      key: entity.entity_key,
      status: entity.status,
      orphanReason: entity.orphan_reason,
      data: entity.data_json ? JSON.parse(entity.data_json) : null,
    } : null,
    provenance: rows,
  });
});

// ---------- 示例服务代理 ----------
app.get('/api/sample/snapshot', (req, res) => proxyToSample(req, res, '/admin/snapshot'));
app.post('/api/sample/reset', (req, res) => proxyToSample(req, res, '/admin/reset'));
app.post('/api/sample/fault', (req, res) => proxyToSample(req, res, '/admin/fault'));
app.post('/api/sample/expire', (req, res) => proxyToSample(req, res, '/admin/expire'));
app.post('/api/sample/stale-upsert', (req, res) => proxyToSample(req, res, '/admin/stale-upsert'));
app.post('/api/sample/delete-twice', (req, res) => proxyToSample(req, res, '/admin/delete-twice'));
app.post('/api/sample/clear-faults', (req, res) => proxyToSample(req, res, '/admin/clear-faults'));
app.post('/api/sample/customers', (req, res) => proxyToSample(req, res, '/admin/customers'));
app.patch('/api/sample/customers/:id', (req, res) => proxyToSample(req, res, `/admin/customers/${req.params.id}`));
app.delete('/api/sample/customers/:id', (req, res) => proxyToSample(req, res, `/admin/customers/${req.params.id}`));
app.post('/api/sample/addresses', (req, res) => proxyToSample(req, res, '/admin/addresses'));
app.patch('/api/sample/addresses/:id', (req, res) => proxyToSample(req, res, `/admin/addresses/${req.params.id}`));
app.delete('/api/sample/addresses/:id', (req, res) => proxyToSample(req, res, `/admin/addresses/${req.params.id}`));

app.use(express.static(join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`[sync-app] UI + API on http://localhost:${PORT}（数据源 ${SAMPLE_URL}，库 ${DB_PATH}）`);
});
