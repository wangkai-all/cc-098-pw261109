import { now, ensureState } from './db.js';

const COLLECTIONS = ['customers', 'addresses'];
const ENTITY_KEY = 'Id';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 4000);
const MAX_FETCH_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SyncEngine {
  constructor(db, { sampleUrl }) {
    this.db = db;
    this.sampleUrl = sampleUrl.replace(/\/$/, '');
    this.running = new Map(); // collection -> Promise
    this.stmts = this.#prepare();
    for (const c of COLLECTIONS) ensureState(db, c);
  }

  #prepare() {
    const db = this.db;
    return {
      getState: db.prepare('SELECT * FROM sync_state WHERE collection = ?'),
      setActive: db.prepare('UPDATE sync_state SET active_round_id = ?, last_error = NULL, updated_at = ? WHERE collection = ?'),
      setError: db.prepare('UPDATE sync_state SET active_round_id = NULL, last_error = ?, updated_at = ? WHERE collection = ?'),
      setFailed: db.prepare('UPDATE sync_state SET active_round_id = NULL, last_round_id = ?, last_error = ?, updated_at = ? WHERE collection = ?'),
      setDeltaLink: db.prepare('UPDATE sync_state SET delta_link = ?, last_round_id = ?, active_round_id = NULL, last_error = NULL, updated_at = ? WHERE collection = ?'),
      setEnabled: db.prepare('UPDATE sync_state SET enabled = ?, updated_at = ? WHERE collection = ?'),
      suppressAuto: db.prepare('UPDATE sync_state SET auto_suppressed = 1, updated_at = ? WHERE collection = ?'),
      clearSuppress: db.prepare('UPDATE sync_state SET auto_suppressed = 0, updated_at = ? WHERE collection = ?'),
      getRound: db.prepare('SELECT * FROM sync_rounds WHERE id = ?'),
      insertRound: db.prepare(
        `INSERT INTO sync_rounds (collection, kind, status, cursor, started_at)
         VALUES (?, ?, 'running', ?, ?)`
      ),
      bumpRound: db.prepare(
        `UPDATE sync_rounds SET cursor = ?, pages_fetched = pages_fetched + 1,
           dupe_pages = dupe_pages + ?, dupe_items = dupe_items + ?, stale_events = stale_events + ?
         WHERE id = ?`
      ),
      finishRound: db.prepare(
        `UPDATE sync_rounds SET status = ?, final_delta_link = ?, error_code = ?, error = ?,
           items_added = ?, items_updated = ?, items_deleted = ?, completed_at = ?
         WHERE id = ?`
      ),
      cancelRound: db.prepare(
        `UPDATE sync_rounds SET status = 'cancelled', cancel_requested = 1, completed_at = ? WHERE id = ? AND status = 'running'`
      ),
      requestCancel: db.prepare('UPDATE sync_rounds SET cancel_requested = 1 WHERE id = ?'),
      insertPage: db.prepare(
        `INSERT INTO sync_pages (round_id, collection, page_no, page_id, item_count, is_replay, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      upsertEntity: db.prepare(
        `INSERT INTO entities (collection, entity_key, data_json, status, orphan_reason, source_seq,
             first_round_id, last_round_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(collection, entity_key) DO UPDATE SET
           data_json = excluded.data_json, status = excluded.status,
           orphan_reason = excluded.orphan_reason, source_seq = excluded.source_seq,
           last_round_id = excluded.last_round_id, updated_at = excluded.updated_at`
      ),
      getEntity: db.prepare('SELECT * FROM entities WHERE collection = ? AND entity_key = ?'),
      liveCustomer: db.prepare(
        `SELECT 1 FROM entities WHERE collection = 'customers' AND entity_key = ? AND status != 'tombstoned'`
      ),
      orphanAddressesFor: db.prepare(
        `SELECT * FROM entities WHERE collection = 'addresses' AND status = 'orphan'
         AND json_extract(data_json, '$.CustomerId') = ?`
      ),
      adoptAddress: db.prepare(
        `UPDATE entities SET status = 'active', orphan_reason = NULL, last_round_id = ?, updated_at = ?
         WHERE collection = 'addresses' AND entity_key = ? AND status = 'orphan'`
      ),
      insertProv: db.prepare(
        `INSERT INTO entity_provenance (collection, entity_key, round_id, request_no, op, source_seq, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      stageUpsert: db.prepare(
        `INSERT INTO staging_entities (round_id, collection, entity_key, data_json, source_seq)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(round_id, collection, entity_key) DO UPDATE SET
           data_json = excluded.data_json, source_seq = excluded.source_seq`
      ),
      clearStaging: db.prepare('DELETE FROM staging_entities WHERE round_id = ?'),
      stagingKeys: db.prepare('SELECT entity_key, data_json, source_seq FROM staging_entities WHERE round_id = ? AND collection = ?'),
      liveKeys: db.prepare("SELECT entity_key FROM entities WHERE collection = ? AND status != 'tombstoned'"),
      tombstone: db.prepare(
        `UPDATE entities SET status = 'tombstoned', data_json = NULL, orphan_reason = NULL,
           last_round_id = ?, updated_at = ? WHERE collection = ? AND entity_key = ? AND status != 'tombstoned'`
      ),
      allAddresses: db.prepare("SELECT entity_key, data_json FROM entities WHERE collection = 'addresses' AND status != 'tombstoned'"),
    };
  }

  baseUrl(collection) {
    const name = collection === 'customers' ? 'Customers' : 'Addresses';
    return `${this.sampleUrl}/odata/${name}`;
  }

  // 服务返回的 nextLink/deltaLink 可能是相对路径，统一解析为绝对地址
  resolveLink(link) {
    if (!link) return link;
    return new URL(link, this.sampleUrl).toString();
  }

  // ---------- 生命周期 ----------

  start() {
    this.#resumeOnBoot();
    this.timer = setInterval(() => this.#tick().catch((e) => console.error('[engine] tick', e)), POLL_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  #resumeOnBoot() {
    // 1) 进程被杀时仍标记 running 的轮次：按已持久化 cursor 继续同一轮次。
    //    用户主动取消（auto_suppressed）的集合不在重启后自动拉起。
    const open = this.db.prepare(
      `SELECT r.* FROM sync_rounds r
       JOIN sync_state s ON s.collection = r.collection
       WHERE r.status = 'running' AND COALESCE(s.auto_suppressed, 0) = 0
       ORDER BY r.id`
    ).all();
    for (const round of open) {
      console.log(`[engine] 重启恢复：集合 ${round.collection} 的轮次 #${round.id}（${round.kind}）继续`);
      this.stmts.setActive.run(round.id, now(), round.collection);
      this.#launch(round.collection, round.id);
    }
    // 2) 因瞬时故障落盘 failed、但游标仍可继续的轮次：自动重试，仍沿用同一轮次 id
    const recoverable = this.db.prepare(
      `SELECT r.* FROM sync_rounds r
       JOIN sync_state s ON s.collection = r.collection AND s.enabled = 1
       WHERE r.status = 'failed' AND r.error_code != 'DeltaTokenExpired'
         AND COALESCE(s.auto_suppressed, 0) = 0
         AND r.id = COALESCE(s.last_round_id, -1)
       ORDER BY r.id`
    ).all();
    for (const round of recoverable) {
      console.log(`[engine] 重启重试：集合 ${round.collection} 的失败轮次 #${round.id}（${round.error_code}）`);
      this.db.prepare(
        `UPDATE sync_rounds SET status = 'running', error = NULL, error_code = NULL, completed_at = NULL WHERE id = ?`
      ).run(round.id);
      this.stmts.setActive.run(round.id, now(), round.collection);
      this.stmts.setEnabled.run(1, now(), round.collection);
      this.#launch(round.collection, round.id);
    }
  }

  async #tick() {
    for (const collection of COLLECTIONS) {
      const state = this.stmts.getState.get(collection);
      if (!state.enabled || this.running.has(collection)) continue;
      if (state.active_round_id) continue;
      // 用户取消过重建：停止自动发起，等待显式手动重试
      if (state.auto_suppressed) continue;
      if (state.delta_link) {
        this.startRound(collection, 'delta', state.delta_link);
      } else {
        this.startRound(collection, 'full', this.baseUrl(collection));
      }
    }
  }

  setEnabled(collection, enabled) {
    this.stmts.setEnabled.run(enabled ? 1 : 0, now(), collection);
    if (enabled) {
      // 重新开启视为明确恢复意图，解除取消抑制
      this.stmts.clearSuppress.run(now(), collection);
      this.#tick().catch(() => {});
    }
  }

  // 手动重试：有增量游标走 delta，否则重新全量；显式操作会解除取消抑制
  manualRetry(collection) {
    if (this.running.has(collection)) return { ok: false, reason: '已有进行中的轮次' };
    const state = this.stmts.getState.get(collection);
    this.stmts.clearSuppress.run(now(), collection);
    if (state.delta_link) return this.startRound(collection, 'delta', state.delta_link);
    return this.startRound(collection, 'full', this.baseUrl(collection));
  }

  requestCancel(collection) {
    const state = this.stmts.getState.get(collection);
    if (!state.active_round_id) return { ok: false, reason: '没有进行中的轮次' };
    const round = this.stmts.getRound.get(state.active_round_id);
    this.stmts.requestCancel.run(round.id);
    return { ok: true, roundId: round.id, kind: round.kind };
  }

  startRound(collection, kind, cursor) {
    if (this.running.has(collection)) return { ok: false, reason: '已有进行中的轮次' };
    const roundId = this.#createRound(collection, kind, cursor);
    this.#launch(collection, roundId);
    return { ok: true, roundId };
  }

  #createRound(collection, kind, cursor) {
    const info = this.stmts.insertRound.run(collection, kind, cursor, now());
    const roundId = Number(info.lastInsertRowid);
    this.stmts.setActive.run(roundId, now(), collection);
    return roundId;
  }

  #launch(collection, roundId) {
    const p = this.#runRound(collection, roundId)
      .catch((err) => console.error(`[engine] round #${roundId} 异常`, err))
      .finally(() => this.running.delete(collection));
    this.running.set(collection, p);
  }

  // ---------- 轮次主循环 ----------

  async #runRound(collection, initialRoundId) {
    let roundId = initialRoundId;
    // 清理上一轮可能残留的隔离区（仅属于本轮，正常路径下为空）
    while (true) {
      const round = this.stmts.getRound.get(roundId);
      if (!round || round.status !== 'running') return;
      if (round.cancel_requested) {
        this.#cancelRound(round);
        return;
      }

      let resp;
      try {
        resp = await this.#fetchWithRetry(this.resolveLink(round.cursor),
          () => !!this.stmts.getRound.get(roundId)?.cancel_requested);
      } catch (err) {
        // 取消优先于故障判定：重试期间收到取消则按取消收尾，而不是记为失败
        if (this.stmts.getRound.get(roundId)?.cancel_requested) {
          this.#cancelRound(this.stmts.getRound.get(roundId));
          return;
        }
        this.#failRound(round, err.code || 'FetchError', err.message);
        return;
      }

      if (resp.status === 410) {
        const rebuildId = this.#handleExpired(round, resp.body);
        if (rebuildId === null) return; // 取消等异常情况
        // 在同一工作流内接力重建：复用 running 槽位，避免被并发守卫拒绝
        roundId = rebuildId;
        continue;
      }
      if (resp.status >= 400) {
        const msg = resp.body?.error?.message || `HTTP ${resp.status}`;
        this.#failRound(round, resp.body?.error?.code || `HTTP_${resp.status}`, msg);
        return;
      }

      const body = resp.body;
      const nextLink = body['@odata.nextLink'] || null;
      const deltaLink = body['@odata.deltaLink'] || null;
      const pageId = body['@meso.pageId'] || this.#fallbackPageId(body);
      const items = Array.isArray(body.value) ? body.value : [];
      const isReplayed = body['@meso.replayed'] === true;
      const requestNo = round.pages_fetched + 1;

      const result = this.db.transaction(() =>
        this.#applyPage(round, pageId, requestNo, items, nextLink, deltaLink, isReplayed))();

      if (deltaLink && !result.pendingRealPage) {
        this.#complete(round, deltaLink);
        return;
      }
      // 循环继续，使用事务中持久化的新 cursor（断点恢复依赖它）
      await sleep(120); // 让页面轮询节奏可见
    }
  }

  #applyPage(round, pageId, requestNo, items, nextLink, deltaLink, isReplayed) {
    const dupCounters = { dupPages: 0, dupItems: 0, stale: 0, pendingRealPage: false };

    if (isReplayed) {
      // 服务端明确标记的重放页：内容是上一页副本，整页跳过、不推进 cursor；
      // 同一 pageId 的真实页随后到达时仍需正常处理（台账用 #replay 后缀避免撞唯一键）
      dupCounters.dupPages = 1;
      dupCounters.dupItems = items.length;
      dupCounters.pendingRealPage = true;
      this.stmts.insertPage.run(round.id, round.collection, requestNo,
        `${pageId}#replay@${requestNo}`, items.length, 1, now());
      this.stmts.bumpRound.run(round.cursor, 1, items.length, 0, round.id);
      return dupCounters;
    }

    try {
      this.stmts.insertPage.run(round.id, round.collection, requestNo, pageId, items.length, 0, now());
    } catch {
      // 无标记但 pageId 撞车（真实网络重试导致的重复送达）：整页跳过，绝不二次处理；
      // 关键：不推进 cursor，继续用当前 nextLink 拉真正的下一页
      dupCounters.dupPages = 1;
      dupCounters.dupItems = items.length;
      this.stmts.insertPage.run(round.id, round.collection, requestNo,
        `${pageId}#dup@${requestNo}`, items.length, 1, now());
      this.stmts.bumpRound.run(round.cursor, 1, items.length, 0, round.id);
      return dupCounters;
    }

    if (round.kind === 'rebuild') {
      for (const item of items) {
        if (this.#isDeleted(item)) continue; // 全量快照里不会有墓碑，稳妥起见忽略
        const key = item[ENTITY_KEY];
        this.stmts.stageUpsert.run(round.id, round.collection, key, JSON.stringify(item), item['@meso.seq'] ?? 0);
      }
    } else if (round.kind === 'full') {
      for (const item of items) this.#applyUpsert(round, item, requestNo, dupCounters);
    } else {
      for (const item of items) {
        if (this.#isDeleted(item)) this.#applyDelete(round, item, requestNo, dupCounters);
        else this.#applyUpsert(round, item, requestNo, dupCounters);
      }
    }

    this.stmts.bumpRound.run(nextLink || deltaLink, 0, 0, dupCounters.stale, round.id);
    return dupCounters;
  }

  #isDeleted(item) {
    return item['@odata.reason'] === 'deleted' || item['@odata.context'] === undefined && item[ENTITY_KEY] === undefined && '@odata.id' in item;
  }

  #deleteKey(item) {
    if (item[ENTITY_KEY] !== undefined) return item[ENTITY_KEY];
    const m = /\((\d+)\)/.exec(item['@odata.id'] || '');
    return m ? Number(m[1]) : item['@meso.key'];
  }

  #applyUpsert(round, item, requestNo, counters) {
    const collection = round.collection;
    const key = item[ENTITY_KEY];
    const seq = item['@meso.seq'] ?? 0;
    const existing = this.stmts.getEntity.get(collection, key);

    // 删除之后到达的旧更新不能复活记录；旧序号事件也一律丢弃
    if (existing && (existing.status === 'tombstoned' || existing.source_seq > seq)) {
      counters.stale += 1;
      this.stmts.insertProv.run(collection, key, round.id, requestNo, 'stale_skipped', seq,
        existing.status === 'tombstoned' ? '记录已删除，旧更新被忽略，不允许复活' : '事件序号早于已应用版本，忽略',
        now());
      return;
    }

    let status = 'active';
    let orphanReason = null;
    let op;
    if (existing) op = 'updated';
    else op = 'created';

    if (collection === 'addresses') {
      const customerId = item.CustomerId;
      if (!this.stmts.liveCustomer.get(customerId)) {
        status = 'orphan';
        orphanReason = `引用的客户 #${customerId} 不存在，已暂存等待客户到达`;
      }
    }

    this.stmts.upsertEntity.run(collection, key, JSON.stringify(item), status, orphanReason, seq,
      existing ? existing.first_round_id : round.id, round.id, now());

    if (!existing && status === 'orphan') op = 'orphan_staged';
    this.stmts.insertProv.run(collection, key, round.id, requestNo, op, seq,
      orphanReason || `第 ${requestNo} 个请求（页）应用`, now());

    if (op === 'created' || op === 'orphan_staged') {
      this.#incRound(round.id, 'items_added');
    } else {
      this.#incRound(round.id, 'items_updated');
    }

    // 新客户到达后，自动“收养”此前暂存的孤儿地址——数据不丢
    if (collection === 'customers') {
      const orphans = this.stmts.orphanAddressesFor.all(key);
      for (const a of orphans) {
        this.stmts.adoptAddress.run(round.id, now(), a.entity_key);
        this.stmts.insertProv.run('addresses', a.entity_key, round.id, requestNo, 'orphan_adopted',
          null, `客户 #${key} 已到达，暂存地址恢复为有效`, now());
      }
    }
  }

  #applyDelete(round, item, requestNo, counters) {
    const collection = round.collection;
    const key = this.#deleteKey(item);
    const seq = item['@meso.seq'] ?? 0;
    const existing = this.stmts.getEntity.get(collection, key);

    if (!existing || existing.status === 'tombstoned') {
      // 重复删除 / 删除未知记录：幂等 no-op，仅留痕
      this.stmts.insertProv.run(collection, key, round.id, requestNo, 'delete_repeated', seq,
        '重复或未知的删除请求，未产生多次处理', now());
      return;
    }
    if (existing.source_seq > seq) {
      counters.stale += 1;
      this.stmts.insertProv.run(collection, key, round.id, requestNo, 'stale_skipped', seq,
        '删除事件序号早于已应用版本，忽略', now());
      return;
    }

    this.stmts.tombstone.run(round.id, now(), collection, key);
    this.stmts.insertProv.run(collection, key, round.id, requestNo, 'deleted', seq,
      `第 ${requestNo} 个请求（页）应用删除`, now());
    this.#incRound(round.id, 'items_deleted');
  }

  #incRound(roundId, column) {
    this.db.prepare(`UPDATE sync_rounds SET ${column} = ${column} + 1 WHERE id = ?`).run(roundId);
  }

  #cancelRound(round) {
    this.stmts.cancelRound.run(now(), round.id);
    this.stmts.clearStaging.run(round.id);
    this.stmts.setError.run(null, now(), round.collection);
    // 用户主动取消：抑制自动轮询重启，等待手动重试或重新开启采集
    this.stmts.suppressAuto.run(now(), round.collection);
    console.log(`[engine] 轮次 #${round.id}（${round.kind}）已取消，隔离区丢弃，生效数据保持不变；自动同步已暂停，等待手动重试`);
  }

  #failRound(round, code, message) {
    const full = `${code}: ${message}`;
    this.db.prepare("UPDATE sync_rounds SET status = 'failed', error_code = ?, error = ?, completed_at = ? WHERE id = ?")
      .run(code, message, now(), round.id);
    this.stmts.setFailed.run(round.id, full, now(), round.collection);
    console.log(`[engine] 轮次 #${round.id} 失败：${full}`);
  }

  // 游标过期：当前轮次判失败，在同一工作流内接力一个进隔离区的全量重建。
  // 返回新轮次 id；重建完成前生效表与 deltaLink 都不变。
  #handleExpired(round, body) {
    const code = body?.error?.code || 'DeltaTokenExpired';
    const message = body?.error?.message || '游标过期';
    this.#failRound(round, code, message);
    this.stmts.clearStaging.run(round.id);
    console.log(`[engine] 集合 ${round.collection} 游标过期，自动开启隔离区全量重建`);
    return this.#createRound(round.collection, 'rebuild', this.baseUrl(round.collection));
  }

  #complete(round, deltaLink) {
    const tx = this.db.transaction(() => {
      if (round.kind === 'rebuild') {
        this.#swapStaging(round, deltaLink);
      }
      const fresh = this.stmts.getRound.get(round.id);
      this.stmts.finishRound.run('completed', deltaLink, null, null,
        fresh.items_added, fresh.items_updated, fresh.items_deleted, now(), round.id);
      this.stmts.setDeltaLink.run(deltaLink, round.id, now(), round.collection);
    });
    tx();
    console.log(`[engine] 集合 ${round.collection} 轮次 #${round.id}（${round.kind}）完成，新同步起点已保存`);
  }

  // 完整收齐隔离区后才切换：diff 出生效表中缺失的键并标记删除
  #swapStaging(round, deltaLink) {
    const collection = round.collection;
    const staged = this.stmts.stagingKeys.all(round.id, collection);
    const stagedKeys = new Set(staged.map((r) => r.entity_key));

    let added = 0;
    let updated = 0;
    for (const row of staged) {
      const item = JSON.parse(row.data_json);
      const existing = this.stmts.getEntity.get(collection, row.entity_key);
      const status = collection === 'addresses' && !this.stmts.liveCustomer.get(item.CustomerId)
        ? 'orphan' : 'active';
      const orphanReason = status === 'orphan'
        ? `引用的客户 #${item.CustomerId} 不存在，已暂存等待客户到达` : null;
      this.stmts.upsertEntity.run(collection, row.entity_key, row.data_json, status, orphanReason,
        row.source_seq, existing ? existing.first_round_id : round.id, round.id, now());
      this.stmts.insertProv.run(collection, row.entity_key, round.id, round.pages_fetched + 1,
        !existing ? (status === 'orphan' ? 'orphan_staged' : 'created') : 'updated',
        row.source_seq, '隔离区全量重建切换', now());
      if (!existing) added += 1; else updated += 1;
    }

    // 只有拿到完整全量结果后，才允许推断删除
    let deleted = 0;
    for (const row of this.stmts.liveKeys.all(collection)) {
      if (!stagedKeys.has(row.entity_key)) {
        this.stmts.tombstone.run(round.id, now(), collection, row.entity_key);
        this.stmts.insertProv.run(collection, row.entity_key, round.id, round.pages_fetched + 1,
          'deleted', null, '完整全量结果中缺失，推断为删除', now());
        deleted += 1;
      }
    }

    // 客户集合整体换过后，重新评估全部地址的孤儿状态
    if (collection === 'addresses') this.#reevaluateOrphans(round);

    this.stmts.clearStaging.run(round.id);
    this.db.prepare(
      `UPDATE sync_rounds SET items_added = items_added + ?, items_updated = items_updated + ?,
         items_deleted = items_deleted + ? WHERE id = ?`
    ).run(added, updated, deleted, round.id);
  }

  #reevaluateOrphans(round) {
    for (const row of this.stmts.allAddresses.all()) {
      const data = JSON.parse(row.data_json);
      const customerExists = !!this.stmts.liveCustomer.get(data.CustomerId);
      const current = this.stmts.getEntity.get('addresses', row.entity_key);
      if (customerExists && current.status === 'orphan') {
        this.stmts.adoptAddress.run(round.id, now(), row.entity_key);
        this.stmts.insertProv.run('addresses', row.entity_key, round.id, round.pages_fetched + 1,
          'orphan_adopted', null, '重建切换后客户存在，恢复为有效', now());
      } else if (!customerExists && current.status === 'active') {
        this.db.prepare(
          `UPDATE entities SET status = 'orphan', orphan_reason = ?, last_round_id = ?, updated_at = ?
           WHERE collection = 'addresses' AND entity_key = ?`
        ).run(`引用的客户 #${data.CustomerId} 不存在，已暂存等待客户到达`, round.id, now(), row.entity_key);
        this.stmts.insertProv.run('addresses', row.entity_key, round.id, round.pages_fetched + 1,
          'orphan_staged', null, '重建切换后客户缺失，转为暂存', now());
      }
    }
  }

  // ---------- 网络 ----------

  async #fetchWithRetry(url, isCancelled = () => false) {
    let attempt = 0;
    let lastErr;
    while (attempt <= MAX_FETCH_RETRIES) {
      if (isCancelled()) {
        const e = new Error('已取消');
        e.code = 'Cancelled';
        throw e;
      }
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        clearTimeout(timer);
        const body = await res.json().catch(() => ({}));
        // 410 游标过期是确定性结论，不重试
        if (res.status === 410) return { status: 410, body };
        if (res.status >= 500) {
          lastErr = new Error(body?.error?.message || `HTTP ${res.status}`);
          lastErr.code = body?.error?.code || `HTTP_${res.status}`;
        } else {
          return { status: res.status, body };
        }
      } catch (err) {
        lastErr = err;
        lastErr.code = err.name === 'AbortError' ? 'Timeout' : 'NetworkError';
      }
      attempt += 1;
      if (attempt <= MAX_FETCH_RETRIES) {
        // 退避期间也响应取消：每 100ms 检查一次，最多等完退避窗口
        const waitMs = 400 * 2 ** (attempt - 1);
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          if (isCancelled()) {
            const e = new Error('已取消');
            e.code = 'Cancelled';
            throw e;
          }
          await sleep(100);
        }
      }
    }
    throw lastErr;
  }

  #fallbackPageId(body) {
    return `x${Buffer.from(JSON.stringify(body.value)).toString('base64url').slice(0, 24)}`;
  }
}
