'use strict';

/**
 * 回归测试：成员 ID 含 "|" 或内部空格时，成员对不得因键碰撞而串项。
 *
 * 旧实现用分隔符拼接成员对当键（"子女|父母"、"子女 父母"、"父母|子女"），
 * 不同成员对可能拼出同一个键：
 *   - "b|c"→"a" 与 "c"→"a|b" 都拼出 "a|b|c"（被误判为重复）；
 *   - "b c"→"a" 与 "c"→"a b" 都拼出 "a b c"（批量提交静默丢边）。
 * 现在统一用 pairKeyOf 按有序端点编码（JSON 数组），任意 ID 都不碰撞。
 * 本文件覆盖：备份校验、批量预检及提交、合并去重、变更影响比较、桥梁分析，
 * 以及恢复 / 撤销 / 重启后的关系保持；真正重复、自指、超两位父母、
 * 祖先环路仍须按原规则拒绝。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createState,
  validateEdge,
  validateEdgeBatch,
  validateBackup,
  previewMergeMembers,
  previewEdgeImpact,
  findGenerationConflicts,
  pairKeyOf,
} = require('../server/familyGraph');
const { findCriticalLinks } = require('../server/criticalLinks');
const { createStore } = require('../server/store');

/** 测试辅助：批量建成员（id 与姓名相同）并建立已有关系 */
function makeState(names, existing = []) {
  const state = createState();
  for (const name of names) {
    state.members.push({ id: name, name });
    state.parentsOf[name] = [];
  }
  for (const [p, c] of existing) {
    const r = validateEdge(state, p, c);
    assert.equal(r.error, null, `准备数据失败 ${p} -> ${c}: ${r.error}`);
    state.parentsOf[c].push(p);
  }
  return state;
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-pair-key-'));
  return path.join(dir, 'family.json');
}

/** 测试辅助：直接写数据文件，构造 ID 含特殊字符的成员并打开 store */
function storeWithIds(ids) {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 0,
      maxMembers: 30,
      members: ids.map((id, i) => ({ id, name: `成员${i + 1}` })),
      edges: [],
    }),
  );
  return { store: createStore(file), file };
}

/** 边表 → 有序端点对列表（排序便于比较；不用拼接键，正是为了避免被测问题） */
const edgePairs = (edges) =>
  edges.map((e) => [e.parentId, e.childId]).sort((x, y) => {
    if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
    return x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0;
  });

/* ---------------- pairKeyOf 本身 ---------------- */

test('成员对键：按有序端点编码，含 "|" 或空格的 ID 不碰撞', () => {
  // 任务给出的两组碰撞示例，编码后必须不同
  assert.notEqual(pairKeyOf('b|c', 'a'), pairKeyOf('c', 'a|b'));
  assert.notEqual(pairKeyOf('b c', 'a'), pairKeyOf('c', 'a b'));
  // 有序：端点对调键不同
  assert.notEqual(pairKeyOf('a', 'b'), pairKeyOf('b', 'a'));
  // 同一有序端点对编码稳定
  assert.equal(pairKeyOf('b|c', 'a'), pairKeyOf('b|c', 'a'));
  assert.equal(pairKeyOf('b c', 'a b'), pairKeyOf('b c', 'a b'));
});

/* ---------------- 批量预检及提交 ---------------- */

test('批量预检：b|c→a 与 c→a|b 是两条不同关系，不误判批内重复', () => {
  const state = makeState(['b|c', 'a', 'c', 'a|b']);
  const r = validateEdgeBatch(state, [
    { parentId: 'b|c', childId: 'a' },
    { parentId: 'c', childId: 'a|b' },
  ]);
  assert.equal(r.valid, true);
  assert.deepEqual(r.items.map((i) => i.errors), [[], []]);
});

