'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  layoutFamilyChart,
  GAP_X,
  GAP_COMPONENT,
  BAND_PAD,
} = require('../server/familyChart');

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

/** 按 id 取一个布局节点，找不到则失败 */
function nodeOf(result, id) {
  const hit = result.nodes.find((n) => n.id === id);
  assert.ok(hit, `布局中应包含节点 ${id}`);
  return hit;
}

test('整谱关系图：空谱返回空状态', () => {
  const r = layoutFamilyChart(makeState([]), 0);
  assert.equal(r.empty, true);
  assert.equal(r.memberCount, 0);
  assert.equal(r.edgeCount, 0);
  assert.equal(r.componentCount, 0);
  assert.equal(r.width, 0);
  assert.equal(r.height, 0);
  assert.equal(r.caption, null);
  assert.deepEqual(r.components, []);
  assert.deepEqual(r.nodes, []);
  assert.deepEqual(r.edges, []);
});

test('整谱关系图：单成员无关系时自成一个分量，节点落在画布内', () => {
  const r = layoutFamilyChart(makeState(['甲']), 3);
  assert.equal(r.empty, false);
  assert.equal(r.componentCount, 1);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.edges.length, 0);
  const n = r.nodes[0];
  assert.equal(n.id, '甲');
  assert.equal(n.name, '甲');
  assert.equal(n.layer, 0);
  assert.equal(n.component, 0);
  assert.ok(n.x - n.w / 2 >= 0 && n.x + n.w / 2 <= r.width, '节点横向应在画布内');
  assert.ok(n.y - n.h / 2 >= 0 && n.y + n.h / 2 <= r.height, '节点纵向应在画布内');
  // 图上标注生成时的家谱版本
  assert.match(r.caption.text, /家谱版本 3/);
});

test('整谱关系图：按忽略方向的关系划分连通分量，孤立成员各自成量', () => {
  const state = makeState(['A', 'B', 'C', 'D', 'E', 'F']);
  add(state, 'A', 'B'); // A→B
  add(state, 'C', 'B'); // C→B（方向汇聚，仍属同一分量）
  add(state, 'D', 'E'); // D→E
  // F 无任何关系：单成员分量
  const r = layoutFamilyChart(state, 1);
  assert.equal(r.componentCount, 3);
  const compOf = (id) => nodeOf(r, id).component;
  assert.equal(compOf('A'), compOf('B'));
  assert.equal(compOf('B'), compOf('C'));
  assert.equal(compOf('D'), compOf('E'));
  assert.notEqual(compOf('A'), compOf('D'));
  assert.notEqual(compOf('A'), compOf('F'));
  assert.notEqual(compOf('D'), compOf('F'));
  assert.deepEqual(
    r.components.map((c) => c.memberCount).sort((a, b) => a - b),
    [1, 2, 3],
  );
});

test('整谱关系图：各分量按最长父母链分层（层号取最长链而非最短链）', () => {
  const state = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'A', 'C'); // C 有父母 A 与 B：最长链 A→B→C 决定 C 在第 2 层
  const r = layoutFamilyChart(state, 1);
  assert.equal(nodeOf(r, 'A').layer, 0);
  assert.equal(nodeOf(r, 'B').layer, 1);
  assert.equal(nodeOf(r, 'C').layer, 2, '层号应由最长父母链决定');
  // 层号越大越靠下
  assert.ok(nodeOf(r, 'A').y < nodeOf(r, 'B').y);
  assert.ok(nodeOf(r, 'B').y < nodeOf(r, 'C').y);
});

test('整谱关系图：多位父母指向同一子女时只绘一个节点并保留各条连线', () => {
  const state = makeState(['A', 'B', 'C']);
  add(state, 'A', 'C');
  add(state, 'B', 'C');
  const r = layoutFamilyChart(state, 1);
  assert.equal(r.nodes.length, 3);
  assert.equal(r.nodes.filter((n) => n.id === 'C').length, 1, '同一子女只绘一个节点');
  assert.equal(r.edges.length, 2);
  assert.deepEqual(
    r.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
    ['A->C', 'B->C'],
  );
});

