'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createState, validateEdge, previewMergeMembers } = require('../server/familyGraph');

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

const edgeSet = (r) => new Set(r.edges.map((e) => `${e.parentId}->${e.childId}`));

test('合并：结构非法（成员不存在 / 同一人）返回 error 且无 valid 字段', () => {
  const state = makeState(['A', 'B']);
  assert.match(previewMergeMembers(state, 'X', 'B').error, /保留成员不存在/);
  assert.match(previewMergeMembers(state, 'A', 'X').error, /被合并成员不存在/);
  assert.match(previewMergeMembers(state, 'A', 'A').error, /同一人/);
});

test('合并：替换被合并成员在全部关系中的 ID 并保留保留成员姓名语义', () => {
  // B 是 C 的父母、D 的子女；把 B 并入 A 后：A->C、D->A
  const state = makeState(['A', 'B', 'C', 'D'], [['B', 'C'], ['D', 'B']]);
  const r = previewMergeMembers(state, 'A', 'B');
  assert.equal(r.valid, true);
  assert.deepEqual([...edgeSet(r)].sort(), ['A->C', 'D->A']);
  assert.equal(r.affectedEdgeCount, 2);
  assert.equal(r.removedDuplicateCount, 0);
  assert.equal(r.originalEdgeCount, 2);
  assert.ok(r.edges.every((e) => e.replaced));
});

test('合并：完全相同的关系替换后去重并计数', () => {
  // A->C 与 B->C 合并 B 入 A 后重复；B->D 与 A->D 同理
  const state = makeState(['A', 'B', 'C', 'D'], [['A', 'C'], ['B', 'C'], ['A', 'D'], ['B', 'D']]);
  const r = previewMergeMembers(state, 'A', 'B');
  assert.equal(r.valid, true);
  assert.deepEqual([...edgeSet(r)].sort(), ['A->C', 'A->D']);
  assert.equal(r.removedDuplicateCount, 2);
  assert.equal(r.affectedEdgeCount, 2);
});

test('合并：无冲突时 conflicts 为空且不修改原状态', () => {
  const state = makeState(['A', 'B', 'C'], [['A', 'C']]);
  const before = JSON.stringify({ members: state.members, parentsOf: state.parentsOf });
  const r = previewMergeMembers(state, 'A', 'B');
  assert.equal(r.valid, true);
  assert.deepEqual(r.conflicts, []);
  assert.equal(JSON.stringify({ members: state.members, parentsOf: state.parentsOf }), before);
  // B 无任何关系：关系原样保留
  assert.deepEqual([...edgeSet(r)], ['A->C']);
  assert.equal(r.affectedEdgeCount, 0);
});

test('合并冲突：自指（已有 A->B，把 B 并入 A）', () => {
  const state = makeState(['A', 'B'], [['A', 'B']]);
  const r = previewMergeMembers(state, 'A', 'B');
  assert.equal(r.valid, false);
  assert.ok(r.error.includes('冲突'));
  const self = r.conflicts.filter((c) => c.type === 'self');
  assert.equal(self.length, 1);
  assert.equal(self[0].parentId, 'A');
  // 自指边不进入合并结果
  assert.deepEqual(r.edges, []);
  assert.equal(r.removedDuplicateCount, 0);
});

test('合并冲突：自指也可出现在被合并成员作为子女时（B->A，B 并入 A）', () => {
  const state = makeState(['A', 'B'], [['B', 'A']]);
  const r = previewMergeMembers(state, 'A', 'B');
  assert.equal(r.valid, false);
  assert.equal(r.conflicts.filter((c) => c.type === 'self').length, 1);
});

test('合并冲突：去重后子女超过两位父母（防御性检查，直接构造脏邻接表）', () => {
  // 正常 API 保证每名子女至多两位父母，合并映射不会使父母基数增加；
  // 该检查面向绕过 API 的数据（例如外部工具写入），这里直接构造 3 父母邻接表。
  const state = makeState(['A', 'B', 'D', 'E', 'C']);
  state.parentsOf.C = ['B', 'D', 'E'];
  const r = previewMergeMembers(state, 'A', 'B');
  assert.equal(r.valid, false);
  const t = r.conflicts.find((c) => c.type === 'too-many-parents');
  assert.ok(t);
  assert.equal(t.childId, 'C');
  assert.equal(t.count, 3);
  assert.deepEqual(t.parentIds.sort(), ['A', 'D', 'E']);
});

test('合并无冲突：两位父母在去重后合并为同一位，不报错', () => {
  // C 的父母 A、B；把 B 并入 A 后只剩 A 一位父母
  const state = makeState(['A', 'B', 'C'], [['A', 'C'], ['B', 'C']]);
  const r = previewMergeMembers(state, 'A', 'B');
  assert.equal(r.valid, true);
  assert.deepEqual([...edgeSet(r)], ['A->C']);
  assert.equal(r.removedDuplicateCount, 1);
});

test('合并冲突：祖先环路（把 A 并入 C 后 C->B 与 B->C 成环）', () => {
  // 已有 A->B、B->C；把 A 并入 C：C->B、B->C 成环
  const state = makeState(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  const r = previewMergeMembers(state, 'C', 'A');
  assert.equal(r.valid, false);
  const cycles = r.conflicts.filter((c) => c.type === 'cycle');
  assert.ok(cycles.some((c) => c.parentId === 'C' && c.childId === 'B'));
  assert.ok(cycles.some((c) => c.parentId === 'B' && c.childId === 'C'));
});

test('合并冲突：跨三代的环也能检出', () => {
  // D->A, A->B, B->C；把 D 并入 C：C->A, A->B, B->C 成环
  const state = makeState(['A', 'B', 'C', 'D'], [['D', 'A'], ['A', 'B'], ['B', 'C']]);
  const r = previewMergeMembers(state, 'C', 'D');
  assert.equal(r.valid, false);
  assert.ok(r.conflicts.some((c) => c.type === 'cycle'));
});

test('合并：合法的跨代身份合并不会误报环路', () => {
  // B->C、C->D，把孤立成员 A 并入 B：A->C、C->D，无环
  const state = makeState(['A', 'B', 'C', 'D'], [['B', 'C'], ['C', 'D']]);
  const r = previewMergeMembers(state, 'A', 'B');
  assert.equal(r.valid, true);
  assert.deepEqual([...edgeSet(r)].sort(), ['A->C', 'C->D']);
});

test('合并：replaced 只标记源自涉及被合并成员的关系', () => {
  const state = makeState(['A', 'B', 'C', 'D'], [['A', 'C'], ['B', 'D']]);
  const r = previewMergeMembers(state, 'A', 'B');
  const flags = new Map(r.edges.map((e) => [`${e.parentId}->${e.childId}`, e.replaced]));
  assert.equal(flags.get('A->C'), false);
  assert.equal(flags.get('A->D'), true);
});
