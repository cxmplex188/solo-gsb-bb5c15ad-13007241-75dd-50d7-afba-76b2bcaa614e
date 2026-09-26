'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');
const { validateBackup } = require('../server/familyGraph');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-backup-'));
  return path.join(dir, 'family.json');
}

/** 用 store 当前内容生成与下载接口一致的备份文本（仅成员 ID、姓名与关系） */
function dumpBackup(store) {
  const data = store.list();
  return JSON.stringify({
    members: data.members.map((m) => ({ id: m.id, name: m.name })),
    edges: data.edges.map((e) => ({ parentId: e.parentId, childId: e.childId })),
  });
}

/** 四代同堂示例：祖父 → 父亲 → 儿子，母亲 → 儿子 */
function populatedStore() {
  const store = createStore(tmpFile());
  const grand = store.addMember('祖父').member;
  const father = store.addMember('父亲').member;
  const mother = store.addMember('母亲').member;
  const son = store.addMember('儿子').member;
  store.addEdge(grand.id, father.id);
  store.addEdge(father.id, son.id);
  store.addEdge(mother.id, son.id);
  return store;
}

/* ---------------- validateBackup 纯函数 ---------------- */

test('备份校验：合法文件通过，返回净化后的成员与关系', () => {
  const parsed = {
    members: [
      { id: 'a', name: '甲' },
      { id: 'b', name: '乙' },
    ],
    edges: [{ parentId: 'a', childId: 'b' }],
  };
  const r = validateBackup(parsed);
  assert.equal(r.valid, true);
  assert.equal(r.error, null);
  assert.equal(r.errors.length, 0);
  assert.equal(r.memberCount, 2);
  assert.equal(r.edgeCount, 1);
  // 旧备份缺少纪念日字段：净化后视为未登记（null）
  assert.deepEqual(r.members, [
    { id: 'a', name: '甲', birthday: null, deathday: null },
    { id: 'b', name: '乙', birthday: null, deathday: null },
  ]);
  assert.deepEqual(r.edges, parsed.edges);
});

test('备份校验：空家谱（0 成员 0 关系）合法', () => {
  const r = validateBackup({ members: [], edges: [] });
  assert.equal(r.valid, true);
  assert.equal(r.memberCount, 0);
  assert.equal(r.edgeCount, 0);
});

test('备份校验：顶层结构非法时给出文件级错误', () => {
  assert.equal(validateBackup(null).valid, false);
  assert.equal(validateBackup([]).valid, false);
  assert.equal(validateBackup('text').valid, false);
  const r = validateBackup({ members: {} });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.where === 'file' && /members/.test(e.message)));
  assert.ok(r.errors.some((e) => e.where === 'file' && /edges/.test(e.message)));
});

test('备份校验：重复成员 ID 逐项报错，不静默丢弃', () => {
  const r = validateBackup({
    members: [
      { id: 'a', name: '甲' },
      { id: 'b', name: '乙' },
      { id: 'a', name: '丙' },
      { id: 'a', name: '丁' },
    ],
    edges: [],
  });
  assert.equal(r.valid, false);
  const dup = r.errors.filter((e) => /重复/.test(e.message));
  assert.equal(dup.length, 2); // 第 3、4 项各报一次
  assert.match(dup[0].message, /第 3 项/);
  assert.match(dup[0].message, /第 1 项/);
  assert.match(dup[0].message, /"a"/);
  assert.match(dup[1].message, /第 4 项/);
});

test('备份校验：成员超过 30 人上限报错', () => {
  const members = Array.from({ length: 31 }, (_, i) => ({ id: `m${i}`, name: `成员${i}` }));
  const r = validateBackup({ members, edges: [] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.where === 'file' && /31/.test(e.message) && /30/.test(e.message)));
});

test('备份校验：非法成员条目（缺 id、缺姓名、姓名超长、非对象）逐项报错', () => {
  const r = validateBackup({
    members: [
      { id: '', name: '甲' },
      { id: 'b' },
      { id: 'c', name: 'x'.repeat(51) },
      'not-an-object',
    ],
    edges: [],
  });
  assert.equal(r.valid, false);
  assert.equal(r.errors.filter((e) => e.where === 'member').length, 4);
  assert.ok(r.errors.some((e) => /id/.test(e.message)));
  assert.ok(r.errors.some((e) => /姓名/.test(e.message) && /"b"/.test(e.message)));
  assert.ok(r.errors.some((e) => /50/.test(e.message)));
});

test('备份校验：缺失端点、自指、重复关系、非法类型逐项报错', () => {
  const r = validateBackup({
    members: [
      { id: 'a', name: '甲' },
      { id: 'b', name: '乙' },
    ],
    edges: [
      { parentId: 'a', childId: 'ghost' }, // 缺失端点
      { parentId: 'a', childId: 'a' }, // 自指
      { parentId: 'a', childId: 'b' }, // 合法
      { parentId: 'a', childId: 'b' }, // 与第 3 条重复
      { parentId: 1, childId: 'b' }, // 类型非法
    ],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /端点不在成员列表/.test(e.message) && /ghost/.test(e.message)));
  assert.ok(r.errors.some((e) => /自指/.test(e.message)));
  assert.ok(r.errors.some((e) => /重复/.test(e.message) && /第 4 条/.test(e.message) && /第 3 条/.test(e.message)));
  assert.ok(r.errors.some((e) => /parentId/.test(e.message)));
  // 合法的第 3 条（下标 2）不产生任何错误
  assert.ok(!r.errors.some((e) => e.index === 2));
});

