'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  validateEdge,
  previewMemberDeletion,
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

/** 按「祖先|后代」取一条明细，找不到则失败 */
function itemOf(items, ancestor, descendant) {
  const hit = items.find((i) => i.ancestorId === ancestor && i.descendantId === descendant);
  assert.ok(hit, `明细中应包含 ${ancestor} -> ${descendant}`);
  return hit;
}

test('删除影响预览：直链中删除中间成员，其上游→下游成员对断联（删除后链为空）', () => {
  // A→B→C：删除 B 后 (A,C) 唯一通路被移除；A、C 仍在谱
  const state = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');

  const r = previewMemberDeletion(state, 'B');
  assert.equal(r.error, undefined);
  assert.equal(r.memberId, 'B');
  assert.equal(r.removedEdgeCount, 2); // A→B 与 B→C
  assert.equal(r.remainingMemberCount, 2);
  // 祖先或后代是 B 的成员对随其离谱，不参与比较；只剩 (A,C)
  assert.equal(r.comparedCount, 1);
  assert.equal(r.disconnectedCount, 1);
  assert.equal(r.lengthenedCount, 0);
  assert.equal(r.unaffectedCount, 0);
  assert.equal(r.disconnected.length, 1);

  const ac = r.disconnected[0];
  assert.equal(ac.ancestorId, 'A');
  assert.equal(ac.descendantId, 'C');
  assert.equal(ac.before.minGen, 2);
  assert.deepEqual(ac.before.shortestPath, ['A', 'B', 'C']);
  assert.equal(ac.after, null); // 删除后不可达：成员链为空
});

test('删除影响预览：仍有同代替代路径的成员对不报断联（多路径按最短代数判定）', () => {
  // 钻石：A→B→D、A→C→D；删除 B 后 (A,D) 仍有 A→C→D 这条同代（2 代）路径
  const state = makeState(['A', 'B', 'C', 'D']);
  add(state, 'A', 'B');
  add(state, 'B', 'D');
  add(state, 'A', 'C');
  add(state, 'C', 'D');

  const r = previewMemberDeletion(state, 'B');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.disconnected, []);
  assert.deepEqual(r.lengthened, []);
  // (A,D) 最短代数仍是 2；(A,C)、(C,D) 不经 B
  assert.equal(r.unaffectedCount, 3);
  assert.equal(r.comparedCount, 3);
  assert.equal(r.removedEdgeCount, 2);
});

test('删除影响预览：最短链经过被删成员、只剩更长替代路径时列入代数增加', () => {
  // 短链 A→B→D（2 代），长链 A→C→E→D（3 代）；删除 B 后 (A,D) 仍可达但最短变为 3 代
  const state = makeState(['A', 'B', 'C', 'D', 'E']);
  add(state, 'A', 'B');
  add(state, 'B', 'D');
  add(state, 'A', 'C');
  add(state, 'C', 'E');
  add(state, 'E', 'D');

  const r = previewMemberDeletion(state, 'B');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.disconnected, []);
  assert.equal(r.lengthened.length, 1);
  const ad = r.lengthened[0];
  assert.equal(ad.ancestorId, 'A');
  assert.equal(ad.descendantId, 'D');
  assert.equal(ad.before.minGen, 2);
  assert.deepEqual(ad.before.shortestPath, ['A', 'B', 'D']);
  assert.equal(ad.after.minGen, 3);
  assert.deepEqual(ad.after.shortestPath, ['A', 'C', 'E', 'D']);
  assert.equal(ad.genIncrease, 1);
  // 其余成员对不受影响：(A,C)、(C,E)、(E,D)、(A,E)、(C,D)
  assert.equal(r.unaffectedCount, 5);
});

test('删除影响预览：祖先侧与后代侧的成员对分别按断联 / 不受影响归类', () => {
  // A→B→C→D，删除 B：(A,C)、(A,D) 断联；(C,D) 不经过 B，不受影响
  const state = makeState(['A', 'B', 'C', 'D']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'D');

  const r = previewMemberDeletion(state, 'B');
  assert.equal(r.disconnectedCount, 2);
  const keys = r.disconnected.map((i) => `${i.ancestorId}->${i.descendantId}`).sort();
  assert.deepEqual(keys, ['A->C', 'A->D']);
  // 断联明细的变更前链保留被删成员（删除前其仍在谱）
  assert.deepEqual(itemOf(r.disconnected, 'A', 'D').before.shortestPath, ['A', 'B', 'C', 'D']);
  assert.equal(itemOf(r.disconnected, 'A', 'C').after, null);
  assert.equal(r.lengthenedCount, 0);
  assert.equal(r.unaffectedCount, 1); // (C,D)
  assert.equal(r.comparedCount, 3);
});

