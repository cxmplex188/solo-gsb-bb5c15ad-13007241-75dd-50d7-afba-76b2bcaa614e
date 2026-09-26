'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-undo-'));
  return path.join(dir, 'family.json');
}

test('撤销添加成员：成员消失、版本推进、快照清空、不能重复撤销', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  const v1 = store.getVersion();
  assert.equal(v1, 1);
  assert.ok(store.list().undo);
  assert.equal(store.list().undo.label, '添加成员「甲」');

  const r = store.undoLast(v1);
  assert.equal(r.error, null);
  assert.match(r.label, /添加成员/);
  const data = store.list();
  assert.equal(data.members.length, 0);
  assert.equal(data.version, v1 + 1); // 撤销本身推进版本
  assert.equal(data.undo, null); // 快照已清空

  // 不能重复撤销
  const again = store.undoLast(data.version);
  assert.equal(again.status, 409);
  assert.match(again.error, /没有可撤销/);
  assert.equal(store.getVersion(), data.version);
});

test('撤销重命名：恢复原姓名且成员 ID 不变', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('张三').member;
  const base = store.getVersion();
  assert.equal(store.renameMember(a.id, '张叁').error, null);
  assert.equal(store.list().members[0].name, '张叁');

  assert.equal(store.undoLast(store.getVersion()).error, null);
  const restored = store.list();
  assert.equal(restored.members.length, 1);
  assert.equal(restored.members[0].id, a.id);
  assert.equal(restored.members[0].name, '张三');
  assert.equal(restored.undo, null);
});

test('撤销删除成员：成员与被级联删除的关系按原 ID/姓名整体恢复', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  store.addEdge(a.id, b.id);
  const beforeDelete = store.list();

  assert.equal(store.deleteMember(a.id).error, null);
  assert.equal(store.list().members.length, 1);
  assert.equal(store.list().edges.length, 0);

  assert.equal(store.undoLast(store.getVersion()).error, null);
  const restored = store.list();
  assert.equal(restored.members.length, 2);
  assert.deepEqual(
    restored.members.map((m) => [m.id, m.name]).sort(),
    beforeDelete.members.map((m) => [m.id, m.name]).sort(),
  );
  assert.deepEqual(restored.edges, [{ parentId: a.id, childId: b.id }]);
});

test('撤销单条关系建立与删除', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;

  // 撤销建立
  assert.equal(store.addEdge(a.id, b.id).error, null);
  assert.match(store.list().undo.label, /建立关系/);
  assert.equal(store.undoLast(store.getVersion()).error, null);
  assert.equal(store.list().edges.length, 0);
  assert.ok(store.list().members.some((m) => m.id === a.id));

  // 撤销删除：先重建再删
  assert.equal(store.addEdge(a.id, b.id).error, null);
  assert.equal(store.deleteEdge(a.id, b.id).error, null);
  assert.match(store.list().undo.label, /删除关系/);
  assert.equal(store.undoLast(store.getVersion()).error, null);
  assert.deepEqual(store.list().edges, [{ parentId: a.id, childId: b.id }]);
});

test('撤销批量提交：整批关系一次恢复，只产生一个快照', () => {
  const store = createStore(tmpFile());
  const ids = ['A', 'B', 'C'].map((n) => store.addMember(n).member.id);
  const v = store.getVersion();
  const r = store.commitEdges(
    [
      { parentId: ids[0], childId: ids[1] },
      { parentId: ids[1], childId: ids[2] },
    ],
    v,
  );
  assert.equal(r.error, null);
  assert.equal(store.list().edges.length, 2);
  assert.match(store.list().undo.label, /批量建立 2 条关系/);
  const afterBatch = store.getVersion();
  assert.equal(afterBatch, v + 1); // 批量只推进一次版本

  assert.equal(store.undoLast(afterBatch).error, null);
  const restored = store.list();
  assert.equal(restored.edges.length, 0);
  assert.equal(restored.members.length, 3);
  assert.equal(restored.version, afterBatch + 1);
  assert.equal(restored.undo, null);
});

