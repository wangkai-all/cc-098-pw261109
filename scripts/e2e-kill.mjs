/* 验证：同步进行中强杀进程（running 轮次），重启后按持久化 cursor 接续同一轮次 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const root = '/workspace';
const DB = '/tmp/kill.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (name, cwd, env) => spawn(process.execPath, ['server.js'], {
  cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
});

const sample = mk('s', `${root}/packages/sample-service`, { SAMPLE_PORT: '4601', RESPONSE_DELAY_MS: '800' });
sample.stderr.on('data', (d) => console.error('[sample]', String(d).trim()));
let app = mk('a', `${root}/packages/sync-app`, {
  APP_PORT: '4600', SAMPLE_URL: 'http://localhost:4601', DB_PATH: DB, POLL_INTERVAL_MS: '60000',
});
app.stdout.on('data', (d) => console.log(String(d).trim()));
app.stderr.on('data', (d) => console.error(String(d).trim()));

const api = (p, o) => fetch(`http://localhost:4600${p}`, { headers: { 'Content-Type': 'application/json' }, ...o });
await sleep(1500);

await api('/api/collections/addresses/enable', { method: 'POST', body: '{"enabled":true}' });
// 先等首轮全量完成拿到 deltaLink
for (let i = 0; i < 20; i++) {
  await sleep(500);
  const s = await api('/api/state').then((r) => r.json());
  if (s.collections.find((c) => c.collection === 'addresses').delta_link) break;
}

// 让游标过期，使下次同步进入多页 rebuild；再布置第 2 页持续故障让轮次保持 running
await fetch('http://localhost:4601/admin/expire', { method: 'POST' });
await fetch('http://localhost:4601/admin/fault', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ collection: 'addresses', type: 'failPageRepeat', page: 2 }),
});
await api('/api/collections/addresses/retry', { method: 'POST' });
await sleep(3000); // rebuild 第 1 页已落盘、卡在第 2 页（running）

const pre = await api('/api/state').then((r) => r.json());
const addrPre = pre.collections.find((c) => c.collection === 'addresses');
const runningId = addrPre.active_round_id;
const preLive = addrPre.counts.live;
console.log(`强杀前：running 轮次 #${runningId}，已持久化 cursor=${addrPre.activeRound.cursor.slice(0, 40)}...`);
if (!runningId || addrPre.activeRound.kind !== 'rebuild') {
  console.error('前置条件不满足，未进入 running rebuild');
  process.exit(1);
}

// SIGKILL 强杀（不给优雅退出机会，模拟崩溃/断电）
app.kill('SIGKILL');
await sleep(1000);

// 解除故障后重启：应自动接续同一 running 轮次
await fetch('http://localhost:4601/admin/clear-faults', { method: 'POST' });
app = mk('a2', `${root}/packages/sync-app`, {
  APP_PORT: '4600', SAMPLE_URL: 'http://localhost:4601', DB_PATH: DB, POLL_INTERVAL_MS: '60000',
});
app.stdout.on('data', (d) => console.log(String(d).trim()));
app.stderr.on('data', (d) => console.error(String(d).trim()));

for (let i = 0; i < 20; i++) {
  await sleep(800);
  try {
    const s = await api('/api/state').then((r) => r.json());
    const c = s.collections.find((x) => x.collection === 'addresses');
    if (!c.active_round_id && c.delta_link) {
      const pass = c.last_round_id === runningId && c.counts.live === preLive;
      console.log(`重启后：轮次 #${c.last_round_id}（期望 #${runningId}），live=${c.counts.live}（期望 ${preLive}）`);
      console.log(pass ? '\n✓ running 轮次崩溃恢复成功，同一轮次 id 接续并完成，数据保留' : '\n✗ 恢复结果不符');
      sample.kill(); app.kill();
      setTimeout(() => process.exit(pass ? 0 : 1), 200);
      break;
    }
  } catch { /* 服务还在启动 */ }
}
