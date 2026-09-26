'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findCriticalLinks } = require('../server/criticalLinks');

/** 测试辅助：批量建成员；条目为 [id, name] 或字符串（id 与姓名相同） */
function makeState(entries) {
  const state = { maxMembers: 30, members: [], parentsOf: {} };
  for (const entry of entries) {
    const [id, name] = Array.isArray(entry) ? entry : [entry, entry];
    state.members.push({ id, name, birthday: null, deathday: null });
    state.parentsOf[id] = [];
  }
  return state;
}

function add(state, parent, child) {
  state.parentsOf[child].push(parent);
}

/** 按方向取一条桥梁，找不到则失败 */
function bridgeOf(result, parentId, childId) {
  const hit = result.bridges.find((b) => b.parentId === parentId && b.childId === childId);
  assert.ok(hit, `应存在桥梁 ${parentId}->${childId}`);
  return hit;
}

test('关键连接：空谱返回空状态', () => {
  const r = findCriticalLinks(makeState([]));
  assert.equal(r.empty, true);
  assert.equal(r.memberCount, 0);
  assert.equal(r.edgeCount, 0);
  assert.equal(r.componentCount, 0);
  assert.equal(r.bridgeCount, 0);
  assert.deepEqual(r.components, []);
  assert.deepEqual(r.bridges, []);
});

test('关键连接：成员都没有关系时各自成家族、无桥梁', () => {
  const r = findCriticalLinks(makeState(['甲', '乙', '丙']));
  assert.equal(r.empty, false);
  assert.equal(r.memberCount, 3);
  assert.equal(r.edgeCount, 0);
  assert.equal(r.componentCount, 3);
  assert.equal(r.bridgeCount, 0);
  assert.deepEqual(r.bridges, []);
  assert.deepEqual(
    r.components.map((c) => c.memberIds.length).sort(),
    [1, 1, 1],
  );
});

test('关键连接：唯一一条关系就是桥梁，两侧各 1 人', () => {
  const state = makeState(['父', '子']);
  add(state, '父', '子');
  const r = findCriticalLinks(state);
  assert.equal(r.componentCount, 1);
  assert.equal(r.bridgeCount, 1);
  const b = bridgeOf(r, '父', '子');
  assert.equal(b.componentIndex, 0);
  assert.equal(b.componentMemberCount, 2);
  assert.deepEqual(b.parentSide, ['父']);
  assert.deepEqual(b.childSide, ['子']);
});

test('关键连接：链式关系每条都是桥梁，两侧人数与名单正确', () => {
  const state = makeState(['祖', '父', '子', '孙']);
  add(state, '祖', '父');
  add(state, '父', '子');
  add(state, '子', '孙');
  const r = findCriticalLinks(state);
  assert.equal(r.componentCount, 1);
  assert.equal(r.bridgeCount, 3);

  const b1 = bridgeOf(r, '祖', '父');
  assert.deepEqual(b1.parentSide, ['祖']);
  assert.deepEqual([...b1.childSide].sort(), ['父', '子', '孙'].sort());

  const b2 = bridgeOf(r, '父', '子');
  assert.deepEqual([...b2.parentSide].sort(), ['祖', '父'].sort());
  assert.deepEqual([...b2.childSide].sort(), ['子', '孙'].sort());

  const b3 = bridgeOf(r, '子', '孙');
  assert.deepEqual([...b3.parentSide].sort(), ['祖', '父', '子'].sort());
  assert.deepEqual(b3.childSide, ['孙']);
});

test('关键连接：环形结构中每条关系都有其他路径，不应误报为桥梁', () => {
  const state = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');
  add(state, 'A', 'C');
  add(state, 'B', 'C'); // 无向看是三角形：移除任一条，剩余两条仍把三人连通
  const r = findCriticalLinks(state);
  assert.equal(r.componentCount, 1);
  assert.equal(r.edgeCount, 3);
  assert.equal(r.bridgeCount, 0);
  assert.deepEqual(r.bridges, []);
});

test('关键连接：钻石结构（父母双路径）无桥梁', () => {
  const state = makeState(['R', 'A', 'B', 'C']);
  add(state, 'R', 'A');
  add(state, 'R', 'B');
  add(state, 'A', 'C');
  add(state, 'B', 'C'); // C 经 A、B 两条路径连到 R：任一条边都有替代路径
  const r = findCriticalLinks(state);
  assert.equal(r.componentCount, 1);
  assert.equal(r.bridgeCount, 0);
});

test('关键连接：环上接出的链尾是桥梁，环内关系不是', () => {
  const state = makeState(['R', 'A', 'B', 'C', 'D']);
  add(state, 'R', 'A');
  add(state, 'R', 'B');
  add(state, 'A', 'C');
  add(state, 'B', 'C'); // 钻石环：R、A、B、C 两两有替代路径
  add(state, 'C', 'D'); // 链尾：D 仅靠这一条关系接入家族
  const r = findCriticalLinks(state);
  assert.equal(r.bridgeCount, 1);
  const b = bridgeOf(r, 'C', 'D');
  assert.equal(b.componentMemberCount, 5);
  assert.deepEqual([...b.parentSide].sort(), ['A', 'B', 'C', 'R'].sort());
  assert.deepEqual(b.childSide, ['D']);
});

test('关键连接：两个环相接的共用点不产生桥梁', () => {
  // 三角形 A-B-C 与三角形 C-D-E 共用成员 C：任何一条边都在环上，移除后仍连通
  const state = makeState(['A', 'B', 'C', 'D', 'E']);
  add(state, 'A', 'B');
  add(state, 'A', 'C');
  add(state, 'B', 'C');
  add(state, 'C', 'D');
  add(state, 'C', 'E');
  add(state, 'D', 'E');
  const r = findCriticalLinks(state);
  assert.equal(r.componentCount, 1);
  assert.equal(r.bridgeCount, 0);
});

