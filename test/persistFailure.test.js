'use strict';

/**
 * 写盘失败的状态漂移防护：普通变更、批量提交、备份恢复与撤销都遵守
 * 「先落盘、后发布」——临时文件写入或重命名失败时，内存中的成员、关系、
 * 纪念日、版本与最近一次撤销信息全部保持原值，本次临时文件被清理，
 * 请求收到可识别的错误（status 500，code: PERSIST_FAILED），
 * 恢复写盘条件后可再次提交。
 *
 * 失败注入不依赖权限位（root 下不可靠），而是利用文件系统语义：
 * - 在临时文件路径上预先放置目录 → writeFileSync 报 EISDIR（写临时文件失败）；
 * - 把数据文件路径替换成目录 → renameSync 报 EISDIR（重命名失败）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-persist-'));
  return path.join(dir, 'family.json');
}

/** store 写盘时使用的临时文件路径（与 store.js 内部规则一致） */
function tmpPathOf(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
}

/** 让「写临时文件」失败：在临时文件路径上预先放一个目录；返回解除函数 */
function blockTempWrite(file) {
  fs.mkdirSync(tmpPathOf(file));
  return () => fs.rmdirSync(tmpPathOf(file));
}

/** 让「重命名」失败：把数据文件挪走、在原路径放上目录；返回解除函数（恢复原件） */
function blockRename(file) {
  const aside = `${file}.set-aside`;
  fs.renameSync(file, aside);
  fs.mkdirSync(file);
  return () => {
    fs.rmdirSync(file);
    fs.renameSync(aside, file);
  };
}

test('写临时文件失败：添加成员不生效，内存与磁盘保持原值，恢复后可再次提交', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.addMember('甲');
  const before = store.list();
  const diskBefore = fs.readFileSync(file, 'utf8');

  const unblock = blockTempWrite(file);
  const result = store.addMember('乙');
  assert.equal(result.status, 500);
  assert.equal(result.code, 'PERSIST_FAILED');
  assert.match(result.error, /写入磁盘失败/);
  assert.match(result.error, /未生效/);

  // 内存保持原值：成员、版本、撤销信息都不变（/api/state 不会显示未落盘数据）
  const after = store.list();
  assert.deepEqual(after.members, before.members);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.undo, before.undo);
  // 磁盘文件未被改动
  assert.equal(fs.readFileSync(file, 'utf8'), diskBefore);
  unblock();

  // 写盘条件恢复后可再次提交，且确实落盘（重启后仍在）
  assert.equal(store.addMember('乙').error, null);
  assert.equal(store.list().members.length, 2);
  assert.equal(store.getVersion(), before.version + 1);
  const reloaded = createStore(file);
  assert.equal(reloaded.list().members.length, 2);
  assert.equal(reloaded.getVersion(), before.version + 1);
});

test('重命名失败：临时文件被清理，成员/关系/纪念日/版本/撤销信息全部保持原值', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addMember('甲').member;
  const b = store.addMember('乙').member;
  store.addEdge(a.id, b.id);
  store.setAnniversaries(a.id, { birthday: { month: 3, day: 15 }, deathday: null });
  const before = store.list();
  const diskBefore = fs.readFileSync(file, 'utf8');

  const unblock = blockRename(file);
  const result = store.renameMember(a.id, '甲某');
  assert.equal(result.status, 500);
  assert.equal(result.code, 'PERSIST_FAILED');

  // 本次临时文件已被清理
  assert.equal(fs.existsSync(tmpPathOf(file)), false);
  // 内存各项保持原值：成员（含纪念日）、关系、版本、最近撤销信息
  assert.deepEqual(store.list(), before);
  unblock();

  // 磁盘文件保持原内容（重命名未发生）
  assert.equal(fs.readFileSync(file, 'utf8'), diskBefore);

  // 恢复写盘条件后可再次提交
  assert.equal(store.renameMember(a.id, '甲某').error, null);
  assert.equal(store.list().members.find((m) => m.id === a.id).name, '甲某');
  assert.equal(store.getVersion(), before.version + 1);
});

