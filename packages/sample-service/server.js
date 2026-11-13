import express from 'express';
import { store, COLLECTIONS } from './store.js';

const app = express();
app.use(express.json());

const PORT = process.env.SAMPLE_PORT ? Number(process.env.SAMPLE_PORT) : 4001;
const RESPONSE_DELAY_MS = Number(process.env.RESPONSE_DELAY_MS || 0);

// 可选的响应延迟，方便在同步过程中杀掉进程以验证“中途断开可继续”
if (RESPONSE_DELAY_MS > 0) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/odata/')) setTimeout(next, RESPONSE_DELAY_MS);
    else next();
  });
}

function collectionFromPath(path) {
  const p = path.toLowerCase();
  if (p === 'customers') return 'customers';
  if (p === 'addresses') return 'addresses';
  return null;
}

// ---------- OData 入口 ----------
// /odata/Customers?$skiptoken=...      分页（全量轮次）
// /odata/Customers?$deltatoken=...     增量轮次
app.get('/odata/:name', (req, res) => {
  const collection = collectionFromPath(req.params.name);
  if (!collection) {
    return res.status(404).json({ error: { code: 'NotFound', message: 'unknown collection' } });
  }
  const q = req.query;
  // Express 5 保留 OData 参数名中的 '$' 前缀，两种写法都兼容
  const skiptoken = typeof q.$skiptoken === 'string' ? q.$skiptoken
    : typeof q.skiptoken === 'string' ? q.skiptoken : null;
  const deltatoken = typeof q.$deltatoken === 'string' ? q.$deltatoken
    : typeof q.deltatoken === 'string' ? q.deltatoken : null;
  const result = store.serve(collection, { skiptoken, deltatoken });
  res.status(result.status).json(result.body);
});

app.get('/odata', (_req, res) => {
  res.json({
    '@odata.context': '$metadata',
    value: COLLECTIONS.map((c) => ({
      name: c === 'customers' ? 'Customers' : 'Addresses',
      url: `/odata/${c === 'customers' ? 'Customers' : 'Addresses'}`,
    })),
  });
});

// ---------- 数据管理（演示用 CRUD，会写入变更日志） ----------
app.post('/admin/reset', (_req, res) => {
  store.reset();
  res.json({ ok: true, snapshot: store.snapshot() });
});

app.get('/admin/snapshot', (_req, res) => {
  res.json(store.snapshot());
});

app.get('/admin/data/:name', (req, res) => {
  const collection = collectionFromPath(req.params.name);
  if (!collection) return res.status(404).json({ error: 'unknown collection' });
  res.json({
    value: [...store.data[collection].values()],
    log: store.logs[collection],
  });
});

// ---------- 故障注入 ----------
// body: { collection, type: 'failPage'|'dupPage', page }
app.post('/admin/fault', (req, res) => {
  try {
    store.setFault(req.body.collection, req.body.type, Number(req.body.page));
    res.json({ ok: true, faults: store.snapshot().faults });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 使所有游标过期：下一次 deltaLink/skiptoken 请求返回 410
app.post('/admin/expire', (_req, res) => {
  store.expireTokens();
  res.json({ ok: true, epoch: store.epoch });
});

// 注入乱序旧 upsert（验证“删除后的旧更新不能复活记录”）
app.post('/admin/stale-upsert', (req, res) => {
  try {
    const { collection, entity } = req.body ?? {};
    if (!COLLECTIONS.includes(collection)) return res.status(400).json({ error: 'unknown collection' });
    res.json(store.injectStaleUpsert(collection, entity));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 注入一次重复删除（验证删除幂等）
app.post('/admin/delete-twice', (req, res) => {
  try {
    const { collection, key } = req.body ?? {};
    if (!COLLECTIONS.includes(collection)) return res.status(400).json({ error: 'unknown collection' });
    res.json(store.injectDelete(collection, Number(key)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 清除全部已布置故障
app.post('/admin/clear-faults', (_req, res) => {
  store.clearFaults();
  res.json({ ok: true, faults: store.snapshot().faults });
});

// ---------- 演示数据变更 ----------
app.post('/admin/customers', (req, res) => {
  try {
    res.status(201).json(store.createCustomer(req.body ?? {}));
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});
app.patch('/admin/customers/:id', (req, res) => {
  try {
    res.json(store.updateCustomer(Number(req.params.id), req.body ?? {}));
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});
app.delete('/admin/customers/:id', (req, res) => {
  try {
    res.json(store.deleteCustomer(Number(req.params.id)));
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

app.post('/admin/addresses', (req, res) => {
  try {
    res.status(201).json(store.createAddress(req.body ?? {}));
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});
app.patch('/admin/addresses/:id', (req, res) => {
  try {
    res.json(store.updateAddress(Number(req.params.id), req.body ?? {}));
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});
app.delete('/admin/addresses/:id', (req, res) => {
  try {
    res.json(store.deleteAddress(Number(req.params.id)));
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[sample-service] OData demo service on http://localhost:${PORT}`);
});
