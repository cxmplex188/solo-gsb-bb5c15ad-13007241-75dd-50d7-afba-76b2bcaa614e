'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  validateEdge,
  findGenerationConflicts,
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

/** 按 祖先|后代 取一条矛盾，找不到则失败 */
function findConflict(result, ancestor, descendant) {
  const hit = result.conflicts.find(
    (c) => c.ancestorId === ancestor && c.descendantId === descendant,
  );
  assert.ok(hit, `应存在「${ancestor} → … → ${descendant}」的辈分矛盾`);
  return hit;
}

test('辈分矛盾：单条直线家谱没有矛盾', () => {
  const state = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  const r = findGenerationConflicts(state);
  assert.equal(r.total, 0);
  assert.equal(r.filtered, false);
  assert.deepEqual(r.conflicts, []);
});

test('辈分矛盾：同代两条不同路径（钻石图）不报警', () => {
  // G -> P1 -> X，G -> P2 -> X：X 到 G 恒为 2 代
  const state = makeState(['G', 'P1', 'P2', 'X']);
  add(state, 'G', 'P1');
  add(state, 'G', 'P2');
  add(state, 'P1', 'X');
  add(state, 'P2', 'X');
  const r = findGenerationConflicts(state);
  assert.equal(r.total, 0);
  assert.deepEqual(r.conflicts, []);
});

test('辈分矛盾：同一祖先有 2 代与 3 代两条路径时报警，并给出完整链', () => {
  // A 是 B、D 的父母；B 是 C 的父母；C、D 是 X 的父母。
  // X 到 A：X>C>B>A 为 3 代，X>D>A 为 2 代 → 矛盾。
  const state = makeState(['A', 'B', 'C', 'D', 'X']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'A', 'D');
  add(state, 'C', 'X');
  add(state, 'D', 'X');
  const r = findGenerationConflicts(state);
  assert.equal(r.total, 1);
  const c = findConflict(r, 'A', 'X');
  assert.equal(c.minGen, 2);
  assert.equal(c.maxGen, 3);
  assert.equal(c.diff, 1);
  // 链方向均为 祖先 → 子女 → … → 后代
  assert.deepEqual(c.shortestPath, ['A', 'D', 'X']);
  assert.deepEqual(c.longestPath, ['A', 'B', 'C', 'X']);
});

test('辈分矛盾：无关成员对（不构成祖先关系）不列出', () => {
  const state = makeState(['A', 'B', 'X', 'Y']);
  add(state, 'A', 'B');
  add(state, 'X', 'Y');
  const r = findGenerationConflicts(state);
  assert.equal(r.total, 0);
});

test('辈分矛盾：每条祖先/后代对只枚举一次，矛盾按代数差排序', () => {
  // A -> B -> C -> Z（长链），同时 A -> Z（短链）：
  // A-Z：3 代 vs 1 代（差 2）；A-C 恒 2 代、A-B 恒 1 代；
  // B-Z 恒 2 代。故只有 (A,Z) 一条矛盾。
  const state = makeState(['A', 'B', 'C', 'Z']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'Z');
  add(state, 'A', 'Z');
  const r = findGenerationConflicts(state);
  assert.equal(r.total, 1);
  const c = r.conflicts[0];
  assert.equal(c.ancestorId, 'A');
  assert.equal(c.descendantId, 'Z');
  assert.equal(c.minGen, 1);
  assert.equal(c.maxGen, 3);
  assert.equal(c.diff, 2);
  assert.deepEqual(c.shortestPath, ['A', 'Z']);
  assert.deepEqual(c.longestPath, ['A', 'B', 'C', 'Z']);
});

