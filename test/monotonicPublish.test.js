'use strict';

/**
 * 前端单调发布回归测试（慢网络下家谱页面状态倒退）。
 *
 * 在带最小 DOM 桩的 vm 上下文中加载 public/app.js，用可编程的 fetch 桩
 * 模拟「旧读取先发出、写入已成功、旧读取最后返回」等乱序时序，验证：
 * - 完整家谱响应按服务端 version 单调发布：过期读取/写入响应不覆盖较新版本；
 * - 成员、关系与最近撤销信息（undo）始终来自同一版本（列表与撤销入口一致）；
 * - 较新版本到来时，批量预检 / 合并预览 / 恢复预览仍按原规则失效；
 * - 同版本响应幂等，不触发失效逻辑。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/** 最小 DOM 元素桩：覆盖 app.js 用到的全部 DOM API */
function makeElement() {
  return {
    children: [],
    dataset: {},
    style: {},
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    appendChild(child) { this.children.push(child); return child; },
    append(...cs) { this.children.push(...cs); },
    replaceChildren(...cs) { this.children = cs; },
    prepend(c) { this.children.unshift(c); },
    remove() {},
    addEventListener() {},
    querySelector: () => null,
    scrollIntoView() {},
    focus() {},
    select() {},
    click() {},
    setPointerCapture() {},
    getBoundingClientRect: () => ({ width: 800, height: 520, left: 0, top: 0 }),
  };
}

function makeDocument() {
  const byId = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement());
      return byId.get(id);
    },
    createElement: () => makeElement(),
    createElementNS: () => makeElement(),
    createTextNode: (text) => ({ text }),
    createDocumentFragment: () => makeElement(),
    body: makeElement(),
  };
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => JSON.parse(JSON.stringify(body)),
});

/**
 * 可编程的「服务端 + 网络」：
 * - 数据模型只支持本测试需要的接口（GET /api/state、POST /api/members、纪念日清单）；
 * - 响应体在请求到达服务端时即快照（代表其版本的数据），
 *   「网络返回」可被挂起，从而精确模拟慢网络下响应乱序到达。
 */
function makeHarness() {
  const server = {
    version: 0,
    members: [],
    edges: [],
    undo: null,
    list() {
      return {
        version: this.version,
        maxMembers: 30,
        members: this.members.map((m) => ({ ...m })),
        edges: this.edges.map((e) => ({ ...e })),
        undo: this.undo ? { ...this.undo } : null,
      };
    },
    addMember(name) {
      this.version += 1;
      const member = { id: `m${this.version}`, name, birthday: null, deathday: null };
      this.members.push(member);
      this.undo = {
        label: `添加成员「${name}」`,
        time: new Date().toISOString(),
        version: this.version - 1,
      };
      return this.list();
    },
  };

  const net = {
    holdReads: false, // 挂起 GET /api/state 的「响应返回」
    heldReads: [],
    holdWrites: false, // 挂起 POST /api/members 的「响应返回」
    heldWrites: [],
    releaseReads() {
      this.holdReads = false;
      this.heldReads.splice(0).forEach((resolve) => resolve());
    },
    releaseWrites() {
      this.holdWrites = false;
      this.heldWrites.splice(0).forEach((resolve) => resolve());
    },
  };

  async function fetchStub(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const u = String(url);
    if (u === '/api/state' && method === 'GET') {
      const body = server.list(); // 到达服务端时的版本快照
      if (net.holdReads) await new Promise((resolve) => net.heldReads.push(resolve));
      return jsonResponse(body);
    }
    if (u === '/api/members' && method === 'POST') {
      const { name } = JSON.parse(options.body);
      const body = server.addMember(name); // 写入即时生效，响应体为该版本快照
      if (net.holdWrites) await new Promise((resolve) => net.heldWrites.push(resolve));
      return jsonResponse(body, 201);
    }
    if (u.startsWith('/api/anniversaries/upcoming')) {
      return jsonResponse({ from: '2026-09-26', days: 30, items: [] });
    }
    throw new Error(`测试未桩接的请求: ${method} ${u}`);
  }

  const ctx = vm.createContext({
    document: makeDocument(),
    fetch: fetchStub,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    console,
  });
  vm.runInContext(APP_JS, ctx, { filename: 'public/app.js' });

  const flush = async (rounds = 10) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
  };
  const run = (code) => vm.runInContext(code, ctx);
  const addMember = (name) =>
    run(`api('/api/members', { method: 'POST', body: ${JSON.stringify(JSON.stringify({ name }))} })` +
      '.then((d) => applyStateAndRender(d))');

  return { server, net, ctx, run, flush, addMember };
}

