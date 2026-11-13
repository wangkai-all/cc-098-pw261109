import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const procs = [
  { name: 'sample-service', cwd: join(root, 'packages/sample-service'), entry: 'server.js', color: '36' },
  { name: 'sync-app', cwd: join(root, 'packages/sync-app'), entry: 'server.js', color: '35' },
];

const children = procs.map((p) => {
  const child = spawn(process.execPath, [join(p.cwd, p.entry)], { cwd: p.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${p.color}m[${p.name}]\x1b[0m`;
  child.stdout.on('data', (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}\n`).join('')));
  child.stderr.on('data', (d) => process.stderr.write(String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}\n`).join('')));
  return child;
});

function shutdown() {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
