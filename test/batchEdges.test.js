'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  validateEdge,
  validateEdgeBatch,
  MAX_BATCH_EDGES,
} = require('../server/familyGraph');

/** 测试辅助：批量建成员（id 与姓名相同） */
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

const errorsOf = (result, index) => result.items[index].errors;

test('批量：全部合法时 valid 为 true 且无错误', () => {
  const state = makeState(['A', 'B', 'C', 'D']);
  const r = validateEdgeBatch(state, [
    { parentId: 'A', childId: 'C' },
    { parentId: 'B', childId: 'D' },
  ]);
  assert.equal(r.valid, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.items.map((i) => i.errors), [[], []]);
});

test('批量：空草稿与非数组、超上限被整体拒绝', () => {
  const state = makeState(['A']);
  assert.equal(validateEdgeBatch(state, []).valid, false);
  assert.match(validateEdgeBatch(state, []).error, /空/);
  assert.equal(validateEdgeBatch(state, null).valid, false);
  const huge = Array.from({ length: MAX_BATCH_EDGES + 1 }, () => ({ parentId: 'A', childId: 'A' }));
  assert.equal(validateEdgeBatch(state, huge).valid, false);
  assert.match(validateEdgeBatch(state, huge).error, new RegExp(MAX_BATCH_EDGES));
});

test('批量：成员不存在与自指逐条报错', () => {
  const state = makeState(['A']);
  const r = validateEdgeBatch(state, [
    { parentId: 'X', childId: 'A' },
    { parentId: 'A', childId: 'Y' },
    { parentId: 'A', childId: 'A' },
    { parentId: 5, childId: null },
  ]);
  assert.equal(r.valid, false);
  assert.match(errorsOf(r, 0)[0], /父母成员不存在/);
  assert.match(errorsOf(r, 1)[0], /子女成员不存在/);
  assert.match(errorsOf(r, 2)[0], /自指/);
  assert.ok(errorsOf(r, 3).some((m) => /父母成员不存在/.test(m)));
  assert.ok(errorsOf(r, 3).some((m) => /子女成员不存在/.test(m)));
});

test('批量：批内重复的所有副本一起被标记，且与草稿顺序无关', () => {
  const state = makeState(['P', 'C']);
  const order1 = validateEdgeBatch(state, [
    { parentId: 'P', childId: 'C' },
    { parentId: 'P', childId: 'C' },
  ]);
  assert.equal(order1.valid, false);
  assert.ok(errorsOf(order1, 0).some((m) => /批内重复/.test(m)));
  assert.ok(errorsOf(order1, 1).some((m) => /批内重复/.test(m)));
});

test('批量：与已有关系重复', () => {
  const state = makeState(['P', 'C', 'X'], [['P', 'C']]);
  const r = validateEdgeBatch(state, [
    { parentId: 'P', childId: 'C' },
    { parentId: 'X', childId: 'C' },
  ]);
  assert.ok(errorsOf(r, 0).some((m) => /已存在/.test(m)));
  assert.deepEqual(errorsOf(r, 1), []);
  assert.equal(r.valid, false);
});

test('批量：合并后超过两位父母——已有 + 草稿合并计数，不受顺序影响', () => {
  const state = makeState(['P1', 'P2', 'P3', 'C'], [['P1', 'C']]);
  const r = validateEdgeBatch(state, [
    { parentId: 'P2', childId: 'C' },
    { parentId: 'P3', childId: 'C' },
  ]);
  assert.equal(r.valid, false);
  // 两条新边都会让该子女达到 3 位父母，均应报错
  assert.match(errorsOf(r, 0)[0], /至多 2 位父母/);
  assert.match(errorsOf(r, 1)[0], /至多 2 位父母/);
});

test('批量：批内两条同子女不同父母且原本无父母时合法（恰两位）', () => {
  const state = makeState(['P1', 'P2', 'C']);
  const r = validateEdgeBatch(state, [
    { parentId: 'P1', childId: 'C' },
    { parentId: 'P2', childId: 'C' },
  ]);
  assert.equal(r.valid, true);
});