test('关键连接：互不连通的家族分别计算', () => {
  const state = makeState(['甲', '乙', 'A', 'B', 'C', '孤']);
  add(state, '甲', '乙'); // 家族一：单链，1 条桥梁
  add(state, 'A', 'B');
  add(state, 'A', 'C');
  add(state, 'B', 'C'); // 家族二：环形，无桥梁
  // 「孤」无任何关系：单成员家族
  const r = findCriticalLinks(state);
  assert.equal(r.componentCount, 3);
  assert.equal(r.bridgeCount, 1);

  const b = bridgeOf(r, '甲', '乙');
  const comp = r.components[b.componentIndex];
  assert.deepEqual([...comp.memberIds].sort(), ['乙', '甲'].sort());
  assert.equal(comp.memberIds.length, 2);
  assert.equal(comp.bridgeCount, 1);
  assert.equal(b.componentMemberCount, 2);

  // 各分量桥梁数合计等于总数；每个分量都记录了成员名单
  assert.equal(
    r.components.reduce((acc, c) => acc + c.bridgeCount, 0),
    r.bridgeCount,
  );
  assert.equal(
    r.components.reduce((acc, c) => acc + c.memberIds.length, 0),
    r.memberCount,
  );
});

test('关键连接：断开后两侧成员名单按姓名、ID 排序', () => {
  const state = makeState([['p', 'P'], ['a', 'A'], ['b', 'B'], ['c', 'C']]);
  add(state, 'p', 'a');
  add(state, 'a', 'b');
  add(state, 'a', 'c'); // P—A—{B,C} 星形：三条都是桥梁
  const r = findCriticalLinks(state);
  assert.equal(r.bridgeCount, 3);
  const b = bridgeOf(r, 'p', 'a');
  assert.deepEqual(b.parentSide, ['p']);
  assert.deepEqual(b.childSide, ['a', 'b', 'c'], '子女一侧应按姓名 A、B、C 排序');
});

test('关键连接：计算确定（重复结果一致）且不修改家谱状态', () => {
  const state = makeState(['R', 'A', 'B', 'C', 'D']);
  add(state, 'R', 'A');
  add(state, 'R', 'B');
  add(state, 'A', 'C');
  add(state, 'B', 'C');
  add(state, 'C', 'D');
  const snapshot = JSON.parse(JSON.stringify(state));
  const r1 = findCriticalLinks(state);
  const r2 = findCriticalLinks(state);
  assert.deepEqual(r1, r2);
  assert.deepEqual(state, snapshot, '分析是纯函数，不得修改家谱');
});

test('HTTP：GET /api/critical-links 只读返回桥梁与两侧姓名，不写家谱', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'critical-links-http-'));
  process.env.DATA_FILE = path.join(dir, 'family.json');
  const app = require('../server/index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    // 空谱：返回空状态与明确标记
    let res = await fetch(`${base}/api/critical-links`);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.empty, true);
    assert.equal(body.version, 0);
    assert.equal(body.memberCount, 0);
    assert.equal(body.bridgeCount, 0);
    assert.deepEqual(body.bridges, []);

    // 录入三名成员与两条关系（星形：两条都是桥梁）
    const ids = {};
    for (const name of ['甲', '乙', '丙']) {
      res = await post('/api/members', { name });
      assert.equal(res.status, 201);
      const st = await res.json();
      ids[name] = st.members.find((m) => m.name === name).id;
    }
    res = await post('/api/edges', { parentId: ids['甲'], childId: ids['乙'] });
    assert.equal(res.status, 201);
    res = await post('/api/edges', { parentId: ids['甲'], childId: ids['丙'] });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/api/critical-links`);
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.empty, false);
    assert.equal(body.version, 5, '结果应标注所依据的家谱版本');
    assert.equal(body.memberCount, 3);
    assert.equal(body.edgeCount, 2);
    assert.equal(body.componentCount, 1);
    assert.equal(body.bridgeCount, 2);
    assert.deepEqual(body.components, [{ index: 0, memberCount: 3, bridgeCount: 2 }]);

    // 每条桥梁：两端姓名 + 断开后两侧的成员数与姓名名单
    const b = body.bridges.find((x) => x.childName === '乙');
    assert.ok(b, '应存在「甲 → 乙」这条关键连接');
    assert.equal(b.parentName, '甲');
    assert.equal(b.componentIndex, 0);
    assert.equal(b.componentMemberCount, 3);
    assert.equal(b.childSide.count, 1);
    assert.deepEqual(b.childSide.members.map((m) => m.name), ['乙']);
    assert.equal(b.parentSide.count, 2);
    assert.deepEqual(
      b.parentSide.members.map((m) => m.name).sort(),
      ['丙', '甲'].sort(),
    );
    assert.ok(b.parentSide.members.every((m) => typeof m.id === 'string' && m.id));

    // 只读：家谱版本不因查询而推进
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.version, 5);
    assert.equal(state.members.length, 3);
    assert.equal(state.edges.length, 2);

    // 补上「乙 → 丙」形成环形：每条关系都有替代路径，不再有桥梁
    res = await post('/api/edges', { parentId: ids['乙'], childId: ids['丙'] });
    assert.equal(res.status, 201);
    res = await fetch(`${base}/api/critical-links`);
    body = await res.json();
    assert.equal(body.version, 6, '重新计算应基于最新家谱版本');
    assert.equal(body.bridgeCount, 0);
    assert.deepEqual(body.bridges, []);
    assert.deepEqual(body.components, [{ index: 0, memberCount: 3, bridgeCount: 0 }]);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    delete process.env.DATA_FILE;
  }
});
