'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  validateEdge,
  ancestorProfiles,
  previewEdgeImpact,
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

test('代际档案：链式家谱的祖先 min/max 代数与成员链', () => {
  const state = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');

  const profiles = ancestorProfiles(state, 'C');
  assert.equal(profiles.size, 2);
  const a = profiles.get('A');
  assert.equal(a.minGen, 2);
  assert.equal(a.maxGen, 2);
  assert.deepEqual(a.shortestPath, ['A', 'B', 'C']);
  assert.deepEqual(a.longestPath, ['A', 'B', 'C']);
  assert.equal(profiles.get('B').minGen, 1);

  // 没有祖先的成员返回空档案
  assert.equal(ancestorProfiles(state, 'A').size, 0);
});

test('影响预览·新增：合法新增产生新矛盾，给出变更前一致档案与变更后双链', () => {
  // 直链 A→B→C→X；新增 B→X 后，(A,X) 出现 2/3 代、(B,X) 出现 1/2 代两条矛盾
  const state = makeState(['A', 'B', 'C', 'X']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'X');

  const r = previewEdgeImpact(state, { action: 'add', parentId: 'B', childId: 'X' });
  assert.equal(r.error, undefined);
  assert.equal(r.action, 'add');
  assert.equal(r.beforeTotal, 0);
  assert.equal(r.afterTotal, 2);
  assert.equal(r.unchangedCount, 0);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.changed, []);

  assert.equal(r.added.length, 2);
  // 新增矛盾按变更后代数差排序，同差按成员 ID：(A,X) 在前
  const item = r.added[0];
  assert.equal(item.ancestorId, 'A');
  assert.equal(item.descendantId, 'X');
  // 变更前：两人本有祖先关系且辈分一致（3 代）
  assert.equal(item.before.minGen, 3);
  assert.equal(item.before.maxGen, 3);
  assert.deepEqual(item.before.shortestPath, ['A', 'B', 'C', 'X']);
  // 变更后：最短 2 代 / 最长 3 代，各附一条完整成员链
  assert.equal(item.after.minGen, 2);
  assert.equal(item.after.maxGen, 3);
  assert.deepEqual(item.after.shortestPath, ['A', 'B', 'X']);
  assert.deepEqual(item.after.longestPath, ['A', 'B', 'C', 'X']);

  // (B,X)：变更前一致（2 代），变更后 1/2 代
  const bx = r.added[1];
  assert.equal(bx.ancestorId, 'B');
  assert.equal(bx.descendantId, 'X');
  assert.equal(bx.before.minGen, 2);
  assert.equal(bx.before.maxGen, 2);
  assert.equal(bx.after.minGen, 1);
  assert.equal(bx.after.maxGen, 2);
  assert.deepEqual(bx.after.shortestPath, ['B', 'X']);
  assert.deepEqual(bx.after.longestPath, ['B', 'C', 'X']);
});

test('影响预览·新增：沿用建边校验，失败时说明原因且不做对比', () => {
  const state = makeState(['A', 'B', 'C', 'D', 'X']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'X');
  add(state, 'D', 'X'); // X 已有 C、D 两位父母

  // 重复边
  let r = previewEdgeImpact(state, { action: 'add', parentId: 'A', childId: 'B' });
  assert.match(r.error, /重复边/);
  assert.equal(r.added, undefined);

  // 自指
  r = previewEdgeImpact(state, { action: 'add', parentId: 'A', childId: 'A' });
  assert.match(r.error, /自指/);

  // 父母上限
  r = previewEdgeImpact(state, { action: 'add', parentId: 'A', childId: 'X' });
  assert.match(r.error, /至多 2 位父母/);

  // 祖先环路
  r = previewEdgeImpact(state, { action: 'add', parentId: 'X', childId: 'A' });
  assert.match(r.error, /祖先环路/);

  // 成员不存在
  r = previewEdgeImpact(state, { action: 'add', parentId: 'A', childId: 'nope' });
  assert.match(r.error, /子女成员不存在/);
  r = previewEdgeImpact(state, { action: 'add', parentId: 'nope', childId: 'A' });
  assert.match(r.error, /父母成员不存在/);
});

