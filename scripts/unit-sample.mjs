import { store } from '../packages/sample-service/store.js';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name} ${extra}`); }
  else { console.error(`  ✗ ${name} ${extra}`); process.exitCode = 1; }
};

// 全量分页：5 条客户、页大小 3 → 2 页，末页给 deltaLink
let r = store.serve('customers', {});
ok('首页 3 条 + nextLink', r.body.value.length === 3 && !!r.body['@odata.nextLink']);
const id1 = r.body['@meso.pageId'];
const tok1 = new URL('http://x' + r.body['@odata.nextLink']).searchParams.get('$skiptoken');
r = store.serve('customers', { skiptoken: tok1 });
ok('第二页 2 条 + deltaLink', r.body.value.length === 2 && !!r.body['@odata.deltaLink']);
ok('两页 pageId 不同', id1 !== r.body['@meso.pageId'], `${id1} vs ${r.body['@meso.pageId']}`);

// 重试首页：pageId 稳定
r = store.serve('customers', {});
ok('重试首页 pageId 稳定', r.body['@meso.pageId'] === id1);

// 故障：第二页 500 一次，重试同一游标后成功且 pageId 稳定
store.reset();
store.setFault('customers', 'failPage', 2);
r = store.serve('customers', {});
const t2 = new URL('http://x' + r.body['@odata.nextLink']).searchParams.get('$skiptoken');
const f1 = store.serve('customers', { skiptoken: t2 });
ok('第 2 页故障返回 500', f1.status === 500);
const f2 = store.serve('customers', { skiptoken: t2 });
ok('故障后重试同游标成功', f2.status === 200 && !!f2.body['@odata.deltaLink']);

// 重复页：第二页重放第一页，重放页带 replayed 标记且 pageId 指向当前逻辑页
store.reset();
store.setFault('customers', 'dupPage', 2);
const p1 = store.serve('customers', {});
const t3 = new URL('http://x' + p1.body['@odata.nextLink']).searchParams.get('$skiptoken');
const dup = store.serve('customers', { skiptoken: t3 });
ok('重复页重放并带 replayed 标记', dup.body['@meso.replayed'] === true);
ok('重放页内容来自上一页', JSON.stringify(dup.body.value) === JSON.stringify(p1.body.value));
const real2 = store.serve('customers', { skiptoken: t3 });
ok('重放后再请求得到真正的第二页', real2.body.value.length === 2 && !!real2.body['@odata.deltaLink']);
ok('重放页与真实第二页 pageId 相同（同位置），但与首页不同',
  dup.body['@meso.pageId'] === real2.body['@meso.pageId'] &&
  dup.body['@meso.pageId'] !== p1.body['@meso.pageId']);

// 游标过期
store.reset();
const good = store.serve('customers', {});
const goodTok = new URL('http://x' + good.body['@odata.nextLink']).searchParams.get('$skiptoken');
store.expireTokens();
const expired = store.serve('customers', { skiptoken: goodTok });
ok('过期游标返回 410', expired.status === 410 && expired.body.error.code === 'DeltaTokenExpired');

// 过期后重新全量可以完成
const fresh = store.serve('customers', {});
ok('过期后首页全量正常', fresh.status === 200 && fresh.body.value.length === 3);

console.log(`\n${pass} 项示例服务行为检查通过`);
