const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COL_LABEL = { customers: '客户 Customers', addresses: '地址 Addresses' };

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---------- tab 切换 ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $(`#panel-${t.dataset.tab}`).classList.add('active');
    if (t.dataset.tab === 'data') loadEntities();
    if (t.dataset.tab === 'sample') loadSnapshot();
  });
});

// ---------- 同步控制 ----------
function roundKindBadge(k) {
  const label = { full: '全量', delta: '增量', rebuild: '隔离重建' }[k] || k;
  return `<span class="badge kind-${k}">${label}</span>`;
}
function statusBadge(s) {
  const label = { running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' }[s] || s;
  return `<span class="badge ${s}${s === 'running' ? ' pulse' : ''}">${label}</span>`;
}

async function loadSync() {
  const state = await api('/api/state');
  $('#server-time').textContent = `服务时间 ${state.serverTime.replace('T', ' ').slice(0, 19)}`;
  $('#collection-cards').innerHTML = state.collections.map(renderCard).join('');

  state.collections.forEach((c) => {
    $(`#btn-enable-${c.collection}`)?.addEventListener('click', () =>
      api(`/api/collections/${c.collection}/enable`, { method: 'POST', body: { enabled: !c.enabled } }).then(loadSync));
    $(`#btn-retry-${c.collection}`)?.addEventListener('click', () =>
      api(`/api/collections/${c.collection}/retry`, { method: 'POST' }).then(loadSync).catch(alertErr));
    $(`#btn-cancel-${c.collection}`)?.addEventListener('click', () =>
      api(`/api/collections/${c.collection}/cancel`, { method: 'POST' }).then(loadSync).catch(alertErr));
  });

  const rounds = await api('/api/rounds?limit=40');
  $('#rounds-tbody').innerHTML = rounds.rounds.map((r) => `
    <tr>
      <td><span class="linklike" onclick="openRound(${r.id})">#${r.id}</span></td>
      <td>${esc(r.collection)}</td>
      <td>${roundKindBadge(r.kind)}</td>
      <td>${statusBadge(r.status)}${r.cancel_requested ? ' <span class="muted small">取消中…</span>' : ''}</td>
      <td>${r.pages_fetched}</td>
      <td>${r.items_added}</td><td>${r.items_updated}</td><td>${r.items_deleted}</td>
      <td>${r.dupe_pages}（项 ${r.dupe_items}）</td>
      <td>${r.stale_events}</td>
      <td class="small">${fmt(r.started_at)}</td>
      <td class="small">${fmt(r.completed_at)}</td>
      <td class="wrap err-text">${esc(r.error || '')}</td>
    </tr>`).join('');
}

function renderCard(c) {
  const ar = c.activeRound;
  const running = ar && ar.status === 'running';
  const pages = ar ? ar.pages_fetched : 0;
  const suppressed = c.auto_suppressed === 1;
  return `
  <div class="card">
    <h3>${COL_LABEL[c.collection]}</h3>
    <div class="kv">
      <dt>采集开关</dt><dd>${c.enabled ? '<span class="badge active">已开启（持续轮询变化）</span>' : '<span class="badge tombstoned">未开启</span>'}${suppressed ? ' <span class="badge cancelled">自动同步已暂停（取消重建后等待手动恢复）</span>' : ''}</dd>
      <dt>deltaLink</dt><dd class="small">${c.delta_link ? esc(c.delta_link) : '<span class="muted">尚无（首轮需全量）</span>'}</dd>
      <dt>当前轮次</dt><dd>${ar ? `#${ar.id} ${roundKindBadge(ar.kind)} ${statusBadge(ar.status)}` : '<span class="muted">空闲</span>'}</dd>
      <dt>隔离区</dt><dd>${c.stagingRows ? `<span class="badge orphan">重建暂存 ${c.stagingRows} 行（未切换）</span>` : '<span class="muted">无</span>'}</dd>
      <dt>最近错误</dt><dd class="err-text">${esc(c.last_error || '—')}</dd>
    </div>
    ${suppressed ? '<div class="muted small" style="margin:8px 0">已取消尚未切换的重建：旧的可查询数据与同步起点保持不变。点击「立即重试」恢复同步。</div>' : ''}
    ${running ? `<div class="progress"><i style="width:${Math.min(95, 12 + pages * 14)}%"></i></div>
       <div class="muted small">已完成 ${pages} 个分页请求…游标已持久化，中断可续</div>` : ''}
    <div class="stat-row">
      <div class="stat"><b>${c.counts.active ?? 0}</b><span>有效</span></div>
      <div class="stat"><b>${c.counts.orphan ?? 0}</b><span>暂存(孤儿)</span></div>
      <div class="stat"><b>${c.counts.tombstoned ?? 0}</b><span>已删除</span></div>
      <div class="stat"><b>${c.counts.total ?? 0}</b><span>总行数</span></div>
    </div>
    <div class="btn-row">
      <button class="btn primary" id="btn-enable-${c.collection}">${c.enabled ? '关闭采集' : '开启采集（首次同步）'}</button>
      <button class="btn" id="btn-retry-${c.collection}" ${running ? 'disabled' : ''}>立即重试 / 拉取一轮</button>
      <button class="btn danger" id="btn-cancel-${c.collection}" ${ar && ar.kind === 'rebuild' && running ? '' : 'disabled'}>
        取消未切换的重建
      </button>
    </div>
  </div>`;
}

window.openRound = async (id) => {
  const { round, pages } = await api(`/api/rounds/${id}`);
  $('#modal-title').textContent = `轮次 #${round.id}（${round.collection} / ${round.kind}）`;
  $('#modal-body').innerHTML = `
    <div class="kv">
      <dt>状态</dt><dd>${statusBadge(round.status)}</dd>
      <dt>游标</dt><dd class="small">${esc(round.cursor)}</dd>
      <dt>最终 deltaLink</dt><dd class="small">${esc(round.final_delta_link || '—')}</dd>
      <dt>统计</dt><dd>请求 ${round.pages_fetched} · 新增 ${round.items_added} · 更新 ${round.items_updated} · 删除 ${round.items_deleted} · 重复页 ${round.dupe_pages} · 过期事件 ${round.stale_events}</dd>
      <dt>错误</dt><dd class="err-text">${esc(round.error || '—')}</dd>
    </div>
    <h4>分页请求台账（重复 pageId 只处理一次）</h4>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>序号</th><th>pageId</th><th>项数</th><th>是否重放</th><th>时间</th></tr></thead>
    <tbody>${pages.map((p) => `<tr><td>${p.page_no}</td><td>${esc(p.page_id)}</td><td>${p.item_count}</td>
      <td>${p.is_replay ? '<span class="badge cancelled">重放·已跳过处理</span>' : '—'}</td>
      <td class="small">${fmt(p.fetched_at)}</td></tr>`).join('')}</tbody></table></div>`;
  showModal();
};

// ---------- 数据浏览 ----------
async function loadEntities() {
  const collection = $('#entity-collection').value;
  const status = $('#entity-status').value;
  const { value } = await api(`/api/entities/${collection}?status=${encodeURIComponent(status)}`);
  $('#entity-count').textContent = `共 ${value.length} 行`;
  const fields = collection === 'customers'
    ? ['Id', 'Name', 'Email', 'Revision']
    : ['Id', 'CustomerId', 'City', 'Street', 'Revision'];
  $('#entity-thead').innerHTML = `<tr>${fields.map((f) => `<th>${f}</th>`).join('')}<th>状态</th><th>说明</th><th>溯源</th></tr>`;
  $('#entity-tbody').innerHTML = value.map((row) => {
    const d = row.data || {};
    return `<tr>
      ${fields.map((f) => `<td>${esc(d[f] ?? (f === 'Id' ? row.key : ''))}</td>`).join('')}
      <td><span class="badge ${row.status}">${row.status}</span></td>
      <td class="wrap small muted">${esc(row.orphanReason || (row.status === 'tombstoned' ? '逻辑删除（保留溯源）' : ''))}</td>
      <td><span class="linklike" onclick="openProvenance('${collection}', ${row.key})">查看新增/更新/删除来源轮次</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="muted">无数据</td></tr>';
}
$('#entity-collection').addEventListener('change', loadEntities);
$('#entity-status').addEventListener('change', loadEntities);

window.openProvenance = async (collection, key) => {
  const data = await api(`/api/entities/${collection}/${key}/provenance`);
  $('#modal-title').textContent = `溯源：${collection} #${key}`;
  const opLabel = {
    created: '新增', updated: '更新', deleted: '删除',
    stale_skipped: '旧事件忽略（不复活/不回退）', delete_repeated: '重复删除（幂等跳过）',
    orphan_staged: '孤儿暂存', orphan_adopted: '暂存恢复',
  };
  $('#modal-body').innerHTML = `
    <div class="kv">
      <dt>当前状态</dt><dd>${data.entity ? `<span class="badge ${data.entity.status}">${data.entity.status}</span> ${esc(data.entity.orphanReason || '')}` : '不存在'}</dd>
      <dt>当前数据</dt><dd class="small">${esc(JSON.stringify(data.entity?.data ?? null))}</dd>
    </div>
    <h4>逐请求来源（每一条来自哪一轮、第几个分页请求）</h4>
    ${data.provenance.map((p) => `
      <div class="prov-item ${p.op}">
        <div><b>${opLabel[p.op] || p.op}</b> · 轮次 <span class="linklike" onclick="openRound(${p.round_id})">#${p.round_id}</span> · 第 ${p.request_no} 个请求${p.source_seq ? ` · seq ${p.source_seq}` : ''}</div>
        <div class="prov-meta">${fmt(p.created_at)} · ${esc(p.detail || '')}</div>
      </div>`).join('') || '<p class="muted">无记录</p>'}`;
  showModal();
};

// ---------- 示例服务故障台 ----------
async function loadSnapshot() {
  try {
    const s = await api('/api/sample/snapshot');
    $('#sample-snapshot').textContent = JSON.stringify(s, null, 2);
  } catch (e) {
    $('#sample-snapshot').textContent = `无法连接示例服务：${e.message}`;
  }
}
$('#btn-refresh-snapshot').addEventListener('click', loadSnapshot);
$('#btn-reset-sample').addEventListener('click', async () => {
  await api('/api/sample/reset', { method: 'POST' });
  loadSnapshot();
});
$('#btn-arm-fault').addEventListener('click', async () => {
  await api('/api/sample/fault', {
    method: 'POST',
    body: {
      collection: $('#fault-collection').value,
      type: $('#fault-type').value,
      page: Number($('#fault-page').value || 2),
    },
  }).catch(alertErr);
  loadSnapshot();
});
$('#btn-expire').addEventListener('click', async () => {
  await api('/api/sample/expire', { method: 'POST' }).catch(alertErr);
  loadSnapshot();
});

$('#btn-c-create').addEventListener('click', () =>
  api('/api/sample/customers', { method: 'POST', body: { Name: $('#c-name').value || `新客户 ${Date.now() % 1000}`, Email: $('#c-email').value } })
    .then(loadSnapshot).catch(alertErr));
$('#btn-c-update').addEventListener('click', () =>
  api(`/api/sample/customers/${$('#c-id').value}`, { method: 'PATCH', body: { Name: `${$('#c-name').value || '改名客户'}-${Date.now() % 1000}` } })
    .then(loadSnapshot).catch(alertErr));
$('#btn-c-delete').addEventListener('click', () =>
  api(`/api/sample/customers/${$('#c-id').value}`, { method: 'DELETE' }).then(loadSnapshot).catch(alertErr));

$('#btn-a-create').addEventListener('click', () =>
  api('/api/sample/addresses', {
    method: 'POST',
    body: { CustomerId: Number($('#a-customer').value || 0), City: $('#a-city').value || '某城市', Street: $('#a-street').value || '某街道' },
  }).then(loadSnapshot).catch(alertErr));
$('#btn-a-update').addEventListener('click', () =>
  api(`/api/sample/addresses/${$('#a-id').value}`, { method: 'PATCH', body: { City: $('#a-city').value || '变更城市' } })
    .then(loadSnapshot).catch(alertErr));
$('#btn-a-delete').addEventListener('click', () =>
  api(`/api/sample/addresses/${$('#a-id').value}`, { method: 'DELETE' }).then(loadSnapshot).catch(alertErr));

// ---------- 通用 ----------
function showModal() { $('#modal-mask').classList.remove('hidden'); }
$('#modal-close').addEventListener('click', () => $('#modal-mask').classList.add('hidden'));
$('#modal-mask').addEventListener('click', (e) => { if (e.target.id === 'modal-mask') $('#modal-mask').classList.add('hidden'); });
function alertErr(e) { alert(e.message); }
function fmt(iso) { return iso ? iso.replace('T', ' ').slice(11, 19) : '—'; }

loadSync();
setInterval(loadSync, 2000);