test('影响预览·移除：移除侧链使矛盾消失，变更后档案为辈分一致', () => {
  // A→B→C→X 且 B→X：(A,X) 2/3 代、(B,X) 1/2 代；移除 B→X 后恢复直链
  const state = makeState(['A', 'B', 'C', 'X']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'X');
  add(state, 'B', 'X');

  const r = previewEdgeImpact(state, { action: 'remove', parentId: 'B', childId: 'X' });
  assert.equal(r.error, undefined);
  assert.equal(r.beforeTotal, 2);
  assert.equal(r.afterTotal, 0);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.changed, []);

  assert.equal(r.removed.length, 2);
  const item = r.removed[0];
  assert.equal(item.ancestorId, 'A');
  assert.equal(item.descendantId, 'X');
  assert.equal(item.before.minGen, 2);
  assert.equal(item.before.maxGen, 3);
  assert.deepEqual(item.before.shortestPath, ['A', 'B', 'X']);
  assert.deepEqual(item.before.longestPath, ['A', 'B', 'C', 'X']);
  // 变更后两人仍是祖先—后代，但辈分一致（3 代）
  assert.equal(item.after.minGen, 3);
  assert.equal(item.after.maxGen, 3);
  assert.deepEqual(item.after.shortestPath, ['A', 'B', 'C', 'X']);

  // (B,X)：变更前 1/2 代，变更后一致（2 代）
  const bx = r.removed[1];
  assert.equal(bx.ancestorId, 'B');
  assert.equal(bx.descendantId, 'X');
  assert.equal(bx.before.minGen, 1);
  assert.equal(bx.before.maxGen, 2);
  assert.equal(bx.after.minGen, 2);
  assert.equal(bx.after.maxGen, 2);
  assert.deepEqual(bx.after.shortestPath, ['B', 'C', 'X']);
});

test('影响预览·移除：移除唯一通路后两人不再存在祖先关系（after 为 null）', () => {
  // A→B→C、A→C（(A,C) 矛盾），C→X 使 (A,X) 也是矛盾；移除 C→X 后 X 无祖先
  const state = makeState(['A', 'B', 'C', 'X']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'A', 'C');
  add(state, 'C', 'X');

  const r = previewEdgeImpact(state, { action: 'remove', parentId: 'C', childId: 'X' });
  assert.equal(r.error, undefined);
  assert.equal(r.beforeTotal, 2); // (A,C) 与 (A,X)
  assert.equal(r.afterTotal, 1); // 仅剩 (A,C)
  assert.equal(r.unchangedCount, 1); // (A,C) 范围不变
  assert.equal(r.removed.length, 1);
  const item = r.removed[0];
  assert.equal(item.ancestorId, 'A');
  assert.equal(item.descendantId, 'X');
  assert.equal(item.before.minGen, 2);
  assert.equal(item.before.maxGen, 3);
  assert.equal(item.after, null); // 变更后两人不存在祖先关系
});

test('影响预览·移除：目标关系不存在时说明原因', () => {
  const state = makeState(['A', 'B']);
  add(state, 'A', 'B');
  const r = previewEdgeImpact(state, { action: 'remove', parentId: 'B', childId: 'A' });
  assert.match(r.error, /关系不存在/);
  assert.equal(r.added, undefined);
});