test('备份校验：每名子女至多两位父母（去重后统计）', () => {
  const r = validateBackup({
    members: [
      { id: 'a', name: '甲' },
      { id: 'b', name: '乙' },
      { id: 'c', name: '丙' },
      { id: 'd', name: '丁' },
    ],
    edges: [
      { parentId: 'a', childId: 'd' },
      { parentId: 'b', childId: 'd' },
      { parentId: 'c', childId: 'd' },
    ],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /3 位父母/.test(e.message) && /丁/.test(e.message)));
});

test('备份校验：祖先环路在去重后的整图上逐边报错', () => {
  const r = validateBackup({
    members: [
      { id: 'a', name: '甲' },
      { id: 'b', name: '乙' },
      { id: 'c', name: '丙' },
    ],
    edges: [
      { parentId: 'a', childId: 'b' },
      { parentId: 'b', childId: 'c' },
      { parentId: 'c', childId: 'a' },
    ],
  });
  assert.equal(r.valid, false);
  const cyc = r.errors.filter((e) => /环路/.test(e.message));
  assert.equal(cyc.length, 3); // 环上每条边都被标记
});

/* ---------------- 恢复预览（只读） ---------------- */

test('恢复预览：只读，返回数量与稳定的内容指纹，不推进版本', () => {
  const source = populatedStore();
  const content = dumpBackup(source);

  const store = createStore(tmpFile());
  store.addMember('旧成员');
  const v = store.getVersion();
  const before = store.list();

  const r1 = store.previewRestore(content);
  assert.equal(r1.valid, true);
  assert.equal(r1.memberCount, 4);
  assert.equal(r1.edgeCount, 3);
  assert.match(r1.fingerprint, /^[0-9a-f]{64}$/);
  // 同样内容指纹稳定，不同内容指纹不同
  assert.equal(store.previewRestore(content).fingerprint, r1.fingerprint);
  assert.notEqual(store.previewRestore('{"members":[],"edges":[]}').fingerprint, r1.fingerprint);
  // 只读：版本与数据完全不变
  assert.equal(store.getVersion(), v);
  assert.deepEqual(store.list(), before);
});

test('恢复预览：非 JSON 内容作为文件级问题报告', () => {
  const store = createStore(tmpFile());
  const r = store.previewRestore('not json at all');
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.where === 'file' && /JSON/.test(e.message)));
});

/* ---------------- 恢复确认 ---------------- */

test('恢复确认：原子替换家谱、版本 +1、纳入最近一次撤销并一次落盘', () => {
  const file = tmpFile();
  const source = populatedStore();
  const content = dumpBackup(source);
  const sourceData = source.list();

  const store = createStore(file);
  const oldA = store.addMember('旧甲').member;
  const oldB = store.addMember('旧乙').member;
  store.addEdge(oldA.id, oldB.id);
  const v = store.getVersion();

  const preview = store.previewRestore(content);
  const r = store.restoreBackup(content, preview.fingerprint, v);
  assert.equal(r.error, null);

  const data = store.list();
  assert.equal(data.version, v + 1); // 只推进一次版本
  assert.equal(data.members.length, 4);
  assert.equal(data.edges.length, 3);
  // 成员 ID 原样迁入（迁移到另一台本地实例的关键）
  assert.deepEqual(
    data.members.map((m) => m.id).sort(),
    sourceData.members.map((m) => m.id).sort(),
  );
  assert.deepEqual(
    data.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
    sourceData.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
  );
  // 纳入最近一次撤销：快照为恢复前的完整家谱
  assert.match(data.undo.label, /恢复备份/);
  assert.equal(data.undo.version, v);

  // 一次落盘：重启后状态与版本延续、快照仍在
  const reloaded = createStore(file).list();
  assert.equal(reloaded.members.length, 4);
  assert.equal(reloaded.edges.length, 3);
  assert.equal(reloaded.version, v + 1);
  assert.match(reloaded.undo.label, /恢复备份/);
});

test('恢复后可撤销：旧家谱按原 ID/姓名/关系整体恢复，且不能重复撤销', () => {
  const source = populatedStore();
  const content = dumpBackup(source);

  const store = createStore(tmpFile());
  const a = store.addMember('旧甲').member;
  const b = store.addMember('旧乙').member;
  store.addEdge(a.id, b.id);
  const before = store.list();
  const v = store.getVersion();

  const preview = store.previewRestore(content);
  assert.equal(store.restoreBackup(content, preview.fingerprint, v).error, null);
  assert.equal(store.list().members.length, 4);

  assert.equal(store.undoLast(store.getVersion()).error, null);
  const restored = store.list();
  assert.deepEqual(
    restored.members.map((m) => [m.id, m.name]).sort(),
    before.members.map((m) => [m.id, m.name]).sort(),
  );
  assert.deepEqual(restored.edges, before.edges);
  assert.equal(restored.undo, null);
  assert.equal(store.undoLast(restored.version).status, 409);
});