test('撤销合并：被合并成员的 ID/姓名恢复，合并去重前的关系原貌全部恢复', () => {
  const store = createStore(tmpFile());
  const keep = store.addMember('张三').member;
  const dup = store.addMember('张叁').member;
  const child = store.addMember('张小').member;
  store.addEdge(keep.id, child.id);
  store.addEdge(dup.id, child.id); // 合并时被去重的边
  const before = store.list();
  const v = store.getVersion();

  assert.equal(store.commitMerge(keep.id, dup.id, v).error, null);
  const merged = store.list();
  assert.equal(merged.members.length, 2);
  assert.equal(merged.edges.length, 1);
  assert.match(merged.undo.label, /合并成员/);

  assert.equal(store.undoLast(merged.version).error, null);
  const restored = store.list();
  assert.deepEqual(
    restored.members.map((m) => [m.id, m.name]).sort(),
    before.members.map((m) => [m.id, m.name]).sort(),
  );
  assert.deepEqual(
    restored.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
    before.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
  );
  // 被合并成员以原 ID、原姓名回来
  const back = restored.members.find((m) => m.id === dup.id);
  assert.equal(back.name, '张叁');
});

test('快照持久化：重启后仍可撤销，撤销后落盘快照清空', () => {
  const file = tmpFile();
  const s1 = createStore(file);
  const a = s1.addMember('A').member;
  s1.addMember('B');
  s1.addEdge(a.id, s1.list().members[1].id);

  // 落盘文件内确实带有完整家谱快照（建边前：2 名成员、0 条关系）
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(raw.undo && raw.undo.family);
  assert.equal(raw.undo.family.members.length, 2);
  assert.equal(raw.undo.family.edges.length, 0);

  // 模拟重启
  const s2 = createStore(file);
  assert.ok(s2.list().undo);
  assert.equal(s2.undoLast(s2.getVersion()).error, null);
  const data = s2.list();
  // 撤销的是「建立关系」：两位成员都在、关系消失
  assert.equal(data.members.length, 2);
  assert.equal(data.edges.length, 0);
  assert.equal(data.undo, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).undo, null);

  // 再重启也不能撤销
  const s3 = createStore(file);
  assert.equal(s3.list().undo, null);
  assert.equal(s3.undoLast(s3.getVersion()).status, 409);
});

test('撤销的乐观锁：携带旧版本被 409 拒绝且数据保持不变', () => {
  const store = createStore(tmpFile());
  store.addMember('A');
  const seenVersion = store.getVersion();
  // 其他标签页/脚本又做了一次修改（覆盖旧快照、推进版本）
  store.addMember('B');
  assert.notEqual(store.getVersion(), seenVersion);

  const r = store.undoLast(seenVersion);
  assert.equal(r.status, 409);
  assert.equal(r.currentVersion, store.getVersion());
  // 数据保持不变：两位成员都在
  assert.equal(store.list().members.length, 2);
  // 快照也仍是最近一次变更（B 的添加），仍可基于新版本撤销
  assert.match(store.list().undo.label, /添加成员「B」/);
  assert.equal(store.undoLast(store.getVersion()).error, null);
  assert.equal(store.list().members.length, 1);
});

test('初始空库无快照；缺少版本号撤销被 400 拒绝', () => {
  const store = createStore(tmpFile());
  assert.equal(store.list().undo, null);
  assert.equal(store.undoLast(undefined).status, 400);
  assert.equal(store.undoLast(0).status, 409);
  assert.equal(store.getVersion(), 0);
});

test('失败的写入不产生快照：非法建边/冲突合并被拒绝后仍只能撤销上一次成功变更', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  const vAfterMembers = store.getVersion();

  // 自指边被拒绝：不推进版本、不覆盖快照
  assert.ok(store.addEdge(a.id, a.id).error);
  assert.equal(store.getVersion(), vAfterMembers);
  assert.match(store.list().undo.label, /添加成员「B」/);

  // 制造一个必然冲突的合并（A→B 存在，把 B 并入 A 自指）
  assert.equal(store.addEdge(a.id, b.id).error, null);
  const vEdge = store.getVersion();
  const badMerge = store.commitMerge(a.id, b.id, vEdge);
  assert.equal(badMerge.status, 400);
  assert.equal(store.getVersion(), vEdge);
  // 快照仍指向建边，可撤销
  assert.match(store.list().undo.label, /建立关系/);
  assert.equal(store.undoLast(vEdge).error, null);
  assert.equal(store.list().edges.length, 0);
});

test('连续成功写入只保留最近一次快照（仅一级撤销）', () => {
  const store = createStore(tmpFile());
  store.addMember('A');
  store.addMember('B');
  store.addMember('C');
  assert.match(store.list().undo.label, /添加成员「C」/);

  assert.equal(store.undoLast(store.getVersion()).error, null);
  // 只回到 C 添加之前：A、B 仍在，且无法再撤销到更早
  assert.deepEqual(store.list().members.map((m) => m.name), ['A', 'B']);
  assert.equal(store.list().undo, null);
});