test('删除影响预览：删除孤立成员与叶子成员均无受影响成员对', () => {
  const state = makeState(['A', 'B', 'C', 'X']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');

  // X 与任何人都无关系：删除后无成员对变化
  let r = previewMemberDeletion(state, 'X');
  assert.equal(r.removedEdgeCount, 0);
  assert.equal(r.comparedCount, 3); // (A,B)、(A,C)、(B,C)
  assert.equal(r.disconnectedCount, 0);
  assert.equal(r.lengthenedCount, 0);
  assert.equal(r.unaffectedCount, 3);

  // 删除叶子 C：没有以其为祖先的成员对，不受影响
  r = previewMemberDeletion(state, 'C');
  assert.equal(r.removedEdgeCount, 1);
  assert.deepEqual(r.disconnected, []);
  assert.deepEqual(r.lengthened, []);
  assert.equal(r.unaffectedCount, 1); // 仅剩 (A,B)
});

test('删除影响预览：被删成员的每位前配偶→其共同子女仍可达，不计断联', () => {
  // 父母 P1、P2 都为 C 的父母（钻石上缘）：P1→C、P2→C，GP→P1
  // 删除 P2 不影响 (GP,C) 之外的任何对；(P2,C) 因端点离谱不参与比较
  const state = makeState(['GP', 'P1', 'P2', 'C']);
  add(state, 'GP', 'P1');
  add(state, 'P1', 'C');
  add(state, 'P2', 'C');

  const r = previewMemberDeletion(state, 'P2');
  assert.deepEqual(r.disconnected, []);
  assert.deepEqual(r.lengthened, []);
  // (GP,P1)、(GP,C)、(P1,C) 均不受影响
  assert.equal(r.unaffectedCount, 3);
});

test('删除影响预览：多对断联按变更前最短代数降序、同档按成员 ID 排序', () => {
  // R→A→B→X→C→D，删除 X：(X,*)、(*,X) 离谱；
  // 断联对：(A,C) 3 代、(A,D) 4 代、(B,C) 2 代、(B,D) 3 代、(R,C) 4 代、(R,D) 5 代
  const state = makeState(['R', 'A', 'B', 'X', 'C', 'D']);
  add(state, 'R', 'A');
  add(state, 'A', 'B');
  add(state, 'B', 'X');
  add(state, 'X', 'C');
  add(state, 'C', 'D');

  const r = previewMemberDeletion(state, 'X');
  assert.equal(r.disconnectedCount, 6);
  assert.deepEqual(
    r.disconnected.map((i) => `${i.ancestorId}->${i.descendantId}`),
    ['R->D', 'A->D', 'R->C', 'A->C', 'B->D', 'B->C'],
  );
});

test('删除影响预览：成员不存在或参数缺失时说明原因', () => {
  const state = makeState(['A', 'B']);
  add(state, 'A', 'B');

  assert.match(previewMemberDeletion(state, 'nope').error, /成员不存在/);
  assert.match(previewMemberDeletion(state, '').error, /成员不存在/);
  assert.match(previewMemberDeletion(state, null).error, /成员不存在/);
  assert.match(previewMemberDeletion(state, undefined).error, /成员不存在/);
});

test('删除影响预览：纯函数构造假设图，当前家谱保持不变', () => {
  const state = makeState(['A', 'B', 'C', 'D', 'E']);
  add(state, 'A', 'B');
  add(state, 'B', 'D');
  add(state, 'A', 'C');
  add(state, 'C', 'E');
  add(state, 'E', 'D');
  const snapshot = JSON.stringify({ members: state.members, parentsOf: state.parentsOf });

  previewMemberDeletion(state, 'B');
  previewMemberDeletion(state, 'A');
  previewMemberDeletion(state, 'nope'); // 失败路径

  assert.equal(
    JSON.stringify({ members: state.members, parentsOf: state.parentsOf }),
    snapshot,
    '预览不得修改当前家谱（不落盘的只读假设图）',
  );
});

test('删除影响预览：被删成员是所有上游到下游通路的必经节点时全部断联', () => {
  // 两条上游路径都经过 X：A→X→D、B→X→D；删除 X 后 (A,D)、(B,D) 均断联
  const state = makeState(['A', 'B', 'X', 'D']);
  add(state, 'A', 'X');
  add(state, 'B', 'X');
  add(state, 'X', 'D');

  const r = previewMemberDeletion(state, 'X');
  assert.equal(r.disconnectedCount, 2);
  const keys = r.disconnected.map((i) => `${i.ancestorId}->${i.descendantId}`).sort();
  assert.deepEqual(keys, ['A->D', 'B->D']);
  for (const item of r.disconnected) assert.equal(item.after, null);
  assert.equal(r.unaffectedCount, 0);
});