test('恢复空备份：清空当前家谱且可撤销', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  const b = store.addMember('乙').member;
  store.addEdge(a.id, b.id);
  const v = store.getVersion();

  const content = JSON.stringify({ members: [], edges: [] });
  const preview = store.previewRestore(content);
  assert.equal(preview.valid, true);
  assert.equal(store.restoreBackup(content, preview.fingerprint, v).error, null);
  assert.equal(store.list().members.length, 0);
  assert.equal(store.list().edges.length, 0);

  assert.equal(store.undoLast(store.getVersion()).error, null);
  assert.equal(store.list().members.length, 2);
  assert.equal(store.list().edges.length, 1);
});

test('恢复确认：版本过期被 409 拒绝且数据不变', () => {
  const source = populatedStore();
  const content = dumpBackup(source);

  const store = createStore(tmpFile());
  store.addMember('旧');
  const v = store.getVersion();
  const preview = store.previewRestore(content);

  store.addMember('捣乱'); // 预览之后家谱被其他操作修改
  const r = store.restoreBackup(content, preview.fingerprint, v);
  assert.equal(r.status, 409);
  assert.equal(r.currentVersion, store.getVersion());
  assert.match(r.error, /重新预览/);
  assert.equal(store.list().members.length, 2);
});

test('恢复确认：内容指纹不符（文件被调换或伪造）被 409 拒绝且数据不变', () => {
  const source = populatedStore();
  const good = dumpBackup(source);

  const store = createStore(tmpFile());
  store.addMember('旧');
  const v = store.getVersion();
  const preview = store.previewRestore(good);

  // 另一份合法但不同的备份，沿用旧指纹
  const other = createStore(tmpFile());
  other.addMember('别人');
  const tampered = dumpBackup(other);
  const r = store.restoreBackup(tampered, preview.fingerprint, v);
  assert.equal(r.status, 409);
  assert.match(r.error, /指纹/);
  assert.equal(r.currentVersion, v);

  // 伪造指纹同样被拒
  const r2 = store.restoreBackup(good, 'f'.repeat(64), v);
  assert.equal(r2.status, 409);

  // 数据与版本完全未动
  assert.equal(store.list().members.length, 1);
  assert.equal(store.getVersion(), v);
});

test('恢复确认：服务端重验整份文件，非法内容 400 逐项报错且零写入', () => {
  const store = createStore(tmpFile());
  store.addMember('旧');
  const v = store.getVersion();

  const bad = JSON.stringify({
    members: [
      { id: 'a', name: '甲' },
      { id: 'a', name: '重复甲' },
    ],
    edges: [{ parentId: 'a', childId: 'ghost' }],
  });
  // 指纹与内容一致（绕过指纹关），但内容本身非法
  const preview = store.previewRestore(bad);
  assert.equal(preview.valid, false);

  const r = store.restoreBackup(bad, preview.fingerprint, v);
  assert.equal(r.status, 400);
  assert.ok(r.errors.length >= 2);
  assert.ok(r.errors.some((e) => /重复/.test(e.message)));
  assert.ok(r.errors.some((e) => /端点/.test(e.message)));
  // 零写入：数据、版本、撤销快照都不变
  assert.equal(store.list().members.length, 1);
  assert.equal(store.getVersion(), v);
  assert.match(store.list().undo.label, /添加成员「旧」/);
});

test('恢复确认：缺少内容 / 指纹 / 版本号被 400 拒绝', () => {
  const store = createStore(tmpFile());
  assert.equal(store.restoreBackup(undefined, 'x', 0).status, 400);
  assert.equal(store.restoreBackup('{}', undefined, 0).status, 400);
  assert.equal(store.restoreBackup('{}', 'x', undefined).status, 400);
  assert.equal(store.restoreBackup('not json', 'x', 0).status >= 400, true);
  assert.equal(store.getVersion(), 0);
});

test('迁移往返：一台实例的备份恢复到另一台空实例，成员 ID 与关系完全一致', () => {
  const source = populatedStore();
  const content = dumpBackup(source);
  const sourceData = source.list();

  // 另一台全新本地实例
  const target = createStore(tmpFile());
  const preview = target.previewRestore(content);
  assert.equal(preview.valid, true);
  assert.equal(target.restoreBackup(content, preview.fingerprint, target.getVersion()).error, null);

  const data = target.list();
  assert.deepEqual(
    data.members.map((m) => [m.id, m.name]).sort(),
    sourceData.members.map((m) => [m.id, m.name]).sort(),
  );
  assert.deepEqual(
    data.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
    sourceData.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
  );
});