test('整谱关系图：层内按直接父母横坐标重心排序（优先于姓名）', () => {
  // 第 0 层按姓名：PA 在左、PB 在右；
  // 第 1 层中 AA 的父母是 PB（靠右）、AB 的父母是 PA（靠左），
  // 按父母重心 AB 应排在 AA 左侧——尽管按姓名 AA < AB。
  // G 为共同后代，把两家连成一个分量。
  const state = makeState(['PA', 'PB', 'AA', 'AB', 'G']);
  add(state, 'PB', 'AA');
  add(state, 'PA', 'AB');
  add(state, 'AA', 'G');
  add(state, 'AB', 'G');
  const r = layoutFamilyChart(state, 1);
  assert.equal(r.componentCount, 1);
  assert.ok(nodeOf(r, 'PA').x < nodeOf(r, 'PB').x);
  assert.ok(nodeOf(r, 'AB').x < nodeOf(r, 'AA').x, '重心排序应优先于姓名排序');
});

test('整谱关系图：重心平局时按姓名排序', () => {
  const state = makeState(['P', 'B', 'A']);
  add(state, 'P', 'B');
  add(state, 'P', 'A'); // A、B 同为 P 的子女，父母重心相同
  const r = layoutFamilyChart(state, 1);
  assert.ok(nodeOf(r, 'A').x < nodeOf(r, 'B').x);
});

test('整谱关系图：重心与姓名都平局时按成员 ID 稳定排序', () => {
  const state = makeState([['P', 'P'], ['id-b', '同名'], ['id-a', '同名']]);
  add(state, 'P', 'id-b');
  add(state, 'P', 'id-a');
  const r = layoutFamilyChart(state, 1);
  assert.ok(nodeOf(r, 'id-a').x < nodeOf(r, 'id-b').x);
});

test('整谱关系图：没有父母的层按姓名、ID 排序', () => {
  const state = makeState(['C', 'A', 'B', 'K1', 'K2']);
  add(state, 'C', 'K1');
  add(state, 'A', 'K1');
  add(state, 'B', 'K2');
  add(state, 'K1', 'K2'); // K2 的父母为 B 与 K1，整个图为一个分量
  const r = layoutFamilyChart(state, 1);
  assert.equal(r.componentCount, 1);
  // 第 0 层为 C、A、B（都没有父母），按姓名 A、B、C 排开
  assert.equal(nodeOf(r, 'A').layer, 0);
  assert.equal(nodeOf(r, 'B').layer, 0);
  assert.equal(nodeOf(r, 'C').layer, 0);
  assert.ok(nodeOf(r, 'A').x < nodeOf(r, 'B').x);
  assert.ok(nodeOf(r, 'B').x < nodeOf(r, 'C').x);
});

test('整谱关系图：同层节点（含长姓名）互不重叠并保留最小间距', () => {
  const state = makeState(['R', '长姓名甲子', '长姓名乙丑', '长姓名丙寅', '长姓名丁卯']);
  for (const c of ['长姓名甲子', '长姓名乙丑', '长姓名丙寅', '长姓名丁卯']) add(state, 'R', c);
  const r = layoutFamilyChart(state, 1);
  for (let layer = 0; layer <= 1; layer += 1) {
    const inLayer = r.nodes.filter((n) => n.layer === layer).sort((a, b) => a.x - b.x);
    for (let i = 1; i < inLayer.length; i += 1) {
      const prev = inLayer[i - 1];
      const cur = inLayer[i];
      assert.ok(
        cur.x - cur.w / 2 - (prev.x + prev.w / 2) >= GAP_X - 0.01,
        `第 ${layer} 层相邻节点间距不足`,
      );
    }
  }
});

