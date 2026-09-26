'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  validateEdge,
  allShortestPathsUp,
  findCommonAncestors,
  MAX_PARENTS_PER_CHILD,
} = require('../server/familyGraph');

/** 测试辅助：批量建成员 */
function makeState(names) {
  const state = createState();
  const id = {};
  for (const name of names) {
    const member = { id: name, name };
    state.members.push(member);
    state.parentsOf[member.id] = [];
  }
  return [state, id];
}

function add(state, parent, child) {
  const r = validateEdge(state, parent, child);
  assert.equal(r.error, null, `应允许 ${parent} -> ${child}`);
  state.parentsOf[child].push(parent);
}

test('拒绝自指关系', () => {
  const [state] = makeState(['A']);
  assert.match(validateEdge(state, 'A', 'A').error, /自指/);
});

test('拒绝重复边', () => {
  const [state] = makeState(['P', 'C']);
  add(state, 'P', 'C');
  assert.match(validateEdge(state, 'P', 'C').error, /重复边/);
});

test('每名子女至多两位父母', () => {
  const [state] = makeState(['P1', 'P2', 'P3', 'C']);
  add(state, 'P1', 'C');
  add(state, 'P2', 'C');
  assert.equal(state.parentsOf['C'].length, MAX_PARENTS_PER_CHILD);
  assert.match(validateEdge(state, 'P3', 'C').error, /至多 2 位父母/);
});

test('拒绝祖先环路：直接反边', () => {
  const [state] = makeState(['A', 'B']);
  add(state, 'A', 'B'); // A 是 B 的父母
  assert.match(validateEdge(state, 'B', 'A').error, /祖先环路/);
});

test('拒绝祖先环路：多代后绕回', () => {
  const [state] = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');
  add(state, 'B', 'C'); // A -> B -> C
  // 让 C 成为 A 的父母，则 C -> A -> B -> C 成环
  assert.match(validateEdge(state, 'C', 'A').error, /祖先环路/);
});

test('不存在的成员被拒绝', () => {
  const [state] = makeState(['A']);
  assert.ok(validateEdge(state, 'A', 'X').error);
  assert.ok(validateEdge(state, 'X', 'A').error);
});

test('全部最短路径：同代数的不同路径全部保留', () => {
  // 经典交叉：
  //   G（祖父）有两个孩子 P1、P2
  //   X 的父母是 P1、P2 —— 那么 X 经两条路径到达 G，均为 2 代
  const [state] = makeState(['G', 'P1', 'P2', 'X']);
  add(state, 'G', 'P1');
  add(state, 'G', 'P2');
  add(state, 'P1', 'X');
  add(state, 'P2', 'X');

  const up = allShortestPathsUp(state, 'X');
  assert.equal(up.get('G').gen, 2);
  assert.deepEqual(
    up.get('G').paths.map((p) => p.join('>')).sort(),
    ['X>P1>G', 'X>P2>G'],
  );
});

test('更长路径被丢弃，只保留最短代数路径', () => {
  // D 的父母为 B、C；B 的父母为 A、E；E 的父母为 A；C 的父母为 A。
  // D 到 A：D>B>A（2 代）、D>C>A（2 代），另有 D>B>E>A（3 代，应被丢弃）
  const [state] = makeState(['A', 'B', 'C', 'D', 'E']);
  add(state, 'A', 'B');
  add(state, 'A', 'C');
  add(state, 'A', 'E');
  add(state, 'E', 'B');
  add(state, 'B', 'D');
  add(state, 'C', 'D');
  const up = allShortestPathsUp(state, 'D');
  assert.equal(up.get('A').gen, 2);
  assert.deepEqual(
    up.get('A').paths.map((p) => p.join('>')).sort(),
    ['D>B>A', 'D>C>A'],
  );
});

test('共同祖先：堂兄弟姐妹通过（祖父，祖母）双祖先，返回全部最少代数祖先', () => {
  // GP1, GP2 为父母（不强制必须登记他们之间无关系——边只表示亲子）
  // P1 父母: GP1,GP2；P2 父母: GP1,GP2
  // X 父母: P1, M1（外人，无向上记录）
  // Y 父母: P2, M2
  const [state] = makeState(['GP1', 'GP2', 'P1', 'P2', 'M1', 'M2', 'X', 'Y']);
  for (const p of ['GP1', 'GP2']) {
    add(state, p, 'P1');
    add(state, p, 'P2');
  }
  add(state, 'P1', 'X');
  add(state, 'M1', 'X');
  add(state, 'P2', 'Y');
  add(state, 'M2', 'Y');

  const r = findCommonAncestors(state, 'X', 'Y');
  assert.equal(r.samePerson, false);
  assert.equal(r.minTotalGen, 4); // X->P*->GP = 2，Y 同样 2
  assert.deepEqual(r.ancestors.map((a) => a.id).sort(), ['GP1', 'GP2']);
  for (const a of r.ancestors) {
    assert.equal(a.genA, 2);
    assert.equal(a.genB, 2);
  }
});

test('共同祖先：一方是另一方的祖先时，代数 0+N，且更省的祖先是本人链', () => {
  // A -> B -> C：查 A 与 C。共同祖先集合 {A}（A 自身 gen 0，C 到 A 为 2）
  const [state] = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  const r = findCommonAncestors(state, 'A', 'C');
  assert.equal(r.minTotalGen, 2);
  assert.deepEqual(r.ancestors.map((x) => x.id), ['A']);
  assert.equal(r.ancestors[0].genA, 0);
  assert.equal(r.ancestors[0].genB, 2);
});

test('共同祖先：亲生兄弟姐妹最近共同祖先是父母（而非祖父母）', () => {
  const [state] = makeState(['F', 'M', 'X', 'Y', 'GF']);
  add(state, 'F', 'X');
  add(state, 'M', 'X');
  add(state, 'F', 'Y');
  add(state, 'M', 'Y');
  add(state, 'GF', 'F');
  const r = findCommonAncestors(state, 'X', 'Y');
  assert.equal(r.minTotalGen, 2); // 各 1 代到 F/M
  assert.deepEqual(r.ancestors.map((a) => a.id).sort(), ['F', 'M']);
  // GF 总代数 4，不应出现
  assert.ok(!r.ancestors.some((a) => a.id === 'GF'));
});

test('同一人查询：自身为 0 代共同祖先', () => {
  const [state] = makeState(['A', 'P']);
  add(state, 'P', 'A');
  const r = findCommonAncestors(state, 'A', 'A');
  assert.equal(r.samePerson, true);
  assert.equal(r.minTotalGen, 0);
  assert.equal(r.ancestors[0].id, 'A');
});

test('无共同祖先时明确返回空集', () => {
  const [state] = makeState(['A', 'B', 'PA', 'PB']);
  add(state, 'PA', 'A');
  add(state, 'PB', 'B');
  const r = findCommonAncestors(state, 'A', 'B');
  assert.equal(r.minTotalGen, null);
  assert.deepEqual(r.ancestors, []);
});

test('同父异母/同母异父：仅一位最近共同祖先', () => {
  const [state] = makeState(['F', 'M1', 'M2', 'X', 'Y']);
  add(state, 'F', 'X');
  add(state, 'M1', 'X');
  add(state, 'F', 'Y');
  add(state, 'M2', 'Y');
  const r = findCommonAncestors(state, 'X', 'Y');
  assert.equal(r.minTotalGen, 2);
  assert.deepEqual(r.ancestors.map((a) => a.id), ['F']);
});
