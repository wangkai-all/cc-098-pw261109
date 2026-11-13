// In-memory OData-like dataset with an append-only mutation log per collection.
// Pagination tokens are base64url JSON describing (epoch, kind, position, pageCount).

const COLLECTIONS = ['customers', 'addresses'];

function b64encode(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function b64decode(str) {
  return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
}

function seed() {
  const customers = new Map([
    [1, { Id: 1, Name: '南京晨光科技', Email: 'contact@chenguang.example', Revision: 1 }],
    [2, { Id: 2, Name: '上海远海贸易', Email: 'sales@yuanhai.example', Revision: 1 }],
    [3, { Id: 3, Name: '北京星河软件', Email: 'hi@xinghe.example', Revision: 1 }],
    [4, { Id: 4, Name: '深圳南风电子', Email: 'info@nanfeng.example', Revision: 1 }],
    [5, { Id: 5, Name: '杭州青禾传媒', Email: 'hello@qinghe.example', Revision: 1 }],
  ]);
  const addresses = new Map([
    [1, { Id: 1, CustomerId: 1, City: '南京', Street: '中山路 10 号', Revision: 1 }],
    [2, { Id: 2, CustomerId: 1, City: '南京', Street: '珠江路 22 号', Revision: 1 }],
    [3, { Id: 3, CustomerId: 2, City: '上海', Street: '世纪大道 100 号', Revision: 1 }],
    [4, { Id: 4, CustomerId: 2, City: '上海', Street: '南京西路 88 号', Revision: 1 }],
    [5, { Id: 5, CustomerId: 3, City: '北京', Street: '中关村大街 1 号', Revision: 1 }],
    [6, { Id: 6, CustomerId: 4, City: '深圳', Street: '深南大道 500 号', Revision: 1 }],
    [7, { Id: 7, CustomerId: 5, City: '杭州', Street: '文三路 66 号', Revision: 1 }],
    // 孤儿地址：引用一个当前不存在的客户，用来演示暂存
    [8, { Id: 8, CustomerId: 99, City: '未知城市', Street: '待匹配地址 9 号', Revision: 1 }],
  ]);
  return { customers, addresses };
}

class SampleStore {
  constructor() {
    this.PAGE_SIZE = 3;
    this.reset();
  }

  reset() {
    const data = seed();
    this.data = data;
    this.epoch = 1;
    this.headSeq = { customers: 0, addresses: 0 };
    this.logs = { customers: [], addresses: [] };
    // 故障注入：failAt = 在第几页失败一次；failAtRepeat = 持续失败（耗尽重试，模拟硬中断）
    // dupAt = 第几页重复上一页一次
    this.faults = {
      customers: { failAt: null, failAtRepeat: null, dupAt: null },
      addresses: { failAt: null, failAtRepeat: null, dupAt: null },
    };
    // 分页游标 -> 逻辑页序号：同一游标（含重放）拿到稳定的 pageId
    this.pageSeq = { customers: new Map(), addresses: new Map() };
    this.pageCounter = { customers: 0, addresses: 0 };
    this.lastKind = { customers: null, addresses: null };
    // 上一次响应，用于构造“重复页”
    this.lastResponse = { customers: null, addresses: null };
  }

  setFault(collection, type, page) {
    if (!COLLECTIONS.includes(collection)) throw new Error('unknown collection');
    if (type === 'failPage') this.faults[collection].failAt = page;
    else if (type === 'failPageRepeat') this.faults[collection].failAtRepeat = page;
    else if (type === 'dupPage') this.faults[collection].dupAt = page;
    else throw new Error('unknown fault type');
  }

  clearFaults() {
    for (const c of COLLECTIONS) {
      this.faults[c] = { failAt: null, failAtRepeat: null, dupAt: null };
    }
  }

  // 向日志补一条针对已删除记录的删除事件，验证重复删除的幂等性
  injectDelete(collection, key) {
    this.headSeq[collection] += 1;
    this.logs[collection].push({ seq: this.headSeq[collection], op: 'delete', key, entity: null });
    return { seq: this.headSeq[collection] };
  }

  // 直接向变更日志注入一条“过时”的 upsert。
  // 序号推进到 head+1 保证它会被增量轮次发出，但实体内容标记为旧版本，
  // 客户端的墓碑守卫/序号守卫必须拒绝它（不能让已删除记录复活）。
  injectStaleUpsert(collection, entity) {
    this.headSeq[collection] += 1;
    const seq = this.headSeq[collection];
    this.logs[collection].push({
      seq,
      op: 'upsert',
      key: entity.Id,
      entity: { ...entity },
    });
    return { injectedSeq: seq, headSeq: this.headSeq[collection] };
  }

  // 使所有游标（deltaLink / skiptoken）失效
  expireTokens() {
    this.epoch += 1;
  }

  #append(collection, op, key, entity) {
    this.headSeq[collection] += 1;
    const entry = { seq: this.headSeq[collection], op, key, entity: entity ? { ...entity } : null };
    this.logs[collection].push(entry);
    return entry;
  }

  createCustomer(body) {
    const id = body.Id ?? this.#nextId(this.data.customers);
    if (this.data.customers.has(id)) throw Object.assign(new Error('id exists'), { status: 409 });
    const entity = { Id: id, Name: body.Name ?? `客户 ${id}`, Email: body.Email ?? '', Revision: 1 };
    this.data.customers.set(id, entity);
    this.#append('customers', 'upsert', id, entity);
    return { ...entity };
  }

  updateCustomer(id, body) {
    const entity = this.data.customers.get(id);
    if (!entity) throw Object.assign(new Error('not found'), { status: 404 });
    if (body.Name !== undefined) entity.Name = body.Name;
    if (body.Email !== undefined) entity.Email = body.Email;
    entity.Revision += 1;
    this.#append('customers', 'upsert', id, entity);
    return { ...entity };
  }

  deleteCustomer(id) {
    const entity = this.data.customers.get(id);
    if (!entity) throw Object.assign(new Error('not found'), { status: 404 });
    this.data.customers.delete(id);
    this.#append('customers', 'delete', id, null);
    return { Id: id };
  }

  createAddress(body) {
    const id = body.Id ?? this.#nextId(this.data.addresses);
    if (this.data.addresses.has(id)) throw Object.assign(new Error('id exists'), { status: 409 });
    const entity = {
      Id: id,
      CustomerId: body.CustomerId ?? 0,
      City: body.City ?? '',
      Street: body.Street ?? '',
      Revision: 1,
    };
    this.data.addresses.set(id, entity);
    this.#append('addresses', 'upsert', id, entity);
    return { ...entity };
  }

  updateAddress(id, body) {
    const entity = this.data.addresses.get(id);
    if (!entity) throw Object.assign(new Error('not found'), { status: 404 });
    if (body.CustomerId !== undefined) entity.CustomerId = body.CustomerId;
    if (body.City !== undefined) entity.City = body.City;
    if (body.Street !== undefined) entity.Street = body.Street;
    entity.Revision += 1;
    this.#append('addresses', 'upsert', id, entity);
    return { ...entity };
  }

  deleteAddress(id) {
    const entity = this.data.addresses.get(id);
    if (!entity) throw Object.assign(new Error('not found'), { status: 404 });
    this.data.addresses.delete(id);
    this.#append('addresses', 'delete', id, null);
    return { Id: id };
  }

  #nextId(map) {
    let max = 0;
    for (const k of map.keys()) if (k > max) max = k;
    return max + 1;
  }

  // 构造一个分页/增量游标
  makeToken(collection, kind, position, pageCount) {
    return b64encode({ ep: this.epoch, col: collection, kind, pos: position, pc: pageCount });
  }

  // 解析游标；epoch 不匹配则抛出“游标过期”
  parseToken(token) {
    const payload = b64decode(token);
    if (payload.ep !== this.epoch) {
      throw Object.assign(new Error('delta token expired'), {
        status: 410,
        code: 'DeltaTokenExpired',
      });
    }
    return payload;
  }

  /**
   * 处理一次 OData 请求。
   * @param collection customers | addresses
   * @param skiptoken 上一页 nextLink 携带的分页游标
   * @param deltatoken deltaLink 携带的增量游标
   * @returns {{status:number, body:object}}
   */
  serve(collection, { skiptoken, deltatoken }) {
    if (!COLLECTIONS.includes(collection)) {
      return { status: 404, body: { error: { code: 'NotFound', message: 'collection not found' } } };
    }

    let payload;
    try {
      if (skiptoken) payload = this.parseToken(skiptoken);
      else if (deltatoken) payload = this.parseToken(deltatoken);
      else payload = { ep: this.epoch, col: collection, kind: 'full', pos: 0, pc: 0 };
    } catch (err) {
      if (err.status === 410) {
        return {
          status: 410,
          body: { error: { code: 'DeltaTokenExpired', message: '同步游标已过期，请重新发起全量同步' } },
        };
      }
      throw err;
    }

    // 逻辑页身份：每个新轮次首页从 1 重新编号，使轮次内页码与故障配置对齐；
    // 同一游标的重试/重放拿到同一个 pageId。
    // 轮次边界判定：无游标入口，或游标 kind 与当前已编号轮次不同（full -> delta 切换），
    // 或游标内页计数 pc=0。
    const seqMap = this.pageSeq[collection];
    const isRoundHome = !skiptoken && !deltatoken
      || !payload.pc
      || this.lastKind[collection] !== payload.kind;
    const cursorKey = skiptoken || deltatoken
      || `home:${this.epoch}:${collection}:${payload.kind}:${payload.pos}`;
    let logicalPage;
    if (isRoundHome) {
      this.pageCounter[collection] = 0;
      seqMap.clear();
    }
    this.lastKind[collection] = payload.kind;
    if (seqMap.has(cursorKey)) {
      logicalPage = seqMap.get(cursorKey);
    } else {
      this.pageCounter[collection] += 1;
      logicalPage = this.pageCounter[collection];
      seqMap.set(cursorKey, logicalPage);
    }
    // 轮次内页码即逻辑页序号（首页为 1）
    const roundPage = logicalPage;
    const fault = this.faults[collection];

    // 分页中断：指定页返回一次 500（按轮次内页码匹配）
    if (fault.failAt !== null && roundPage === fault.failAt) {
      fault.failAt = null;
      return {
        status: 500,
        body: { error: { code: 'TransientFailure', message: `第 ${roundPage} 页模拟临时故障（分页中断）` } },
      };
    }

    // 持续故障：用于制造硬中断（客户端重试耗尽后落盘，等待重启恢复）
    if (fault.failAtRepeat !== null && roundPage >= fault.failAtRepeat) {
      return {
        status: 500,
        body: { error: { code: 'PersistentFailure', message: `第 ${roundPage} 页模拟持续故障` } },
      };
    }

    // 重复页：指定页先把“上一响应体”原样返回一次。
    // pageId 取当前请求对应逻辑页的 id（与随后真正响应该游标时一致），
    // 这样客户端轮次内台账能识别：同一 pageId 第一次是重放内容，第二次才是真实页。
    if (fault.dupAt !== null && roundPage === fault.dupAt && this.lastResponse[collection]) {
      fault.dupAt = null;
      const replay = JSON.parse(JSON.stringify(this.lastResponse[collection]));
      // 用当前逻辑页序号生成 pageId（内容仍沿用上一页），标记为重放
      replay['@meso.pageId'] = this.#pageIdFor(logicalPage, replay);
      replay['@meso.replayed'] = true;
      return { status: 200, body: replay };
    }

    const base = `/odata/${collection === 'customers' ? 'Customers' : 'Addresses'}`;
    let value;
    let nextToken;
    let deltaPosition; // 本轮结束时 deltaLink 对应的日志位置

    if (payload.kind === 'full') {
      const all = [...this.data[collection].values()].sort((a, b) => a.Id - b.Id);
      const off = payload.pos;
      value = all.slice(off, off + this.PAGE_SIZE).map((e) => ({ ...e }));
      const newOff = off + value.length;
      deltaPosition = this.headSeq[collection];
      if (newOff < all.length) {
        nextToken = this.makeToken(collection, 'full', newOff, roundPage);
      }
    } else {
      // delta：返回 seq > pos 的变更日志（日志中可能存在注入的乱序旧事件）
      const log = this.logs[collection];
      const fromSeq = payload.pos;
      const matched = log.filter((e) => e.seq > fromSeq);
      const slice = matched
        .slice(0, this.PAGE_SIZE)
        .map((e) => {
          if (e.op === 'delete') {
            const typeName = collection === 'customers' ? 'Customers' : 'Addresses';
            return {
              '@odata.id': `${typeName}(${e.key})`,
              '@odata.reason': 'deleted',
              '@meso.key': e.key,
              '@meso.seq': e.seq,
            };
          }
          return { ...e.entity, '@meso.seq': e.seq };
        });
      value = slice;
      // 按已消费事件中的最大序号推进，乱序旧事件不会卡住游标
      const consumed = matched.slice(0, this.PAGE_SIZE);
      const lastSeq = consumed.length ? Math.max(...consumed.map((e) => e.seq)) : fromSeq;
      if (lastSeq < this.headSeq[collection]) {
        nextToken = this.makeToken(collection, 'delta', lastSeq, roundPage);
      } else {
        deltaPosition = this.headSeq[collection];
      }
    }

    const body = {
      '@odata.context': `$metadata#${collection === 'customers' ? 'Customers' : 'Addresses'}`,
      value,
    };
    if (nextToken) {
      body['@odata.nextLink'] = `${base}?$skiptoken=${nextToken}`;
    } else {
      const dt = this.makeToken(collection, 'delta', deltaPosition, roundPage);
      body['@odata.deltaLink'] = `${base}?$deltatoken=${dt}`;
    }
    body['@meso.pageId'] = this.#pageIdFor(logicalPage, body);
    this.lastResponse[collection] = body;
    return { status: 200, body: JSON.parse(JSON.stringify(body)) };
  }

  #pageIdFor(logicalPage, _body) {
    // 仅由 epoch + 逻辑页序号决定：同一位置的重放页与真实页 id 相同，
    // 不同位置（不同游标）的页 id 必然不同。
    return `ep${this.epoch}-p${logicalPage}`;
  }

  snapshot() {
    return {
      epoch: this.epoch,
      headSeq: { ...this.headSeq },
      counts: {
        customers: this.data.customers.size,
        addresses: this.data.addresses.size,
      },
      faults: JSON.parse(JSON.stringify(this.faults)),
      logs: {
        customers: this.logs.customers.length,
        addresses: this.logs.addresses.length,
      },
    };
  }
}

export const store = new SampleStore();
export { COLLECTIONS };