test('影响预览·新增：矛盾总数不变但代数范围变化（不能只比较总数）', () => {
  // A→B→C→D→X 且 A→D：(A,X) 2/4、(A,D) 1/3 两条矛盾。
  // 新增 A→X 后 (A,X) 变为 1/4、(A,D) 不变：总数 2→2，但 (A,X) 范围已变化。
  const state = makeState(['A', 'B', 'C', 'D', 'X']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'D');
  add(state, 'D', 'X');
  add(state, 'A', 'D');

  const r = previewEdgeImpact(state, { action: 'add', parentId: 'A', childId: 'X' });
  assert.equal(r.error, undefined);
  assert.equal(r.beforeTotal, 2);
  assert.equal(r.afterTotal, 2); // 总数相同
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.equal(r.unchangedCount, 1); // (A,D) 范围不变

  assert.equal(r.changed.length, 1);
  const item = r.changed[0];
  assert.equal(item.ancestorId, 'A');
  assert.equal(item.descendantId, 'X');
  assert.equal(item.before.minGen, 2);
  assert.equal(item.before.maxGen, 4);
  assert.deepEqual(item.before.shortestPath, ['A', 'D', 'X']);
  assert.deepEqual(item.before.longestPath, ['A', 'B', 'C', 'D', 'X']);
  assert.equal(item.after.minGen, 1);
  assert.equal(item.after.maxGen, 4);
  assert.deepEqual(item.after.shortestPath, ['A', 'X']);
  assert.deepEqual(item.after.longestPath, ['A', 'B', 'C', 'D', 'X']);
});

test('影响预览·移除：移除短链使代数范围收窄', () => {
  // 同上一家谱再加 A→X：(A,X) 1/4；移除 A→X 后回到 2/4
  const state = makeState(['A', 'B', 'C', 'D', 'X']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'D');
  add(state, 'D', 'X');
  add(state, 'A', 'D');
  add(state, 'A', 'X');

  const r = previewEdgeImpact(state, { action: 'remove', parentId: 'A', childId: 'X' });
  assert.equal(r.error, undefined);
  assert.equal(r.beforeTotal, 2);
  assert.equal(r.afterTotal, 2);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.equal(r.changed.length, 1);
  const item = r.changed[0];
  assert.equal(item.ancestorId, 'A');
  assert.equal(item.descendantId, 'X');
  assert.equal(item.before.minGen, 1);
  assert.equal(item.before.maxGen, 4);
  assert.equal(item.after.minGen, 2);
  assert.equal(item.after.maxGen, 4);
  assert.equal(r.unchangedCount, 1); // (A,D)
});

test('影响预览：非法变更类型或缺少成员时说明原因', () => {
  const state = makeState(['A', 'B']);
  add(state, 'A', 'B');

  let r = previewEdgeImpact(state, { action: 'toggle', parentId: 'A', childId: 'B' });
  assert.match(r.error, /变更类型/);

  r = previewEdgeImpact(state, { action: 'add', parentId: 'A' });
  assert.match(r.error, /请选择父母与子女/);

  r = previewEdgeImpact(state, null);
  assert.match(r.error, /变更类型/);
});

test('影响预览：无矛盾的变更返回空明细而非只报总数', () => {
  const state = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');
  const r = previewEdgeImpact(state, { action: 'add', parentId: 'B', childId: 'C' });
  assert.equal(r.error, undefined);
  assert.equal(r.beforeTotal, 0);
  assert.equal(r.afterTotal, 0);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.changed, []);
  assert.equal(r.unchangedCount, 0);
});

test('影响预览：纯函数构造假设图，当前家谱保持不变', () => {
  const state = makeState(['A', 'B', 'C', 'X']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'X');
  const snapshot = JSON.stringify({ members: state.members, parentsOf: state.parentsOf });

  previewEdgeImpact(state, { action: 'add', parentId: 'B', childId: 'X' });
  previewEdgeImpact(state, { action: 'remove', parentId: 'C', childId: 'X' });
  previewEdgeImpact(state, { action: 'add', parentId: 'X', childId: 'A' }); // 校验失败路径

  assert.equal(
    JSON.stringify({ members: state.members, parentsOf: state.parentsOf }),
    snapshot,
    '预览不得修改当前家谱（不落盘的假设图）',
  );
});
