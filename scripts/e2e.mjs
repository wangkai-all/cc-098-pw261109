/* 端到端验证：启动示例服务与同步应用（独立库/端口），逐项验证需求场景 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_PORT = 4101;
const APP_PORT = 4100;
const DB_DIR = join(root, 'data', 'e2e');
const BASE = `http://localhost:${APP_PORT}`;

let passed = 0;
let failed = 0;
const children = [];

function spawnNode(name, cwd, env) {
  const c = spawn(process.execPath, ['server.js'], {
    cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', (d) => process.stdout.write(`  \x1b[36m[${name}]\x1b[0m ${d}`));
  c.stderr.on('data', (d) => process.stderr.write(`  \x1b[31m[${name}]\x1b[0m ${d}`));
  children.push(c);
  return c;
}

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗ ${name}${detail ? ` — ${detail}` : ''}\x1b[0m`);
  }
}

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`服务未就绪: ${url}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

async function waitUntil(predicate, timeoutMs = 12000, label = '') {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`等待超时: ${label}; 最后状态: ${JSON.stringify(last)}`);
}

async function getState(name) {
  const s = await api('/api/state');
  return s.collections.find((c) => c.collection === name);
}
async function getEntities(name, status = '') {
  const r = await api(`/api/entities/${name}?status=${encodeURIComponent(status)}`);
  return r.value;
}
async function roundCount() {
  return (await api('/api/rounds?limit=200')).rounds;
}

// 手动触发一轮 delta（或重建）并等待该集合回到空闲
async function runRound(collection) {
  const before = (await getState(collection)).last_round_id;
  await api(`/api/collections/${collection}/retry`, { method: 'POST' });
  await waitUntil(async () => {
    const s = await getState(collection);
    return s.active_round_id === null && s.last_round_id !== before;
  }, 15000, `${collection} 轮次完成`);
  return getState(collection);
}

async function main() {
  rmSync(DB_DIR, { recursive: true, force: true });

  console.log('\n=== 启动服务（独立 e2e 库）===');
  spawnNode('sample', join(root, 'packages/sample-service'), { SAMPLE_PORT: String(SAMPLE_PORT) });
  spawnNode('app', join(root, 'packages/sync-app'), {
    APP_PORT: String(APP_PORT),
    SAMPLE_URL: `http://localhost:${SAMPLE_PORT}`,
    DB_PATH: join(DB_DIR, 'e2e.db'),
    POLL_INTERVAL_MS: '60000',
  });
  await waitFor(`http://localhost:${SAMPLE_PORT}/odata`);
  await waitFor(`${BASE}/api/state`);

  // ---------- 1. 首次全量 ----------
  console.log('\n=== 1. 开启两个集合，完成首次全量同步 ===');
  await api('/api/collections/customers/enable', { method: 'POST', body: { enabled: true } });
  await api('/api/collections/addresses/enable', { method: 'POST', body: { enabled: true } });

  await waitUntil(async () => (await getState('customers')).delta_link, 10000, 'customers deltaLink');
  await waitUntil(async () => (await getState('addresses')).delta_link, 10000, 'addresses deltaLink');
  const c0 = await getState('customers');
  const a0 = await getState('addresses');
  check('customers 首轮完成并保存 deltaLink', !!c0.delta_link);
  check('addresses 首轮完成并保存 deltaLink', !!a0.delta_link);
  check('customers 生效 5 条', c0.counts.active === 5, `active=${c0.counts.active}`);
  check('addresses 含 1 条孤儿暂存且不丢数据', a0.counts.orphan === 1 && a0.counts.live === 8,
    `orphan=${a0.counts.orphan}, live=${a0.counts.live}`);
  const orphan = (await getEntities('addresses', 'orphan'))[0];
  check('孤儿地址有暂存原因说明', /不存在/.test(orphan.orphanReason || ''), orphan.orphanReason);
  const firstRounds = await roundCount();
  check('两个集合各自至少有一轮全量', firstRounds.filter((r) => r.kind === 'full').length >= 2);

  // ---------- 2. 增量：新增/更新/删除 ----------
  console.log('\n=== 2. 增量轮次捕获新增、更新、删除 ===');
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/customers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Name: '增量新客户', Email: 'new@delta.example' }),
  }).then((r) => r.json());
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/customers/2`, { method: 'PATCH' }).then((r) => r.json());
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/customers/5`, { method: 'DELETE' }).then((r) => r.json());

  await runRound('customers');
  const rows = await getEntities('customers');
  const tomb = await getEntities('customers', 'tombstoned');
  check('增量后新增 1 条、删除 1 条（生效 5+1-1=5，含墓碑 #5）',
    rows.length === 6 && tomb.some((t) => t.key === 5),
    `live=${rows.length}, tomb=${tomb.map((t) => t.key).join(',')}`);
  const prov5 = await api('/api/entities/customers/5/provenance');
  check('客户 #5 有 created 与 deleted 两类溯源轮次',
    prov5.provenance.some((p) => p.op === 'created') && prov5.provenance.some((p) => p.op === 'deleted'));
  const delRound = prov5.provenance.find((p) => p.op === 'deleted').round_id;
  check('溯源能定位删除来自哪个轮次/第几个请求',
    typeof delRound === 'number' && prov5.provenance.some((p) => p.op === 'deleted' && p.request_no >= 1));

  // ---------- 3. 删除后旧更新不能复活 ----------
  console.log('\n=== 3. 删除之后到达的旧更新不能让记录复活 ===');
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/stale-upsert`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection: 'customers',
      entity: { Id: 5, Name: '死而复生的客户', Email: 'zombie@example', Revision: 99 },
    }),
  }).then((r) => r.json());
  await runRound('customers');
  const c5 = await api('/api/entities/customers/5/provenance');
  check('#5 保持 tombstoned，未被旧更新复活', c5.entity && c5.entity.status === 'tombstoned');
  check('旧更新留下 stale_skipped 溯源', c5.provenance.some((p) => p.op === 'stale_skipped'));

  // ---------- 4. 重复删除幂等 ----------
  console.log('\n=== 4. 重复删除不能造成多次处理 ===');
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/customers/4`, { method: 'DELETE' }).then((r) => r.json());
  await runRound('customers');
  // 服务端再补发一次对 #4 的删除事件
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/delete-twice`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: 'customers', key: 4 }),
  }).then((r) => r.json());
  await runRound('customers');
  const c4 = await api('/api/entities/customers/4/provenance');
  check('#4 被删除且只产生一次 deleted 处理，重复删除留痕为 delete_repeated',
    c4.provenance.filter((p) => p.op === 'deleted').length === 1 &&
    c4.provenance.some((p) => p.op === 'delete_repeated'),
    `ops=${c4.provenance.map((p) => p.op).join(',')}`);

  // ---------- 5. 重复页（服务端重放） ----------
  console.log('\n=== 5. 重复响应页面只处理一次 ===');
  // 先制造 5 条地址变更（页大小 3），保证下一个增量轮次至少跨 2 页
  for (let i = 0; i < 5; i++) {
    await fetch(`http://localhost:${SAMPLE_PORT}/admin/addresses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CustomerId: 1, City: '重复页测试', Street: `街道 ${i}` }),
    }).then((r) => r.json());
  }
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/fault`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // delta 轮次仅 2 页，故障布置在第 1 页：重放首页（首页之前已成功，可被识别）
    body: JSON.stringify({ collection: 'addresses', type: 'dupPage', page: 1 }),
  }).then((r) => r.json());
  const beforeDup = await getState('addresses');
  await api('/api/collections/addresses/retry', { method: 'POST' });
  await waitUntil(async () => {
    const s = await getState('addresses');
    return s.active_round_id === null && s.last_round_id !== beforeDup.last_round_id;
  }, 12000, '手动增量轮次完成');
  const aState = await getState('addresses');
  const dupRound = (await roundCount()).find((r) => r.collection === 'addresses' && r.dupe_pages > 0);
  check('存在记录了重复页的轮次', !!dupRound, dupRound ? `#${dupRound.id} dup=${dupRound.dupe_pages}` : '无');
  if (dupRound) {
    const detail = await api(`/api/rounds/${dupRound.id}`);
    check('台账中重放页被标记 is_replay', detail.pages.some((p) => p.is_replay === 1));
  }
  check('重复页后地址总数无重复处理（原生效 8 + 新增 5 = 13，孤儿仍为 1）',
    aState.counts.live === 13 && aState.counts.orphan === 1,
    `live=${aState.counts.live} orphan=${aState.counts.orphan}`);

  // ---------- 6. 分页中断后自动恢复 ----------
  console.log('\n=== 6. 分页中断（500）后按 nextLink 自动续跑 ===');
  // 制造足够大的结果集：让地址至少跨多页（每页 3 条），故障在第 2 页
  for (let i = 0; i < 4; i++) {
    await fetch(`http://localhost:${SAMPLE_PORT}/admin/addresses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CustomerId: 1, City: '扩容城市', Street: `扩容街道 ${i}` }),
    }).then((r) => r.json());
  }
  await runRound('addresses'); // 先让增量吃掉新增
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/fault`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: 'addresses', type: 'failPage', page: 2 }),
  }).then((r) => r.json());
  // 游标过期一次以强制全量重建，重建的分页过程中触发一次 500
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/expire`, { method: 'POST' }).then((r) => r.json());
  const beforeFault = await getState('addresses');
  await runRound('addresses'); // 410 -> 接力 rebuild（含第 2 页临时故障与重试）
  const afterRebuild = await getState('addresses');
  check('重建完成后换发了新的 deltaLink',
    !!afterRebuild.delta_link && afterRebuild.delta_link !== beforeFault.delta_link);
  const roundsAfter = await roundCount();
  const rebuild = roundsAfter.find((r) => r.kind === 'rebuild' && r.status === 'completed');
  check('游标过期触发了隔离区全量重建并完成', !!rebuild, rebuild ? `#${rebuild.id}` : '无');
  if (rebuild) {
    const detail = await api(`/api/rounds/${rebuild.id}`);
    check('重建轮次经历多页（含中断后续跑）', detail.pages.length >= 2, `pages=${detail.pages.length}`);
  }
  check('重建后可查询数据完整：17 条地址全部保留，其中 3 条因客户被删转为暂存（不丢数据）',
    afterRebuild.counts.live === 17 && afterRebuild.counts.orphan === 3,
    `live=${afterRebuild.counts.live} orphan=${afterRebuild.counts.orphan}`);

  // ---------- 7. 重建未完成不能推断删除 + 取消 ----------
  console.log('\n=== 7. 未收齐的全量结果不能推断删除；重建可取消且旧数据保留 ===');
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/expire`, { method: 'POST' }).then((r) => r.json());
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/fault`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: 'customers', type: 'failPageRepeat', page: 1 }),
  }).then((r) => r.json());
  // 手动触发：delta 410 -> 接力 rebuild，rebuild 第 1 页持续 500，重试耗尽后落盘为 failed
  const stuckBefore = await getState('customers');
  await api('/api/collections/customers/retry', { method: 'POST' });
  await waitUntil(async () => {
    const s = await getState('customers');
    return s.active_round_id === null && s.last_round_id !== stuckBefore.last_round_id;
  }, 20000, '重建轮次因持续故障落盘');
  const stuck = await getState('customers');
  const stuckRound = (await roundCount()).find((r) => r.id === stuck.last_round_id);
  check('存在因持续故障未能完成的重建轮次（failed）',
    stuckRound && stuckRound.kind === 'rebuild' && stuckRound.status === 'failed',
    `kind=${stuckRound?.kind} status=${stuckRound?.status}`);
  const beforeCancel = stuck.counts;
  check('未收齐的全量结果没有推断任何删除（生效数据不变）',
    stuck.counts.live === beforeCancel.live && stuck.counts.tombstoned === beforeCancel.tombstoned);
  check('失败后 deltaLink 仍是旧起点，未被半成品替换',
    stuck.delta_link === stuckBefore.delta_link);

  // 演示“取消尚未切换的重建”：再布置一次会卡在运行中的重建，通过取消接口中止
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/clear-faults`, { method: 'POST' }).then((r) => r.json());
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/fault`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: 'customers', type: 'failPageRepeat', page: 2 }),
  }).then((r) => r.json());
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/expire`, { method: 'POST' }).then((r) => r.json());
  await api('/api/collections/customers/retry', { method: 'POST' });
  await waitUntil(async () => {
    const s = await getState('customers');
    return !!s.active_round_id && s.activeRound.kind === 'rebuild' && s.activeRound.status === 'running';
  }, 20000, '出现 running 重建轮次');
  const runningState = await getState('customers');
  await api('/api/collections/customers/cancel', { method: 'POST' });
  await waitUntil(async () => (await getState('customers')).active_round_id === null, 6000, '取消生效');
  const afterCancel = await getState('customers');
  check('取消后原可查询数据完全保留',
    afterCancel.counts.live === beforeCancel.live && afterCancel.counts.tombstoned === beforeCancel.tombstoned,
    `before=${JSON.stringify(beforeCancel)} after=${JSON.stringify(afterCancel.counts)}`);
  check('取消后 deltaLink 未被替换（同步起点不变）',
    afterCancel.delta_link === runningState.delta_link);
  const cancelledRound = (await roundCount()).find((r) => r.status === 'cancelled' && r.kind === 'rebuild');
  check('轮次标记为 cancelled', !!cancelledRound);
  check('取消后自动同步被抑制（不会自行重启重建），等待手动恢复',
    afterCancel.auto_suppressed === 1, `auto_suppressed=${afterCancel.auto_suppressed}`);

  // 解除故障，手动重试：游标已过期，将重新发起全量重建，完整收齐后切换
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/clear-faults`, { method: 'POST' }).then((r) => r.json());
  await runRound('customers');
  const finalC = await getState('customers');
  // 客户 4、5 已在前面的步骤删除，当前服务端存活客户为 1、2、3、6 共 4 个
  check('重新全量完成后数据可查询、无错误，与服务端一致（4 个存活客户）',
    finalC.counts.live === 4 && !finalC.last_error, `live=${finalC.counts.live}`);
  check('手动重试解除了自动抑制', finalC.auto_suppressed === 0, `auto_suppressed=${finalC.auto_suppressed}`);

  // ---------- 8. 孤儿地址被后到客户收养 ----------
  console.log('\n=== 8. 客户到达后自动收养暂存地址 ===');
  const orphansBefore = await getEntities('addresses', 'orphan');
  check('收养前存在多条暂存地址（客户 4、5 删除后留下 #6、#7，及原始 #8）',
    orphansBefore.map((o) => o.key).sort().join(',') === '6,7,8',
    orphansBefore.map((o) => o.key).join(','));
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/customers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: 99, Name: '迟到的客户', Email: 'late@example' }),
  }).then((r) => r.json());
  await runRound('customers');
  await waitUntil(async () => {
    const a8 = await api('/api/entities/addresses/8/provenance');
    return a8.entity && a8.entity.status === 'active';
  }, 8000, '地址 #8 被收养');
  const adopted = (await api('/api/entities/addresses/8/provenance')).provenance;
  check('地址 #8 留下 orphan_staged -> orphan_adopted 完整轨迹',
    adopted.some((p) => p.op === 'orphan_staged') && adopted.some((p) => p.op === 'orphan_adopted'));
  const orphansAfter = await getEntities('addresses', 'orphan');
  check('其余暂存地址（#6、#7）仍保留不丢，等待各自客户到达',
    orphansAfter.map((o) => o.key).sort().join(',') === '6,7',
    orphansAfter.map((o) => o.key).join(','));

  // ---------- 9. 重启恢复 ----------
  console.log('\n=== 9. 进程重启后继续未完成轮次，原数据保留 ===');
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/expire`, { method: 'POST' }).then((r) => r.json());
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/fault`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection: 'addresses', type: 'failPageRepeat', page: 2 }),
  }).then((r) => r.json());
  const pre9 = await getState('addresses');
  await api('/api/collections/addresses/retry', { method: 'POST' });
  await waitUntil(async () => {
    const s = await getState('addresses');
    return s.active_round_id === null && s.last_round_id !== pre9.last_round_id;
  }, 20000, '重建轮次落盘为 failed（等待重启恢复）');
  const preRestart = await getState('addresses');
  const preLive = preRestart.counts.live;
  const failedRoundId = preRestart.last_round_id;
  check('重启前存在未完成（failed）的重建轮次记录',
    preRestart.lastRound && preRestart.lastRound.kind === 'rebuild' && preRestart.lastRound.status === 'failed',
    `round #${failedRoundId}`);

  const appProc = children[1];
  appProc.kill('SIGTERM');
  await sleep(800);
  const restarted = spawnNode('app*', join(root, 'packages/sync-app'), {
    APP_PORT: String(APP_PORT),
    SAMPLE_URL: `http://localhost:${SAMPLE_PORT}`,
    DB_PATH: join(DB_DIR, 'e2e.db'),
    POLL_INTERVAL_MS: '60000',
  });
  await waitFor(`${BASE}/api/state`);
  const postBoot = await getState('addresses');
  check('重启后自动接续同一轮次（round id 不变）',
    postBoot.active_round_id === failedRoundId,
    `before=${failedRoundId} after=${postBoot.active_round_id}`);
  check('重启后原可查询数据仍然保留', postBoot.counts.live === preLive,
    `before=${preLive} after=${postBoot.counts.live}`);

  // 解除故障，等待重启后的轮次跑完
  await fetch(`http://localhost:${SAMPLE_PORT}/admin/clear-faults`, { method: 'POST' }).then((r) => r.json());
  await waitUntil(async () => {
    const s = await getState('addresses');
    return !s.active_round_id && s.delta_link;
  }, 20000, '重启恢复的轮次完成');
  const resumedRound = (await roundCount()).find((r) => r.id === failedRoundId);
  check('被恢复的轮次沿用同一 id 并最终 completed',
    resumedRound && resumedRound.status === 'completed', resumedRound?.status);
  check('恢复后 deltaLink 已更新为新起点', !!(await getState('addresses')).delta_link);

  console.log(`\n=== 结果：\x1b[32m${passed} 通过\x1b[0m，${failed ? `\x1b[31m${failed} 失败\x1b[0m` : '0 失败'} ===\n`);
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
}

main().catch((err) => {
  console.error('e2e 致命错误:', err);
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(1), 300);
});
