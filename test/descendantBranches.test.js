'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  validateEdge,
  descendantBranches,
  MAX_DESCENDANT_GENERATIONS,
} = require('../server/familyGraph');

/** 测试辅助：批量建成员（成员 id 与姓名相同） */
function makeState(names) {
  const state = createState();
  for (const name of names) {
    const member = { id: name, name };
    state.members.push(member);
    state.parentsOf[member.id] = [];
  }
  return state;
}

function add(state, parent, child) {
  const r = validateEdge(state, parent, child);
  assert.equal(r.error, null, `应允许 ${parent} -> ${child}：${r.error || ''}`);
  state.parentsOf[child].push(parent);
}

/** 按 id 取一个成员视图项，找不到则失败 */
function memberOf(result, id) {
  const hit = result.members.find((m) => m.id === id);
  assert.ok(hit, `支系视图中应包含成员 ${id}`);
  return hit;
}

function edgeKeys(result) {
  return result.edges.map((e) => `${e.parentId}->${e.childId}`).sort();
}

test('支系视图：直线家谱按最短代数分组，超出上限的世代与边不展示', () => {
  const state = makeState(['R', 'A', 'B', 'C']);
  add(state, 'R', 'A');
  add(state, 'A', 'B');
  add(state, 'B', 'C');

  const r = descendantBranches(state, 'R', 2);
  assert.equal(r.error, null);
  assert.deepEqual(r.branchRoots, ['A']);
  assert.deepEqual(
    r.members.map((m) => [m.id, m.gen]),
    [['R', 0], ['A', 1], ['B', 2]],
  );
  // 分支起点属于自身分支；始祖不属于任何分支
  assert.deepEqual(memberOf(r, 'R').branches, []);
  assert.deepEqual(memberOf(r, 'A').branches, ['A']);
  assert.deepEqual(memberOf(r, 'B').branches, ['A']);
  // C 超出 2 代上限：成员与 B->C 关系都不出现
  assert.equal(r.members.some((m) => m.id === 'C'), false);
  assert.deepEqual(edgeKeys(r), ['A->B', 'R->A']);
});

test('支系视图：代数上限为 1 时只含始祖与直系子女', () => {
  const state = makeState(['R', 'A', 'B', 'D']);
  add(state, 'R', 'A');
  add(state, 'R', 'B');
  add(state, 'A', 'D');

  const r = descendantBranches(state, 'R', 1);
  assert.equal(r.error, null);
  assert.deepEqual(r.branchRoots, ['A', 'B']);
  assert.deepEqual(
    r.members.map((m) => m.id),
    ['R', 'A', 'B'],
  );
  assert.deepEqual(edgeKeys(r), ['R->A', 'R->B']);
});

test('支系视图：同一后代经多条路径到达只显示一次，并标记其所属的全部分支', () => {
  // 钻石结构：R->A->D，R->B->D。D 经两条 2 代路径到达，同属 A、B 两个分支。
  const state = makeState(['R', 'A', 'B', 'D']);
  add(state, 'R', 'A');
  add(state, 'R', 'B');
  add(state, 'A', 'D');
  add(state, 'B', 'D');

  const r = descendantBranches(state, 'R', 3);
  assert.equal(r.error, null);
  assert.equal(r.members.filter((m) => m.id === 'D').length, 1, 'D 只应出现一次');
  assert.equal(memberOf(r, 'D').gen, 2);
  assert.deepEqual(memberOf(r, 'D').branches, ['A', 'B']);
  assert.equal(r.members.length, 4);
  assert.equal(r.edges.length, 4);
});

