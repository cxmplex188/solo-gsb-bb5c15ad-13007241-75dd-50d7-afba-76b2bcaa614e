'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-'));
  return path.join(dir, 'family.json');
}

test('成员与关系写入后可被新 store 完整恢复（持久化往返）', () => {
  const file = tmpFile();

  const store1 = createStore(file);
  const a = store1.addMember('甲').member;
  const b = store1.addMember('乙').member;
  const c = store1.addMember('丙').member;
  assert.equal(store1.addEdge(a.id, b.id).error, null);
  assert.equal(store1.addEdge(b.id, c.id).error, null);

  // 落盘内容为边表格式
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(raw.edges));
  assert.equal(raw.edges.length, 2);

  // 模拟进程重启
  const store2 = createStore(file);
  const data = store2.list();
  assert.equal(data.members.length, 3);
  assert.equal(data.edges.length, 2);
  const byId = Object.fromEntries(data.members.map((m) => [m.name, m.id]));
  assert.deepEqual(
    data.edges.map((e) => [e.parentId, e.childId]).sort(),
    [[byId.甲, byId.乙], [byId.乙, byId.丙]].sort(),
  );
});

test('删除成员级联清除相关关系并持久化', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  store.addEdge(a.id, b.id);

  assert.equal(store.deleteMember(a.id).error, null);
  const reloaded = createStore(file).list();
  assert.equal(reloaded.members.length, 1);
  assert.equal(reloaded.edges.length, 0);
});

test('非法输入与规则拒绝', () => {
  const store = createStore(tmpFile());
  assert.ok(store.addMember('  ').error);
  const a = store.addMember('A').member;
  assert.ok(store.addEdge(a.id, 'missing-id').error);
  assert.equal(store.addEdge(a.id, a.id).error.includes('自指'), true);
});

test('手工编辑出的环路数据文件在加载时被净化为 DAG', () => {
  const file = tmpFile();
  // A -> B -> C -> A 为环路；另含一条合法边 C -> D
  const raw = {
    maxMembers: 30,
    members: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }, { id: 'D', name: 'D' }],
    edges: [
      { parentId: 'A', childId: 'B' },
      { parentId: 'B', childId: 'C' },
      { parentId: 'C', childId: 'A' }, // 闭环边，应被丢弃
      { parentId: 'C', childId: 'D' },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(raw));
  const store = createStore(file);
  const data = store.list();
  assert.equal(data.members.length, 4);
  // 闭环边 C->A 被移除；其余边保留
  assert.deepEqual(
    data.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
    ['A->B', 'B->C', 'C->D'],
  );
  // 净化后的图查询不死循环且结果正确：B 是 D 的祖先，最近共同祖先为 B 本人（2+0 代）
  const { findCommonAncestors } = require('../server/familyGraph');
  const r = findCommonAncestors(store.getState(), 'D', 'B');
  assert.equal(r.minTotalGen, 2);
  assert.deepEqual(r.ancestors.map((a) => a.id), ['B']);
  assert.equal(r.ancestors[0].genA, 2);
  assert.equal(r.ancestors[0].genB, 0);
});

test('家谱版本：初始为 0，每次成功变更 +1', () => {
  const store = createStore(tmpFile());
  assert.equal(store.getVersion(), 0);
  assert.equal(store.list().version, 0);
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  assert.equal(store.getVersion(), 2);
  store.addEdge(a.id, b.id);
  assert.equal(store.getVersion(), 3);
  store.deleteEdge(a.id, b.id);
  assert.equal(store.getVersion(), 4);
});

test('版本号持久化到数据文件并在重启后延续', () => {
  const file = tmpFile();
  const s1 = createStore(file);
  const a = s1.addMember('A').member;
  const b = s1.addMember('B').member;
  s1.addEdge(a.id, b.id);
  assert.equal(s1.getVersion(), 3);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 3);

  const s2 = createStore(file);
  assert.equal(s2.getVersion(), 3);
  s2.addMember('C');
  assert.equal(s2.getVersion(), 4);
});

