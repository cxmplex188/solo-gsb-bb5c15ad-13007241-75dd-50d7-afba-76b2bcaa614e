'use strict';

/*
 * 慢网络状态倒退回归测试（前端，无第三方依赖）：
 * 把 public/app.js 放进 vm 上下文，配最小 DOM 桩与可挂起的 fetch，
 * 人工控制「读取 / 写入」响应的返回顺序，验证完整家谱响应按服务端
 * version 单调发布——过期读取或写入响应都不能覆盖较新版本，
 * 且较新版本到来时批量预检、合并预览、恢复预览仍按原规则失效。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/* ---------------- 最小 DOM 桩 ---------------- */

function createTextNodeStub(text) {
  return { _text: true, textContent: text };
}

function textOf(node) {
  if (!node) return '';
  if (node._text) return node.textContent;
  return (node.children || []).map(textOf).join('');
}

function createElementStub(tag, ids) {
  const el = {
    tagName: tag,
    children: [],
    listeners: {},
    attrs: {},
    value: '',
    hidden: false,
    disabled: false,
    className: '',
    dataset: {},
    files: null,
    clientWidth: 800,
    clientHeight: 520,

    appendChild(child) { this.children.push(child); return child; },
    prepend(child) { this.children.unshift(child); return child; },
    replaceChildren(...kids) {
      this.children = kids.flat().filter((k) => k !== null && k !== undefined);
    },
    remove() {},
    setAttribute(key, value) {
      this.attrs[key] = String(value);
      if (key === 'value') this.value = String(value);
    },
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of this.listeners[type] || []) fn.call(this, event || {});
    },
    querySelector(selector) {
      const cls = selector.replace(/^\./, '');
      const walk = (node) => {
        for (const child of node.children || []) {
          if (!child._text && (child.className || '').split(/\s+/).includes(cls)) return child;
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
    scrollIntoView() {},
    focus() {},
    select() {},
  };
  el.classList = {
    add(c) {
      if (!el.classList.contains(c)) el.className = `${el.className} ${c}`.trim();
    },
    remove(c) {
      el.className = el.className.split(/\s+/).filter((x) => x && x !== c).join(' ');
    },
    contains(c) {
      return el.className.split(/\s+/).includes(c);
    },
    toggle() {},
  };
  Object.defineProperty(el, 'textContent', {
    get() { return textOf(el); },
    set(t) { el.children = [createTextNodeStub(String(t))]; },
  });
  return el;
}

function createDom() {
  const ids = {};
  const documentStub = {
    getElementById(id) {
      if (!ids[id]) ids[id] = createElementStub('div', ids);
      return ids[id];
    },
    createElement(tag) { return createElementStub(tag, ids); },
    createElementNS(_ns, tag) { return createElementStub(tag, ids); },
    createTextNode(text) { return createTextNodeStub(text); },
    createDocumentFragment() { return createElementStub('#fragment', ids); },
  };
  return { ids, documentStub };
}

/* ---------------- 可挂起的 fetch 桩 ---------------- */

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

function createFetchHarness() {
  const pending = [];
  const fetchStub = (url, opts) => {
    const u = String(url);
    // 纪念日清单：立即返回空列表（并参与前端自身的乱序保护，测试中不影响判定）
    if (u.includes('/api/anniversaries/')) {
      return Promise.resolve(jsonResponse(200, { from: '2026-09-26', days: 30, items: [] }));
    }
    return new Promise((resolve, reject) => {
      pending.push({ url: u, opts: opts || {}, resolve, reject });
    });
  };
  const matching = (urlPart) => pending.filter((p) => p.url.includes(urlPart));
  return {
    fetchStub,
    pending,
    settle(urlPart, nth, status, body) {
      const list = matching(urlPart);
      assert.ok(list[nth], `未找到第 ${nth} 个挂起请求 ${urlPart}（共 ${list.length} 个）`);
      const p = list[nth];
      pending.splice(pending.indexOf(p), 1);
      p.resolve(jsonResponse(status, body));
    },
  };
}

/* ---------------- 装载页面 ---------------- */

function statePayload(version, members, edges = [], undo = null) {
  return { version, maxMembers: 30, members, edges, undo };
}

const member = (id, name) => ({ id, name });
const seedUndo = { label: '旧操作', time: '2026-09-25T10:00:00.000Z', version: 0 };

async function loadApp({ initialState } = {}) {
  const { ids, documentStub } = createDom();
  const harness = createFetchHarness();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    document: documentStub,
    fetch: harness.fetchStub,
    confirm: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(APP_SOURCE, sandbox, { filename: 'app.js' });

  const flush = async (rounds = 6) => {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  // 强制按 id 取（必要时惰性创建）控件，供测试在页面事件处理器查询前预设 value
  const el = (id) => documentStub.getElementById(id);
  const click = (id) => ids[id].dispatch('click', { preventDefault() {} });
  const submit = (id) => ids[id].dispatch('submit', { preventDefault() {} });
  const text = (id) => textOf(ids[id]);

  if (initialState !== undefined) {
    harness.settle('/api/state', 0, 200, initialState);
    await flush();
  }
  return { ids, harness, flush, el, click, submit, text };
}

/* ---------------- 测试 ---------------- */

test('慢网络：旧读取先发出、写入先成功、旧读取最后返回，页面不回退', async () => {
  // 启动时的 /api/state 读取故意挂起（旧读取先发出）
  const page = await loadApp();
  const { ids, harness, flush, el, submit, text } = page;

  // 期间用户成功添加成员（写入响应先返回，版本推进到 1）
  el('member-name').value = '甲';
  submit('member-form');
  await flush(2);
  harness.settle('/api/members', 0, 201, statePayload(
    1, [member('a', '甲')], [], { label: '添加成员「甲」', time: '2026-09-26T09:00:00.000Z', version: 0 },
  ));
  await flush();
  assert.strictEqual(text('member-count'), '1/30');
  assert.ok(text('member-list').includes('甲'));
  assert.ok(text('undo-info').includes('添加成员「甲」'));

  // 旧读取最后才返回版本 0 的空家谱：必须被丢弃，页面保持版本 1
  harness.settle('/api/state', 0, 200, statePayload(0, [], [], null));
  await flush();
  assert.strictEqual(text('member-count'), '1/30', '成员计数被旧读取回退');
  assert.ok(text('member-list').includes('甲'), '成员列表被旧读取回退');
  assert.ok(!text('member-list').includes('尚未添加成员'), '旧读取的空状态不应上屏');
  assert.ok(text('undo-info').includes('添加成员「甲」'), '撤销入口被旧读取回退');
  assert.ok(text('edge-list').includes('尚未建立关系'), '列表应仍渲染版本 1 的空关系');
});

test('慢网络：两个写入乱序返回，过期的写入响应不能覆盖较新版本', async () => {
  const page = await loadApp({ initialState: statePayload(0, [], [], null) });
  const { ids, harness, flush, el, submit, text } = page;

  el('member-name').value = '甲';
  submit('member-form');
  await flush(2);
  el('member-name').value = '乙';
  submit('member-form');
  await flush(2);

  // 后发出的写入（版本 2）先返回
  harness.settle('/api/members', 1, 201, statePayload(
    2, [member('a', '甲'), member('b', '乙')], [],
    { label: '添加成员「乙」', time: '2026-09-26T09:01:00.000Z', version: 1 },
  ));
  await flush();
  // 先发出的写入（版本 1）后返回：必须丢弃
  harness.settle('/api/members', 0, 201, statePayload(
    1, [member('a', '甲')], [],
    { label: '添加成员「甲」', time: '2026-09-26T09:00:00.000Z', version: 0 },
  ));
  await flush();

  assert.ok(text('member-list').includes('甲') && text('member-list').includes('乙'), '成员列表回退');
  assert.strictEqual(text('member-count'), '2/30');
  assert.ok(text('undo-info').includes('添加成员「乙」'), '撤销入口必须显示版本 2 的最近操作');
  assert.ok(!text('undo-info').includes('添加成员「甲」'), '撤销入口被过期写入响应回退');
});

test('较新版本到来使批量预检失效；同版本迟到响应不使预检失效', async () => {
  const seed = statePayload(1, [member('a', '甲'), member('b', '乙')], [], seedUndo);

  // —— 场景一：预检基于版本 1，随后发布版本 2 ——
  {
    const page = await loadApp({ initialState: seed });
    const { ids, harness, flush, click, submit, text } = page;

    ids['edge-parent'].value = 'a';
    ids['edge-child'].value = 'b';
    click('draft-add');
    click('batch-preview');
    await flush(2);
    harness.settle('/api/edges/batch/preview', 0, 200, {
      version: 1,
      valid: true,
      error: null,
      items: [{ index: 0, parentId: 'a', childId: 'b', parentName: '甲', childName: '乙', errors: [] }],
    });
    await flush();
    assert.ok(text('batch-status').includes('预检通过'));
    assert.strictEqual(ids['batch-submit'].disabled, false);

    // 撤销 409（其他标签页已推进版本）→ 自动刷新拿到版本 2
    click('undo-button');
    await flush(2);
    harness.settle('/api/undo', 0, 409, { error: '版本不符', currentVersion: 2 });
    await flush();
    harness.settle('/api/state', 0, 200, statePayload(
      2, [member('a', '甲'), member('b', '乙'), member('c', '丙')], [],
      { label: '添加成员「丙」', time: '2026-09-26T09:05:00.000Z', version: 1 },
    ));
    await flush();
    assert.ok(text('batch-status').includes('家谱已变化，请重新预检'), '新版本未使批量预检失效');
    assert.strictEqual(ids['batch-submit'].disabled, true, '预检失效后仍可提交');
    assert.ok(text('member-list').includes('丙'), '列表应显示版本 2 数据');
  }

  // —— 场景二：迟到的同版本读取不应误使预检失效（同版本快照不可变） ——
  {
    const page = await loadApp({ initialState: seed });
    const { ids, harness, flush, click, text } = page;

    ids['edge-parent'].value = 'a';
    ids['edge-child'].value = 'b';
    click('draft-add');
    click('batch-preview');
    await flush(2);
    harness.settle('/api/edges/batch/preview', 0, 200, {
      version: 1,
      valid: true,
      error: null,
      items: [{ index: 0, parentId: 'a', childId: 'b', parentName: '甲', childName: '乙', errors: [] }],
    });
    await flush();

    click('undo-button');
    await flush(2);
    harness.settle('/api/undo', 0, 409, { error: '版本不符', currentVersion: 1 });
    await flush();
    harness.settle('/api/state', 0, 200, seed); // 同版本重复读取
    await flush();
    assert.ok(text('batch-status').includes('预检通过'), '同版本响应不应使预检失效');
    assert.strictEqual(ids['batch-submit'].disabled, false);
  }
});

test('较新版本到来使合并预览与恢复预览按原规则失效', async () => {
  const seed = statePayload(
    1, [member('a', '甲'), member('b', '乙'), member('c', '丙')], [], seedUndo,
  );
  const newer = statePayload(
    2, [member('a', '甲'), member('b', '乙'), member('c', '丙'), member('d', '丁')], [],
    { label: '添加成员「丁」', time: '2026-09-26T09:06:00.000Z', version: 1 },
  );

  // —— 合并预览 ——
  {
    const page = await loadApp({ initialState: seed });
    const { ids, harness, flush, click, text } = page;

    ids['merge-keep'].value = 'a';
    ids['merge-remove'].value = 'b';
    click('merge-preview');
    await flush(2);
    harness.settle('/api/members/merge/preview', 0, 200, {
      version: 1,
      valid: true,
      error: null,
      keepId: 'a', keepName: '甲', mergeId: 'b', mergeName: '乙',
      originalEdgeCount: 0, affectedEdgeCount: 0, removedDuplicateCount: 0,
      edges: [], conflicts: [],
    });
    await flush();
    assert.ok(text('merge-status').includes('预览通过'));
    assert.strictEqual(ids['merge-submit'].disabled, false);

    click('undo-button');
    await flush(2);
    harness.settle('/api/undo', 0, 409, { error: '版本不符', currentVersion: 2 });
    await flush();
    harness.settle('/api/state', 0, 200, newer);
    await flush();
    assert.ok(text('merge-status').includes('家谱已变化，请重新预览合并'), '新版本未使合并预览失效');
    assert.strictEqual(ids['merge-submit'].disabled, true);
  }

  // —— 恢复预览 ——
  {
    const page = await loadApp({ initialState: seed });
    const { ids, harness, flush, click, text } = page;

    ids['restore-file'].files = [{ name: 'backup.json', text: async () => '{}' }];
    click('restore-preview');
    await flush(2);
    harness.settle('/api/backup/restore/preview', 0, 200, {
      version: 1,
      valid: true,
      error: null,
      errors: [],
      memberCount: 3,
      edgeCount: 0,
      memberNames: ['甲', '乙', '丙'],
      fingerprint: 'fp-1',
    });
    await flush();
    assert.ok(text('restore-status').includes('预览通过'));
    assert.strictEqual(ids['restore-submit'].disabled, false);

    click('undo-button');
    await flush(2);
    harness.settle('/api/undo', 0, 409, { error: '版本不符', currentVersion: 2 });
    await flush();
    harness.settle('/api/state', 0, 200, newer);
    await flush();
    assert.ok(
      text('restore-status').includes('家谱已发生写入，以下恢复预览基于旧版本，请重新预览'),
      '新版本未使恢复预览失效',
    );
    assert.strictEqual(ids['restore-submit'].disabled, true);
  }
});
