# OData 增量采集台

一个自带本地 OData 示例服务的增量同步演示：选择 **客户（customers）** 与 **地址（addresses）**
两个集合，完成首次全量后沿 `deltaLink` 持续拉取变化，并把每条记录“新增 / 更新 / 删除
分别来自哪一轮、第几个请求”完整留痕。

## 架构

```
packages/
  sample-service/   本地 OData 示例服务（端口 4001）
    store.js        内存数据集 + 变更日志 + 分页/增量游标 + 故障注入
    server.js       OData 路由（$skiptoken / $deltatoken）与管理接口
  sync-app/         采集应用（端口 4000）
    db.js           SQLite schema（轮次、页面台账、实体、溯源、隔离区）与迁移
    engine.js       同步引擎：轮次状态机、去重、墓碑、隔离重建、孤儿暂存、重启恢复
    server.js       REST API + 静态界面
    public/         单页界面（同步控制 / 数据浏览 / 故障台）
scripts/
  dev.js            同时拉起两个服务
  unit-sample.mjs   示例服务分页/故障行为单测
  e2e.mjs           端到端 34 项场景验证
  e2e-kill.mjs      SIGKILL 崩溃恢复专项验证
data/               SQLite 数据库（运行时生成，已 gitignore）
```

## 快速开始

```bash
npm install
npm run dev          # 示例服务 :4001，采集应用 :4000
# 浏览器打开 http://localhost:4000
```

测试：

```bash
npm run test:unit    # 示例服务协议行为（12 项）
npm run test         # 端到端全场景（34 项）
npm run test:kill    # 强杀进程后的崩溃恢复
```

## 同步协议与可靠性设计

### 分页与同步起点
- 沿服务返回的 `@odata.nextLink` 逐页拉取；**只有整轮收齐、拿到 `@odata.deltaLink` 后**，
  才把它写为新的同步起点（`sync_state.delta_link`）。
- 每个成功页的 nextLink 都先落库再处理，进程中断后从该游标继续，不重复应用。

### 重复处理防护
- **页面台账** `sync_pages` 对 `(round_id, page_id)` 建唯一约束；重复页只登记为 replay，
  整页跳过、不推进游标，绝不二次处理。
- 服务端重放页带 `@meso.replayed` 标记，与随后同位置真实页共享 pageId，引擎据此区分。
- **重复删除幂等**：对已删除（tombstoned）或不存在的记录再收到删除，记 `delete_repeated` 留痕，不重复计数。
- **旧事件不复活**：墓碑记录收到任何 upsert 一律记 `stale_skipped`；序号更旧的事件同样忽略，
  删除之后到达的旧更新无法让记录复活。

### 游标过期与隔离区重建
- 服务返回 410（`DeltaTokenExpired`）时，当前轮次判失败，并在**同一工作流内接力**一个
  `rebuild` 全量轮次，结果先写入 `staging_entities` 隔离区。
- 隔离区**完整收齐之前**：生效表 `entities` 与旧 deltaLink 完全不变，因此未收完的全量结果
  不会被用来推断任何删除。
- 收齐后在一个事务内切换：upsert 隔离数据 → 对生效表中缺失的键打墓碑（此时才推断删除）
  → 换发新 deltaLink。
- 重建可在切换前**取消**：丢弃隔离区、轮次标记 cancelled、旧数据与旧同步起点原样保留；
  取消会置 `auto_suppressed`，自动轮询不再自行重启，需手动「立即重试」或重新开启采集。

### 引用完整性与孤儿暂存
- 地址引用的客户不存在时，地址以 `orphan` 状态暂存并写明原因，**不丢数据**。
- 客户随后到达时自动“收养”对应暂存地址（`orphan_staged → orphan_adopted` 全程留痕）。
- 客户被删除后，其名下地址在下次全量重建时转为暂存。

### 重启恢复
- 进程崩溃时仍为 `running` 的轮次：启动后按持久化游标接续**同一轮次 id**。
- 因瞬时故障重试耗尽落盘 `failed`、但游标仍有效的轮次：启动后自动重试，沿用同一轮次 id。
- 410 失败与被用户取消（`auto_suppressed`）的轮次不会在重启后自动拉起。
- 整个恢复过程中，已生效的可查询数据始终保留。

## 示例服务故障台（界面第三页 / `/admin/*`）

| 能力 | 接口 | 说明 |
| --- | --- | --- |
| 分页中断 | `POST /admin/fault` `{type:"failPage",page}` | 第 N 页返回一次 500，重试即恢复 |
| 持续故障 | `type:"failPageRepeat"` | 第 N 页起持续 500，耗尽重试后落盘，用于验证重启恢复 |
| 重复响应 | `type:"dupPage"` | 第 N 页重放上一页内容（带 replayed 标记） |
| 游标过期 | `POST /admin/expire` | epoch 递增，所有 nextLink/deltaLink 返回 410 |
| 旧事件注入 | `POST /admin/stale-upsert` | 注入针对已删除记录的 upsert，验证不复活 |
| 重复删除 | `POST /admin/delete-twice` | 再发一次删除，验证幂等 |
| 数据增改删 | `/admin/customers`、`/admin/addresses` | 制造增量变化 |

## 主要数据表

- `sync_state`：每集合的开关、当前/最近轮次、deltaLink、取消抑制标记。
- `sync_rounds`：轮次（full / delta / rebuild）状态机与各项计数。
- `sync_pages`：分页请求台账与重放标记。
- `entities`：生效实体，状态 `active / orphan / tombstoned`。
- `entity_provenance`：逐请求溯源（created / updated / deleted / stale_skipped /
  delete_repeated / orphan_staged / orphan_adopted）。
- `staging_entities`：重建隔离区，切换后清空。