test('批量提交：合法批次一次写入、版本只推进一次', () => {
  const store = createStore(tmpFile());
  const ids = ['A', 'B', 'C'].map((n) => store.addMember(n).member.id);
  const baseVersion = store.getVersion();

  const preview = store.validateEdgeBatch([
    { parentId: ids[0], childId: ids[1] },
    { parentId: ids[1], childId: ids[2] },
  ]);
  assert.equal(preview.valid, true);

  const result = store.commitEdges(
    [
      { parentId: ids[0], childId: ids[1] },
      { parentId: ids[1], childId: ids[2] },
    ],
    baseVersion,
  );
  assert.equal(result.error, null);
  assert.equal(store.list().edges.length, 2);
  assert.equal(store.getVersion(), baseVersion + 1);
});

test('批量提交：任何一条无效则整批不写入，版本不变', () => {
  const store = createStore(tmpFile());
  const ids = ['A', 'B', 'C'].map((n) => store.addMember(n).member.id);
  const v = store.getVersion();
  const result = store.commitEdges(
    [
      { parentId: ids[0], childId: ids[1] }, // 合法
      { parentId: ids[2], childId: ids[2] }, // 自指，非法
    ],
    v,
  );
  assert.ok(result.error);
  assert.equal(store.list().edges.length, 0);
  assert.equal(store.getVersion(), v);
});

test('批量提交：跨条成环整批拒绝且零写入', () => {
  const store = createStore(tmpFile());
  const ids = ['A', 'B'].map((n) => store.addMember(n).member.id);
  const v = store.getVersion();
  const result = store.commitEdges(
    [
      { parentId: ids[0], childId: ids[1] },
      { parentId: ids[1], childId: ids[0] },
    ],
    v,
  );
  assert.ok(result.error);
  assert.equal(store.list().edges.length, 0);
  assert.equal(store.getVersion(), v);
});

test('乐观并发：预检后家谱变化，携带旧版本提交被 409 拒绝且零写入', () => {
  const store = createStore(tmpFile());
  const ids = ['A', 'B', 'C'].map((n) => store.addMember(n).member.id);
  const previewVersion = store.getVersion();

  // 预检之后，其他操作改动了家谱
  store.addEdge(ids[0], ids[1]);
  assert.notEqual(store.getVersion(), previewVersion);

  const result = store.commitEdges([{ parentId: ids[1], childId: ids[2] }], previewVersion);
  assert.equal(result.status, 409);
  assert.match(result.error, /重新预检/);
  assert.equal(result.currentVersion, store.getVersion());
  // 提交未写入：只有预检之后那条单条关系
  assert.equal(store.list().edges.length, 1);
});

test('批量提交：缺少版本号被拒绝', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  const result = store.commitEdges([{ parentId: a.id, childId: b.id }], undefined);
  assert.equal(result.status, 400);
  assert.match(result.error, /版本号/);
  assert.equal(store.list().edges.length, 0);
});

/* ---------------- 合并重复成员 ---------------- */

test('合并提交：成功时保留保留成员姓名、去重关系、删除被合并成员，版本 +1、一次落盘', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addMember('张三').member;
  const b = store.addMember('张叁').member;
  const c = store.addMember('张小').member;
  store.addEdge(a.id, c.id);
  store.addEdge(b.id, c.id); // 与上一条在合并后重复
  const baseVersion = store.getVersion();

  const preview = store.previewMerge(a.id, b.id);
  assert.equal(preview.valid, true);
  assert.equal(preview.removedDuplicateCount, 1);
  assert.equal(preview.version, undefined); // 纯预览不含版本号（由路由补充）

  const result = store.commitMerge(a.id, b.id, baseVersion);
  assert.equal(result.error, null);
  const data = store.list();
  assert.equal(data.members.length, 2);
  const survivor = data.members.find((m) => m.id === a.id);
  assert.equal(survivor.name, '张三'); // 保留原姓名
  assert.ok(!data.members.some((m) => m.id === b.id)); // 被合并成员已删除
  assert.deepEqual(data.edges, [{ parentId: a.id, childId: c.id }]);
  assert.equal(store.getVersion(), baseVersion + 1); // 版本只加一

  // 只落盘一次：重启后状态一致且版本延续
  const reloaded = createStore(file).list();
  assert.equal(reloaded.members.length, 2);
  assert.equal(reloaded.edges.length, 1);
  assert.equal(reloaded.version, baseVersion + 1);
});