test('批量提交落盘失败：整批不生效、版本不推进、快照不动，恢复后可重试', () => {
  const file = tmpFile();
  const store = createStore(file);
  const ids = ['A', 'B'].map((n) => store.addMember(n).member.id);
  const before = store.list();

  const unblock = blockTempWrite(file);
  const failed = store.commitEdges([{ parentId: ids[0], childId: ids[1] }], before.version);
  assert.equal(failed.status, 500);
  assert.equal(failed.code, 'PERSIST_FAILED');
  // 整批零写入：关系、版本、撤销快照全部保持原值
  assert.deepEqual(store.list(), before);
  unblock();

  assert.equal(store.commitEdges([{ parentId: ids[0], childId: ids[1] }], before.version).error, null);
  assert.equal(store.list().edges.length, 1);
  assert.equal(store.getVersion(), before.version + 1);
});

test('撤销落盘失败：家谱与最近一次撤销信息保持原值，恢复后可再次撤销', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.addMember('甲');
  store.addMember('乙');
  const before = store.list(); // 2 名成员，undo 指向「添加成员「乙」」

  const unblock = blockRename(file);
  const failed = store.undoLast(before.version);
  assert.equal(failed.status, 500);
  assert.equal(failed.code, 'PERSIST_FAILED');

  // 内存保持原值：两名成员都在、版本未推进、可撤销快照仍在
  assert.deepEqual(store.list(), before);
  // 本次临时文件已被清理
  assert.equal(fs.existsSync(tmpPathOf(file)), false);
  unblock();

  // 恢复写盘条件后撤销成功：成员减少、版本推进、快照清空
  const ok = store.undoLast(store.getVersion());
  assert.equal(ok.error, null);
  assert.match(ok.label, /添加成员「乙」/);
  const after = store.list();
  assert.equal(after.members.length, 1);
  assert.equal(after.version, before.version + 1);
  assert.equal(after.undo, null);
});

test('备份恢复落盘失败：家谱不被替换，恢复写盘条件后可再次恢复', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.addMember('旧甲');
  const before = store.list();

  const backup = JSON.stringify({
    members: [
      { id: 'x1', name: '新甲' },
      { id: 'x2', name: '新乙' },
    ],
    edges: [{ parentId: 'x1', childId: 'x2' }],
  });
  const preview = store.previewRestore(backup);
  assert.equal(preview.valid, true);

  const unblock = blockRename(file);
  const failed = store.restoreBackup(backup, preview.fingerprint, before.version);
  assert.equal(failed.status, 500);
  assert.equal(failed.code, 'PERSIST_FAILED');

  // 内存保持原值：旧成员仍在、版本未推进、撤销快照仍指向上一操作
  assert.deepEqual(store.list(), before);
  unblock();

  // 恢复写盘条件后用同一版本与指纹重试成功（版本未漂移，乐观锁仍通过）
  const ok = store.restoreBackup(backup, preview.fingerprint, store.getVersion());
  assert.equal(ok.error, null);
  const restored = store.list();
  assert.deepEqual(restored.members.map((m) => m.name).sort(), ['新甲', '新乙'].sort());
  assert.equal(restored.edges.length, 1);
  assert.equal(restored.version, before.version + 1);
});

test('HTTP：写盘失败返回可识别的 JSON 错误，/api/state 不显示未落盘数据，恢复后可再提交', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-http-'));
  const file = path.join(dir, 'family.json');
  process.env.DATA_FILE = file;
  const app = require('../server/index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    // 先成功添加一名成员
    let res = await post('/api/members', { name: '甲' });
    assert.equal(res.status, 201);

    // 阻断写盘（临时文件路径上放置目录）
    const unblock = blockTempWrite(file);

    res = await post('/api/members', { name: '乙' });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, 'PERSIST_FAILED');
    assert.match(body.error, /写入磁盘失败/);

    // 同一进程的 /api/state 不显示未落盘的新数据
    res = await fetch(`${base}/api/state`);
    const state = await res.json();
    assert.deepEqual(state.members.map((m) => m.name), ['甲']);
    assert.equal(state.version, 1);

    unblock();

    // 恢复写盘条件后可再次提交
    res = await post('/api/members', { name: '乙' });
    assert.equal(res.status, 201);
    const after = await res.json();
    assert.equal(after.members.length, 2);
    assert.equal(after.version, 2);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    delete process.env.DATA_FILE;
  }
});