test('整谱关系图：分量之间留白，背景带互不重叠', () => {
  const state = makeState(['A', 'B', 'C', 'D']);
  add(state, 'A', 'B');
  add(state, 'B', 'C'); // 分量一：A→B→C（三层）
  // D 孤立：分量二
  const r = layoutFamilyChart(state, 1);
  assert.equal(r.componentCount, 2);
  const bands = [...r.components].sort((a, b) => a.y - b.y);
  const gap = bands[1].y - (bands[0].y + bands[0].height);
  assert.equal(gap, GAP_COMPONENT - 2 * BAND_PAD);
  assert.ok(gap > 0, '分量之间应有留白');
});

test('整谱关系图：全部节点与分量背景带都落在画布范围内', () => {
  const state = makeState(['R', 'A', 'B', 'C', 'D', 'E']);
  add(state, 'R', 'A');
  add(state, 'R', 'B');
  add(state, 'A', 'C');
  add(state, 'B', 'C');
  add(state, 'C', 'D');
  // E 孤立分量
  const r = layoutFamilyChart(state, 1);
  for (const n of r.nodes) {
    assert.ok(n.x - n.w / 2 >= 0 && n.x + n.w / 2 <= r.width, `节点 ${n.id} 横向超出画布`);
    assert.ok(n.y - n.h / 2 >= 0 && n.y + n.h / 2 <= r.height, `节点 ${n.id} 纵向超出画布`);
  }
  for (const c of r.components) {
    assert.ok(c.x >= 0 && c.x + c.width <= r.width, '分量背景带横向超出画布');
    assert.ok(c.y >= 0 && c.y + c.height <= r.height, '分量背景带纵向超出画布');
  }
});

test('整谱关系图：每条连线的父母端都在子女端上方（层号严格更小）', () => {
  const state = makeState(['R', 'A', 'C']);
  add(state, 'R', 'A');
  add(state, 'A', 'C');
  add(state, 'R', 'C'); // 跨层边：R(0) → C(2)
  const r = layoutFamilyChart(state, 1);
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  assert.equal(r.edges.length, 3);
  for (const e of r.edges) {
    const p = byId.get(e.parentId);
    const c = byId.get(e.childId);
    assert.ok(p && c, '连线两端都应有节点');
    assert.ok(p.layer < c.layer, `${e.parentId} 的层号应小于 ${e.childId}`);
    assert.ok(p.y < c.y, `${e.parentId} 应在 ${e.childId} 上方`);
  }
});

test('整谱关系图：布局确定（重复计算结果一致）且不修改家谱状态', () => {
  const state = makeState(['R', 'A', 'B', 'C', 'D']);
  add(state, 'R', 'A');
  add(state, 'R', 'B');
  add(state, 'A', 'C');
  add(state, 'B', 'C');
  const snapshot = JSON.parse(JSON.stringify(state));
  const r1 = layoutFamilyChart(state, 7);
  const r2 = layoutFamilyChart(state, 7);
  assert.deepEqual(r1, r2);
  assert.deepEqual(state, snapshot, '布局是纯函数，不得修改家谱');
});

test('HTTP：GET /api/family-chart 只读返回布局与生成时版本，不写家谱', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-chart-http-'));
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
    // 空谱：返回空状态
    let res = await fetch(`${base}/api/family-chart`);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.empty, true);
    assert.equal(body.version, 0);
    assert.equal(body.memberCount, 0);

    // 录入三名成员与两条关系
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

    res = await fetch(`${base}/api/family-chart`);
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.empty, false);
    assert.equal(body.version, 5, '图上标注的应是生成时的家谱版本');
    assert.equal(body.memberCount, 3);
    assert.equal(body.edgeCount, 2);
    assert.equal(body.componentCount, 1);
    assert.equal(body.nodes.length, 3);
    assert.match(body.caption.text, /家谱版本 5/);
    // 节点带姓名与坐标，边带两端姓名
    assert.ok(
      body.nodes.every(
        (n) => typeof n.name === 'string' && Number.isFinite(n.x) && Number.isFinite(n.y),
      ),
    );
    assert.ok(body.edges.every((e) => e.parentName && e.childName));
    // 只读：家谱版本不因查询而推进
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.version, body.version);
    assert.equal(state.members.length, 3);
    assert.equal(state.edges.length, 2);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    delete process.env.DATA_FILE;
  }
});