test('批量预检：b c→a 与 c→a b 是两条不同关系，不误判批内重复', () => {
  const state = makeState(['b c', 'a', 'c', 'a b']);
  const r = validateEdgeBatch(state, [
    { parentId: 'b c', childId: 'a' },
    { parentId: 'c', childId: 'a b' },
  ]);
  assert.equal(r.valid, true);
  assert.deepEqual(r.items.map((i) => i.errors), [[], []]);
});

test('批量预检：含特殊字符 ID 的真正重复、自指、超两位父母与环路仍按原规则拒绝', () => {
  // 批内真正重复：两个副本都报错
  const dupState = makeState(['b|c', 'a']);
  const dup = validateEdgeBatch(dupState, [
    { parentId: 'b|c', childId: 'a' },
    { parentId: 'b|c', childId: 'a' },
  ]);
  assert.equal(dup.valid, false);
  assert.ok(dup.items[0].errors.some((m) => /批内重复/.test(m)));
  assert.ok(dup.items[1].errors.some((m) => /批内重复/.test(m)));

  // 自指
  const self = validateEdgeBatch(dupState, [{ parentId: 'b|c', childId: 'b|c' }]);
  assert.ok(self.items[0].errors.some((m) => /自指/.test(m)));

  // 超过两位父母（特殊字符 ID 的三位父母指向同一子女）
  const manyState = makeState(['p|1', 'p 2', 'p 3', 'c|x']);
  const many = validateEdgeBatch(manyState, [
    { parentId: 'p|1', childId: 'c|x' },
    { parentId: 'p 2', childId: 'c|x' },
    { parentId: 'p 3', childId: 'c|x' },
  ]);
  assert.equal(many.valid, false);
  assert.ok(many.items.every((i) => i.errors.some((m) => /至多 2 位父母/.test(m))));

  // 祖先环路（草稿内部成环）
  const cycState = makeState(['x|y', 'y|z']);
  const cyc = validateEdgeBatch(cycState, [
    { parentId: 'x|y', childId: 'y|z' },
    { parentId: 'y|z', childId: 'x|y' },
  ]);
  assert.equal(cyc.valid, false);
  assert.ok(cyc.items.every((i) => i.errors.some((m) => /环路/.test(m))));
});

test('批量提交：b c→a 与 c→a b 两条都写入，不静默丢边，撤销与重启后不丢失', () => {
  const { store, file } = storeWithIds(['b c', 'a', 'c', 'a b']);
  const v = store.getVersion();

  const preview = store.validateEdgeBatch([
    { parentId: 'b c', childId: 'a' },
    { parentId: 'c', childId: 'a b' },
  ]);
  assert.equal(preview.valid, true);

  const result = store.commitEdges(
    [
      { parentId: 'b c', childId: 'a' },
      { parentId: 'c', childId: 'a b' },
    ],
    v,
  );
  assert.equal(result.error, null);
  // 两条关系都必须保存——旧实现去重键同为 "a b c"，会静默丢掉一条
  assert.deepEqual(edgePairs(store.list().edges), [
    ['b c', 'a'],
    ['c', 'a b'],
  ]);

  // 重启（重新加载数据文件）后两条关系仍在
  const reloaded = createStore(file);
  assert.deepEqual(edgePairs(reloaded.list().edges), [
    ['b c', 'a'],
    ['c', 'a b'],
  ]);

  // 撤销批量提交：两条关系整体回退，且回退结果同样落盘
  assert.equal(reloaded.undoLast(reloaded.getVersion()).error, null);
  assert.equal(reloaded.list().edges.length, 0);
  assert.equal(createStore(file).list().edges.length, 0);
});

test('批量提交：b|c→a 与 c→a|b 两条都写入（预检分组与提交去重全链路）', () => {
  const { store, file } = storeWithIds(['b|c', 'a', 'c', 'a|b']);
  const v = store.getVersion();
  const result = store.commitEdges(
    [
      { parentId: 'b|c', childId: 'a' },
      { parentId: 'c', childId: 'a|b' },
    ],
    v,
  );
  assert.equal(result.error, null);
  assert.deepEqual(edgePairs(store.list().edges), [
    ['b|c', 'a'],
    ['c', 'a|b'],
  ]);
  assert.deepEqual(edgePairs(createStore(file).list().edges), [
    ['b|c', 'a'],
    ['c', 'a|b'],
  ]);
});