test('批量：草稿内部成环——两条反边互相标记，与顺序无关', () => {
  const state = makeState(['A', 'B']);
  const forwardFirst = validateEdgeBatch(state, [
    { parentId: 'A', childId: 'B' },
    { parentId: 'B', childId: 'A' },
  ]);
  const reverseFirst = validateEdgeBatch(state, [
    { parentId: 'B', childId: 'A' },
    { parentId: 'A', childId: 'B' },
  ]);
  for (const r of [forwardFirst, reverseFirst]) {
    assert.equal(r.valid, false);
    // 两种顺序下，参与环的两条边都必须被标记
    assert.ok(r.items.some((i) => i.parentId === 'A' && i.childId === 'B' && /环路/.test(i.errors)));
    assert.ok(r.items.some((i) => i.parentId === 'B' && i.childId === 'A' && /环路/.test(i.errors)));
  }
});

test('批量：草稿在已有图上跨条形成多代环（顺序无关）', () => {
  // 已有 A -> B；草稿 B -> C、C -> A，合并后 A->B->C->A 成环
  const state = makeState(['A', 'B', 'C'], [['A', 'B']]);
  const r1 = validateEdgeBatch(state, [
    { parentId: 'B', childId: 'C' },
    { parentId: 'C', childId: 'A' },
  ]);
  const r2 = validateEdgeBatch(state, [
    { parentId: 'C', childId: 'A' },
    { parentId: 'B', childId: 'C' },
  ]);
  for (const r of [r1, r2]) {
    assert.equal(r.valid, false);
    // C -> A 是使环闭合的边，必须报环路
    assert.ok(r.items.some((i) => i.parentId === 'C' && i.childId === 'A' && /环路/.test(i.errors)));
  }
});

test('批量：合法的多代补全不会误报环路', () => {
  const state = makeState(['A', 'B', 'C']);
  const r = validateEdgeBatch(state, [
    { parentId: 'A', childId: 'B' },
    { parentId: 'B', childId: 'C' },
  ]);
  assert.equal(r.valid, true);
});

test('批量：已有图与草稿交叉成环也能检出（A->B 已存在，草稿 C->A、B->C）', () => {
  const state = makeState(['A', 'B', 'C'], [['A', 'B']]);
  const r = validateEdgeBatch(state, [
    { parentId: 'C', childId: 'A' },
    { parentId: 'B', childId: 'C' },
  ]);
  assert.equal(r.valid, false);
  assert.ok(r.items.some((i) => /环路/.test(i.errors)));
});

test('批量：一条错误不影响其他条目的错误也被完整报告', () => {
  const state = makeState(['P', 'C'], [['P', 'C']]);
  const r = validateEdgeBatch(state, [
    { parentId: 'P', childId: 'C' }, // 已存在
    { parentId: 'C', childId: 'C' }, // 自指
    { parentId: 'Nope', childId: 'C' }, // 父母不存在
  ]);
  assert.equal(r.valid, false);
  assert.ok(errorsOf(r, 0).some((m) => /已存在/.test(m)));
  assert.ok(errorsOf(r, 1).some((m) => /自指/.test(m)));
  assert.ok(errorsOf(r, 2).some((m) => /不存在/.test(m)));
  assert.match(r.error, /3 条/);
});

test('批量：index 与输入位置一一对应，供前端按草稿顺序展示', () => {
  const state = makeState(['A', 'B']);
  const r = validateEdgeBatch(state, [
    { parentId: 'A', childId: 'B' },
    { parentId: 'B', childId: 'A' },
  ]);
  assert.deepEqual(r.items.map((i) => i.index), [0, 1]);
});

test('批量：校验不修改原状态', () => {
  const state = makeState(['A', 'B']);
  const before = JSON.stringify(state.parentsOf);
  validateEdgeBatch(state, [
    { parentId: 'A', childId: 'B' },
    { parentId: 'B', childId: 'A' },
  ]);
  assert.equal(JSON.stringify(state.parentsOf), before);
});