test('支系视图：分支归属不限于最短路径（长路径到达的分支同样标记）', () => {
  // R->A->D->E 与 R->B->E：E 距始祖最短 2 代（经 B），但也属于 A 分支（经 A->D->E）。
  const state = makeState(['R', 'A', 'B', 'D', 'E']);
  add(state, 'R', 'A');
  add(state, 'R', 'B');
  add(state, 'A', 'D');
  add(state, 'D', 'E');
  add(state, 'B', 'E');

  const r = descendantBranches(state, 'R', 3);
  assert.equal(r.error, null);
  assert.deepEqual(
    r.members.map((m) => [m.id, m.gen]),
    [['R', 0], ['A', 1], ['B', 1], ['D', 2], ['E', 2]],
  );
  assert.deepEqual(memberOf(r, 'E').branches, ['A', 'B']);
  assert.deepEqual(memberOf(r, 'D').branches, ['A']);
  assert.deepEqual(edgeKeys(r), ['A->D', 'B->E', 'D->E', 'R->A', 'R->B']);
});

test('支系视图：后代同时是始祖直系子女时，既是自己分支的起点也属于其他分支', () => {
  // R->A->D 且 R->D：D 距始祖最短 1 代，是分支起点；同时经 A 到达，也属于 A 分支。
  const state = makeState(['R', 'A', 'D']);
  add(state, 'R', 'A');
  add(state, 'R', 'D');
  add(state, 'A', 'D');

  const r = descendantBranches(state, 'R', 5);
  assert.equal(r.error, null);
  assert.deepEqual(r.branchRoots, ['A', 'D']);
  assert.equal(memberOf(r, 'D').gen, 1);
  assert.deepEqual(memberOf(r, 'D').branches, ['A', 'D']);
  assert.deepEqual(edgeKeys(r), ['A->D', 'R->A', 'R->D']);
});

test('支系视图：不带入支系外成员及其关系', () => {
  // X 不是 R 的后代（如配偶）：X->A 的关系两端不都在支系内，不展示。
  const state = makeState(['R', 'A', 'C', 'X']);
  add(state, 'R', 'A');
  add(state, 'X', 'A');
  add(state, 'A', 'C');

  const r = descendantBranches(state, 'R', 5);
  assert.equal(r.error, null);
  assert.deepEqual(
    r.members.map((m) => m.id),
    ['R', 'A', 'C'],
  );
  assert.deepEqual(edgeKeys(r), ['A->C', 'R->A']);
});

test('支系视图：没有后代时只含始祖本人，无分支无关系', () => {
  const state = makeState(['R', 'X']);
  add(state, 'X', 'R'); // R 是 X 的子女，向下没有后代

  const r = descendantBranches(state, 'R', 3);
  assert.equal(r.error, null);
  assert.deepEqual(r.branchRoots, []);
  assert.deepEqual(
    r.members.map((m) => [m.id, m.gen, m.branches]),
    [['R', 0, []]],
  );
  assert.deepEqual(r.edges, []);
});

test('支系视图：成员与关系排序确定（按代与 id、按子女与父母 id）', () => {
  // 建边顺序与字母序相反，验证输出仍按确定顺序排列
  const state = makeState(['R', 'B', 'A', 'C']);
  add(state, 'R', 'B');
  add(state, 'R', 'A');
  add(state, 'B', 'C');
  add(state, 'A', 'C');

  const r = descendantBranches(state, 'R', 3);
  assert.equal(r.error, null);
  assert.deepEqual(
    r.members.map((m) => m.id),
    ['R', 'A', 'B', 'C'],
  );
  assert.deepEqual(
    r.edges.map((e) => `${e.parentId}->${e.childId}`),
    ['R->A', 'R->B', 'A->C', 'B->C'],
  );
});

test('支系视图：始祖不存在或代数上限非法时返回错误', () => {
  const state = makeState(['R', 'A']);
  add(state, 'R', 'A');

  assert.equal(descendantBranches(state, 'ghost', 3).error, '成员不存在');
  for (const bad of [0, -1, 11, 2.5, '3', Number.NaN, undefined]) {
    const r = descendantBranches(state, 'R', bad);
    assert.ok(r.error, `maxGen=${String(bad)} 应被拒绝`);
    assert.match(r.error, /代数上限/);
  }
  assert.equal(MAX_DESCENDANT_GENERATIONS, 10);
  // 边界：10 代合法
  assert.equal(descendantBranches(state, 'R', 10).error, null);
});