test('初始加载：空谱版本 0 正常发布', async () => {
  const h = makeHarness();
  await h.flush();
  assert.equal(h.run('state.version'), 0);
  assert.deepEqual(h.run('state.members'), []);
  assert.equal(h.run('state.undo'), null);
});

test('旧读取先发出、写入成功、旧读取最后返回：页面不回退到旧版本', async () => {
  const h = makeHarness();
  await h.flush(); // 初始 refresh 完成（version 0）

  // 慢读取：先发出 GET /api/state（服务端快照 version 0），响应被挂起
  h.net.holdReads = true;
  const slowRefresh = h.run('refresh()');
  await h.flush(2);

  // 随后写入成功：响应先返回并发布（version 1）
  await h.addMember('张三');
  assert.equal(h.run('state.version'), 1);

  // 旧读取最后返回（version 0 快照）：必须被整体丢弃
  h.net.releaseReads();
  await slowRefresh;
  await h.flush();

  assert.equal(h.run('state.version'), 1);
  assert.deepEqual(h.run('state.members.map((m) => m.name)'), ['张三']);
  // 列表与撤销入口显示同一版本的数据：undo 不得被旧响应的 null 覆盖
  assert.equal(h.run('state.undo && state.undo.label'), '添加成员「张三」');
});

test('过期写入响应不覆盖较新版本（两个并发写入乱序返回）', async () => {
  const h = makeHarness();
  await h.flush();

  // 写入「甲」先到达服务端（version 1），但响应被挂起
  h.net.holdWrites = true;
  const slowWrite = h.addMember('甲');
  await h.flush(2);
  assert.equal(h.server.version, 1);

  // 写入「乙」后到达（version 2），响应先返回并发布
  h.net.holdWrites = false;
  await h.addMember('乙');
  assert.equal(h.run('state.version'), 2);

  // 「甲」的响应（version 1 快照）最后返回：必须被丢弃
  h.net.releaseWrites();
  await slowWrite;
  await h.flush();

  assert.equal(h.run('state.version'), 2);
  assert.deepEqual(h.run('state.members.map((m) => m.name).sort()'), ['乙', '甲'].sort());
  assert.equal(h.run('state.undo && state.undo.label'), '添加成员「乙」');
});

test('较新版本到来时：批量预检、合并预览、恢复预览按原规则失效', async () => {
  const h = makeHarness();
  await h.flush();
  await h.addMember('张三'); // version 1

  // 构造三类「基于当前版本」的预览/预检结果
  h.run(`
    preview = { version: state.version, valid: true, byKey: new Map(), keys: [] };
    previewStale = false;
    mergePreview = { version: state.version, keepId: 'a', mergeId: 'b', valid: true };
    mergeStale = false;
    restorePreview = { version: state.version, valid: true, fingerprint: 'f', content: '{}' };
    restoreStale = false;
  `);

  await h.addMember('李四'); // version 2：较新版本发布

  assert.equal(h.run('state.version'), 2);
  assert.equal(h.run('preview'), null);
  assert.equal(h.run('previewStale'), true);
  assert.equal(h.run('mergePreview'), null);
  assert.equal(h.run('mergeStale'), true);
  assert.equal(h.run('restorePreview'), null);
  assert.equal(h.run('restoreStale'), true);
});

test('同版本读取幂等：不触发预览失效', async () => {
  const h = makeHarness();
  await h.flush();
  await h.addMember('张三'); // version 1

  h.run(`
    preview = { version: state.version, valid: true, byKey: new Map(), keys: [] };
    previewStale = false;
  `);
  await h.run('refresh()'); // 同版本（version 1）读取
  await h.flush();

  assert.equal(h.run('state.version'), 1);
  assert.notEqual(h.run('preview'), null);
  assert.equal(h.run('previewStale'), false);
});

test('非法响应（无版本号）被丢弃，现有状态不受影响', async () => {
  const h = makeHarness();
  await h.flush();
  await h.addMember('张三'); // version 1

  assert.equal(h.run('publishState(null)'), false);
  assert.equal(h.run('publishState({})'), false);
  assert.equal(h.run('publishState({ version: "1", members: [] })'), false);
  assert.equal(h.run('state.version'), 1);
  assert.deepEqual(h.run('state.members.map((m) => m.name)'), ['张三']);
});