test('辈分矛盾：多条矛盾并存时按 diff 降序、同差按 maxGen 降序', () => {
  // 主链 A→B→C→D→X；X 的另一位父母是 B（侧链回接，X 恰有 D、B 两位父母）。
  //   (A,X)：最短 X→B→A 为 2 代，最长 X→D→C→B→A 为 4 代 → 差 2
  //   (B,X)：最短 1 代（X→B），最长 3 代（X→D→C→B）→ 差 2
  // 其余祖先对均为单一路径，不报警。
  const state = makeState(['A', 'B', 'C', 'D', 'X']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'D');
  add(state, 'D', 'X');
  add(state, 'B', 'X');
  const r = findGenerationConflicts(state);
  assert.equal(r.total, 2);
  assert.deepEqual(r.conflicts.map((c) => [c.ancestorId, c.descendantId, c.diff]), [
    ['A', 'X', 2],
    ['B', 'X', 2],
  ]);
  const a = findConflict(r, 'A', 'X');
  assert.equal(a.minGen, 2);
  assert.equal(a.maxGen, 4);
  assert.deepEqual(a.shortestPath, ['A', 'B', 'X']);
  assert.deepEqual(a.longestPath, ['A', 'B', 'C', 'D', 'X']);
  const b = findConflict(r, 'B', 'X');
  assert.equal(b.minGen, 1);
  assert.equal(b.maxGen, 3);
  assert.deepEqual(b.shortestPath, ['B', 'X']);
  assert.deepEqual(b.longestPath, ['B', 'C', 'D', 'X']);
});

test('辈分矛盾：按成员筛选只返回其参与的矛盾，total 仍为总数', () => {
  // 三个互不相连的组件，各恰有一条矛盾，代数差依次为 3、2、1：
  //   A→B→C→D→X 且 A→X：(A,X) 1 vs 4，差 3
  //   P→Q→R→S 且 P→S：(P,S) 1 vs 3，差 2
  //   F→G→H 且 F→H：(F,H) 1 vs 2，差 1
  const state = makeState(['A', 'B', 'C', 'D', 'X', 'P', 'Q', 'R', 'S', 'F', 'G', 'H']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'D');
  add(state, 'D', 'X');
  add(state, 'A', 'X');
  add(state, 'P', 'Q');
  add(state, 'Q', 'R');
  add(state, 'R', 'S');
  add(state, 'P', 'S');
  add(state, 'F', 'G');
  add(state, 'G', 'H');
  add(state, 'F', 'H');

  const all = findGenerationConflicts(state);
  assert.equal(all.total, 3);
  assert.deepEqual(all.conflicts.map((c) => [c.ancestorId, c.descendantId, c.diff]), [
    ['A', 'X', 3],
    ['P', 'S', 2],
    ['F', 'H', 1],
  ]);

  // 以后代 X 筛选：只返回其作为后代的 1 条
  const onlyX = findGenerationConflicts(state, 'X');
  assert.equal(onlyX.filtered, true);
  assert.equal(onlyX.total, 3);
  assert.equal(onlyX.conflicts.length, 1);
  assert.deepEqual(onlyX.conflicts.map((c) => [c.ancestorId, c.descendantId]), [['A', 'X']]);

  // 以祖先 A 筛选：A 作为祖先参与 1 条
  const onlyA = findGenerationConflicts(state, 'A');
  assert.equal(onlyA.conflicts.length, 1);
  assert.equal(onlyA.conflicts[0].ancestorId, 'A');

  // 独立组件中的矛盾
  const onlyP = findGenerationConflicts(state, 'P');
  assert.equal(onlyP.conflicts.length, 1);
  const c = findConflict(onlyP, 'P', 'S');
  assert.equal(c.minGen, 1);
  assert.equal(c.maxGen, 3);
  assert.deepEqual(c.longestPath, ['P', 'Q', 'R', 'S']);

  // 未参与任何矛盾的成员：过滤结果为空但 total 仍是总数
  const onlyQ = findGenerationConflicts(state, 'Q');
  assert.equal(onlyQ.total, 3);
  assert.deepEqual(onlyQ.conflicts, []);
});

test('辈分矛盾：筛选到不存在的成员返回错误', () => {
  const state = makeState(['A']);
  const r = findGenerationConflicts(state, 'nope');
  assert.match(r.error, /成员不存在/);
});

test('辈分矛盾：代数一致的平行关系（再婚同辈分继亲）不报警', () => {
  // X 有两条同长度父系链到 F，且 F 同时也是 Y 的父母：构造一个 2 代恒定的交叉
  // F -> P1 -> X；F -> P2 -> X；F -> Y（Y 是 P1/P2 的同代弟妹）。
  // X 到 F 恒 2 代，无矛盾；Y 到 F 恒 1 代，无矛盾。
  const state = makeState(['F', 'P1', 'P2', 'X', 'Y']);
  add(state, 'F', 'P1');
  add(state, 'F', 'P2');
  add(state, 'P1', 'X');
  add(state, 'P2', 'X');
  add(state, 'F', 'Y');
  const r = findGenerationConflicts(state);
  assert.equal(r.total, 0);
});