/* ---------------- 合并去重 ---------------- */

test('合并去重：b|c→a 与 c→a|b 不被误判为重复，合并无关成员时两条都保留', () => {
  // X、Y 与这些关系无关：合并 Y 入 X 不应触碰任何关系
  const state = makeState(
    ['X', 'Y', 'b|c', 'a', 'c', 'a|b'],
    [
      ['b|c', 'a'],
      ['c', 'a|b'],
    ],
  );
  const r = previewMergeMembers(state, 'X', 'Y');
  assert.equal(r.valid, true);
  assert.equal(r.removedDuplicateCount, 0, '不同关系不得被误去重');
  assert.equal(r.edges.length, 2);
  assert.deepEqual(edgePairs(r.edges), [
    ['b|c', 'a'],
    ['c', 'a|b'],
  ]);
});

test('合并去重：含 "|" ID 替换后真正相同的关系仍被去重', () => {
  const state = makeState(
    ['p|1', 'q', 'x|y'],
    [
      ['p|1', 'x|y'],
      ['q', 'x|y'],
    ],
  );
  const r = previewMergeMembers(state, 'p|1', 'q');
  assert.equal(r.valid, true);
  assert.equal(r.removedDuplicateCount, 1);
  assert.deepEqual(edgePairs(r.edges), [['p|1', 'x|y']]);
});

/* ---------------- 变更影响比较 ---------------- */

test('变更影响比较：含 "|" 的不同祖先—后代对不串项，各自计入未变化', () => {
  // 两对矛盾：(祖先 "b|c", 后代 "a") 与 (祖先 "b", 后代 "c|a")——
  // 旧键 `${ancestor}|${descendant}` 对两者都拼出 "b|c|a"，会把两对混为一对。
  const state = makeState(
    ['b|c', 'a', 'm', 'b', 'c|a', 'n', 'x', 'y'],
    [
      ['b|c', 'a'],
      ['b|c', 'm'],
      ['m', 'a'], // "b|c" 到 "a"：最短 1 代、最长 2 代 → 矛盾
      ['b', 'c|a'],
      ['b', 'n'],
      ['n', 'c|a'], // "b" 到 "c|a"：最短 1 代、最长 2 代 → 矛盾
      ['x', 'y'], // 与矛盾无关的边，供移除预览
    ],
  );
  assert.equal(findGenerationConflicts(state).total, 2);

  const r = previewEdgeImpact(state, { action: 'remove', parentId: 'x', childId: 'y' });
  assert.equal(r.beforeTotal, 2);
  assert.equal(r.afterTotal, 2);
  assert.equal(r.unchangedCount, 2, '两对矛盾都保持原样，不得因键碰撞合并成一对');
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.changed, []);
});

/* ---------------- 备份校验 ---------------- */

test('备份校验：b|c→a 与 c→a|b 都合法保留；空格 ID 同理', () => {
  const pipeBackup = {
    members: [
      { id: 'b|c', name: '乙丙' },
      { id: 'a', name: '甲' },
      { id: 'c', name: '丙' },
      { id: 'a|b', name: '甲乙' },
    ],
    edges: [
      { parentId: 'b|c', childId: 'a' },
      { parentId: 'c', childId: 'a|b' },
    ],
  };
  const r1 = validateBackup(pipeBackup);
  assert.equal(r1.valid, true);
  assert.equal(r1.edgeCount, 2);
  assert.deepEqual(edgePairs(r1.edges), [
    ['b|c', 'a'],
    ['c', 'a|b'],
  ]);

  const spaceBackup = {
    members: [
      { id: 'b c', name: '乙丙' },
      { id: 'a', name: '甲' },
      { id: 'c', name: '丙' },
      { id: 'a b', name: '甲乙' },
    ],
    edges: [
      { parentId: 'b c', childId: 'a' },
      { parentId: 'c', childId: 'a b' },
    ],
  };
  const r2 = validateBackup(spaceBackup);
  assert.equal(r2.valid, true);
  assert.equal(r2.edgeCount, 2);
  assert.deepEqual(edgePairs(r2.edges), [
    ['b c', 'a'],
    ['c', 'a b'],
  ]);
});