test('合并提交：被合并成员作为父母与子女时 ID 全部被替换', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  const c = store.addMember('C').member;
  const d = store.addMember('D').member;
  store.addEdge(b.id, c.id);
  store.addEdge(d.id, b.id);
  const v = store.getVersion();

  assert.equal(store.commitMerge(a.id, b.id, v).error, null);
  const ids = Object.fromEntries(store.list().members.map((m) => [m.name, m.id]));
  assert.deepEqual(
    store.list().edges.map((e) => [e.parentId, e.childId]).sort(),
    [[ids.A, ids.C], [ids.D, ids.A]].sort(),
  );
});

test('合并提交：冲突时整单拒绝、不改任何数据、版本不变', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  store.addEdge(a.id, b.id); // 合并 B 入 A 会产生自指
  const v = store.getVersion();

  const result = store.commitMerge(a.id, b.id, v);
  assert.equal(result.status, 400);
  assert.ok(result.result);
  assert.equal(result.result.valid, false);
  assert.ok(result.result.conflicts.some((c) => c.type === 'self'));
  // 数据完全未动
  assert.equal(store.list().members.length, 2);
  assert.equal(store.list().edges.length, 1);
  assert.equal(store.getVersion(), v);
});

test('合并提交：超过两位父母冲突时零写入（直接构造绕过 API 的脏数据）', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  const d = store.addMember('D').member;
  const e = store.addMember('E').member;
  const child = store.addMember('C').member;
  store.addEdge(b.id, child.id);
  store.addEdge(d.id, child.id);
  // 绕过 API 直接制造第三位父母
  store.getState().parentsOf[child.id].push(e.id);
  const v = store.getVersion();

  const result = store.commitMerge(a.id, b.id, v);
  assert.equal(result.status, 400);
  assert.ok(result.result.conflicts.some((c) => c.type === 'too-many-parents'));
  assert.equal(store.getVersion(), v);
});

test('合并提交：祖先环路冲突时零写入', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  const c = store.addMember('C').member;
  store.addEdge(a.id, b.id);
  store.addEdge(b.id, c.id);
  const v = store.getVersion();

  // 把 A 并入 C：C->B 与 B->C 成环
  const result = store.commitMerge(c.id, a.id, v);
  assert.equal(result.status, 400);
  assert.ok(result.result.conflicts.some((x) => x.type === 'cycle'));
  assert.equal(store.list().edges.length, 2);
  assert.equal(store.getVersion(), v);
});

test('合并乐观锁：预览后家谱变化，携带旧版本提交被 409 拒绝且零写入', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  const c = store.addMember('C').member;
  store.addEdge(b.id, c.id);
  const previewVersion = store.getVersion();

  // 预览之后其他操作改动了家谱
  const d = store.addMember('D').member;
  assert.notEqual(store.getVersion(), previewVersion);

  const result = store.commitMerge(a.id, b.id, previewVersion);
  assert.equal(result.status, 409);
  assert.match(result.error, /重新预览/);
  assert.equal(result.currentVersion, store.getVersion());
  // 未合并：被合并成员仍在，其关系未被替换
  assert.ok(store.list().members.some((m) => m.id === b.id));
  assert.ok(store.list().edges.some((e) => e.parentId === b.id));
  assert.ok(store.list().members.some((m) => m.id === d.id));
});

test('合并提交：缺少版本号 / 成员不存在 / 同一人被拒绝', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  const v = store.getVersion();

  const noVersion = store.commitMerge(a.id, b.id, undefined);
  assert.equal(noVersion.status, 400);
  assert.match(noVersion.error, /版本号/);

  const missing = store.commitMerge(a.id, 'no-such-id', v);
  assert.equal(missing.status, 400);
  assert.match(missing.error, /被合并成员不存在/);

  const same = store.commitMerge(a.id, a.id, v);
  assert.equal(same.status, 400);
  assert.match(same.error, /同一人/);

  assert.equal(store.getVersion(), v);
});

test('合并预览：不修改 store 数据也不推进版本', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  store.addEdge(a.id, b.id);
  const v = store.getVersion();
  const r = store.previewMerge(a.id, b.id);
  assert.equal(r.valid, false);
  assert.equal(store.getVersion(), v);
  assert.equal(store.list().members.length, 2);
  assert.equal(store.list().edges.length, 1);
});