test('备份校验：含特殊字符 ID 的真正重复关系仍逐项报错', () => {
  const r = validateBackup({
    members: [
      { id: 'b|c', name: '乙丙' },
      { id: 'a', name: '甲' },
    ],
    edges: [
      { parentId: 'b|c', childId: 'a' },
      { parentId: 'b|c', childId: 'a' },
    ],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.where === 'edge' && /重复/.test(e.message)));
});

/* ---------------- 桥梁分析 ---------------- */

test('桥梁分析：含 "|" 的不同关系不共享键，两个家族各自的桥都正确判定', () => {
  // 旧键 `${parent}|${child}` 对 "b|c"→"a" 与 "b"→"c|a" 都拼出 "b|c|a"，
  // 后者会覆盖前者，桥查找张冠李戴。
  const state = makeState(
    ['b|c', 'a', 'b', 'c|a'],
    [
      ['b|c', 'a'],
      ['b', 'c|a'],
    ],
  );
  const r = findCriticalLinks(state);
  assert.equal(r.componentCount, 2);
  assert.equal(r.bridgeCount, 2);

  const b1 = r.bridges.find((x) => x.parentId === 'b|c' && x.childId === 'a');
  assert.ok(b1, '应存在桥梁 "b|c"→"a"');
  assert.deepEqual(b1.parentSide, ['b|c']);
  assert.deepEqual(b1.childSide, ['a']);

  const b2 = r.bridges.find((x) => x.parentId === 'b' && x.childId === 'c|a');
  assert.ok(b2, '应存在桥梁 "b"→"c|a"');
  assert.deepEqual(b2.parentSide, ['b']);
  assert.deepEqual(b2.childSide, ['c|a']);
});

/* ---------------- 恢复 / 撤销 / 重启 ---------------- */

test('恢复含特殊字符 ID 的备份后，撤销与重启都不丢边', () => {
  const file = tmpFile();
  const store1 = createStore(file);
  store1.addMember('原有成员');

  const backup = JSON.stringify({
    members: [
      { id: 'b|c', name: '乙丙' },
      { id: 'a', name: '甲' },
      { id: 'c', name: '丙' },
      { id: 'a|b', name: '甲乙' },
    ],
    edges: [
      { parentId: 'b|c', childId: 'a' },
      { parentId: 'c', childId: 'a|b' },
    ],
  });
  const preview = store1.previewRestore(backup);
  assert.equal(preview.valid, true, '含 "|" ID 的不同关系不得被误判为重复');
  assert.equal(store1.restoreBackup(backup, preview.fingerprint, store1.getVersion()).error, null);
  assert.deepEqual(edgePairs(store1.list().edges), [
    ['b|c', 'a'],
    ['c', 'a|b'],
  ]);

  // 重启（重新加载数据文件）：两条关系原样保留
  const store2 = createStore(file);
  assert.deepEqual(edgePairs(store2.list().edges), [
    ['b|c', 'a'],
    ['c', 'a|b'],
  ]);

  // 撤销恢复：回到恢复前（仅原有成员、无关系），撤销结果同样落盘
  assert.equal(store2.undoLast(store2.getVersion()).error, null);
  assert.equal(store2.list().edges.length, 0);
  assert.equal(store2.list().members.length, 1);
  const store3 = createStore(file);
  assert.equal(store3.list().edges.length, 0);
  assert.equal(store3.list().members.length, 1);
});
