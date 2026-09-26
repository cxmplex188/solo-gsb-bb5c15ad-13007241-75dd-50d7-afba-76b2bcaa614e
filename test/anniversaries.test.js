'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');
const { validateBackup } = require('../server/familyGraph');
const {
  validateMonthDay,
  sanitizeMonthDay,
  occurrenceInYear,
  parseLocalDate,
  upcomingAnniversaries,
  isLeapYear,
} = require('../server/anniversaries');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-anniv-'));
  return path.join(dir, 'family.json');
}

/* ---------------- 月日校验 ---------------- */

test('月日校验：合法日期通过（含 2 月 29 日），null 表示未登记', () => {
  assert.deepEqual(validateMonthDay(null), { error: null, value: null });
  assert.deepEqual(validateMonthDay(undefined), { error: null, value: null });
  assert.deepEqual(validateMonthDay({ month: 1, day: 1 }), { error: null, value: { month: 1, day: 1 } });
  assert.deepEqual(validateMonthDay({ month: 2, day: 29 }), { error: null, value: { month: 2, day: 29 } });
  assert.deepEqual(validateMonthDay({ month: 12, day: 31 }), { error: null, value: { month: 12, day: 31 } });
  assert.deepEqual(validateMonthDay({ month: 4, day: 30 }), { error: null, value: { month: 4, day: 30 } });
});

test('月日校验：非法日期逐项拒绝', () => {
  for (const bad of [
    { month: 2, day: 30 }, // 2 月没有 30 日
    { month: 4, day: 31 }, // 4 月只有 30 天
    { month: 0, day: 10 },
    { month: 13, day: 1 },
    { month: 1, day: 0 },
    { month: 1, day: 32 },
    { month: 2.5, day: 1 },
    { month: 3, day: '15' },
    { month: 3 }, // 缺 day
    '3-15',
    [3, 15],
    42,
  ]) {
    const r = validateMonthDay(bad);
    assert.ok(r.error, `应拒绝：${JSON.stringify(bad)}`);
    assert.equal(r.value, undefined);
  }
  assert.match(validateMonthDay({ month: 2, day: 30 }).error, /2 月没有 30 日/);
  assert.match(validateMonthDay({ month: 4, day: 31 }).error, /4 月没有 31 日/);
});

test('净化：非法或缺失一律视为未登记（旧数据兼容）', () => {
  assert.equal(sanitizeMonthDay(undefined), null);
  assert.equal(sanitizeMonthDay(null), null);
  assert.equal(sanitizeMonthDay({ month: 2, day: 30 }), null);
  assert.deepEqual(sanitizeMonthDay({ month: 6, day: 7 }), { month: 6, day: 7 });
});

/* ---------------- 发生日期与本地日期解析 ---------------- */

test('2 月 29 日：平年落到 2 月 28 日，闰年保持 2 月 29 日', () => {
  assert.equal(isLeapYear(2028), true);
  assert.equal(isLeapYear(2027), false);
  assert.equal(isLeapYear(1900), false); // 整百年须能被 400 整除
  assert.equal(isLeapYear(2000), true);
  assert.deepEqual(occurrenceInYear(2, 29, 2027), { year: 2027, month: 2, day: 28 });
  assert.deepEqual(occurrenceInYear(2, 29, 2028), { year: 2028, month: 2, day: 29 });
  assert.deepEqual(occurrenceInYear(2, 29, 1900), { year: 1900, month: 2, day: 28 });
  assert.deepEqual(occurrenceInYear(2, 29, 2000), { year: 2000, month: 2, day: 29 });
  assert.deepEqual(occurrenceInYear(3, 15, 2027), { year: 2027, month: 3, day: 15 });
});

test('本地日期解析：严格 YYYY-MM-DD 且必须是真实日期', () => {
  assert.deepEqual(parseLocalDate('2026-09-25'), { year: 2026, month: 9, day: 25 });
  assert.deepEqual(parseLocalDate('2028-02-29'), { year: 2028, month: 2, day: 29 });
  assert.equal(parseLocalDate('2027-02-29'), null); // 平年没有 2 月 29 日
  assert.equal(parseLocalDate('2026-02-30'), null);
  assert.equal(parseLocalDate('2026-13-01'), null);
  assert.equal(parseLocalDate('2026-1-5'), null); // 必须零填充
  assert.equal(parseLocalDate('2026/09/25'), null);
  assert.equal(parseLocalDate(''), null);
  assert.equal(parseLocalDate(undefined), null);
});

/* ---------------- 未来 30 天清单 ---------------- */

function member(id, name, birthday = null, deathday = null) {
  return { id, name, birthday, deathday };
}

test('清单：包含当天（daysUntil 0），窗口为含当天共 30 天', () => {
  const members = [
    member('a', '今天', { month: 9, day: 25 }),
    member('b', '明天', { month: 9, day: 26 }),
    member('c', '边界内', { month: 10, day: 24 }), // 第 29 天
    member('d', '窗口外', { month: 10, day: 25 }), // 第 30 天
    member('e', '未登记'),
  ];
  const r = upcomingAnniversaries(members, { year: 2026, month: 9, day: 25 });
  assert.equal(r.from, '2026-09-25');
  assert.equal(r.days, 30);
  const byName = new Map(r.items.map((i) => [i.memberName, i]));
  assert.equal(byName.get('今天').daysUntil, 0);
  assert.equal(byName.get('今天').date, '2026-09-25');
  assert.equal(byName.get('明天').daysUntil, 1);
  assert.equal(byName.get('边界内').daysUntil, 29);
  assert.equal(byName.has('窗口外'), false); // 第 30 天不在「含当天 30 天」内
  assert.equal(byName.has('未登记'), false);
});

test('清单：跨年准确——12 月起算时一月的纪念日取下一年', () => {
  const members = [
    member('a', '年初', { month: 1, day: 5 }),
    member('b', '年末', { month: 12, day: 31 }),
    member('c', '已过的今天前', { month: 12, day: 10 }), // 下一次在 2027-12-10，远超窗口
  ];
  const r = upcomingAnniversaries(members, { year: 2026, month: 12, day: 20 });
  const byName = new Map(r.items.map((i) => [i.memberName, i]));
  assert.equal(byName.get('年初').date, '2027-01-05');
  assert.equal(byName.get('年初').daysUntil, 16);
  assert.equal(byName.get('年末').date, '2026-12-31');
  assert.equal(byName.get('年末').daysUntil, 11);
  assert.equal(byName.has('已过的今天前'), false);
});

test('清单：2 月 29 日在平年按 2 月 28 日出现，闰年按 2 月 29 日出现', () => {
  const members = [member('a', '闰日生', { month: 2, day: 29 })];
  // 平年 2027：2 月 28 日出现
  const common = upcomingAnniversaries(members, { year: 2027, month: 2, day: 1 });
  assert.equal(common.items.length, 1);
  assert.equal(common.items[0].date, '2027-02-28');
  assert.equal(common.items[0].daysUntil, 27);
  // 闰年 2028：2 月 29 日出现
  const leap = upcomingAnniversaries(members, { year: 2028, month: 2, day: 1 });
  assert.equal(leap.items[0].date, '2028-02-29');
  assert.equal(leap.items[0].daysUntil, 28);
  // 平年 2 月 28 日当天：daysUntil 0
  const onDay = upcomingAnniversaries(members, { year: 2027, month: 2, day: 28 });
  assert.equal(onDay.items[0].daysUntil, 0);
});

test('清单：同日按姓名、类型（生日先于忌日）稳定排序', () => {
  const members = [
    member('m2', '张三', null, { month: 10, day: 1 }), // 忌日
    member('m1', '张三', { month: 10, day: 1 }), // 同名另一人的生日
    member('m3', '李四', { month: 10, day: 1 }),
    member('m4', '阿四', { month: 10, day: 2 }),
  ];
  // 同一成员同日生日+忌日：生日在前
  members[1].deathday = { month: 10, day: 1 };
  const r = upcomingAnniversaries(members, { year: 2026, month: 9, day: 25 });
  assert.equal(r.items.length, 5);
  // 10 月 1 日（6 天后）三条在前，10 月 2 日一条在后
  assert.deepEqual(r.items.map((i) => i.daysUntil), [6, 6, 6, 7, 6].sort((a, b) => a - b));
  const sameDay = r.items.filter((i) => i.date === '2026-10-01');
  // 姓名排序：李四 < 张三（拼音）；同姓名（张三两人不同 ID）按类型生日先于忌日、再按 ID
  assert.equal(sameDay[0].memberName, '李四');
  assert.equal(sameDay[1].memberName, '张三');
  assert.equal(sameDay[2].memberName, '张三');
  assert.equal(sameDay[3].memberName, '张三');
  // m1 的生日与忌日同日：生日在忌日前
  const m1Items = sameDay.filter((i) => i.memberId === 'm1');
  assert.deepEqual(m1Items.map((i) => i.type), ['birthday', 'deathday']);
  // 类型标签
  assert.equal(sameDay[0].typeLabel, '生日');
  // 排序确定性：再跑一次结果一致
  const again = upcomingAnniversaries(members, { year: 2026, month: 9, day: 25 });
  assert.deepEqual(again.items, r.items);
});

test('清单：每项纪念日只出现一次（取下一次发生日期）', () => {
  const members = [member('a', '甲', { month: 9, day: 26 })];
  const r = upcomingAnniversaries(members, { year: 2026, month: 9, day: 25 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].date, '2026-09-26');
});

/* ---------------- store：登记 / 修改 / 删除 ---------------- */

test('纪念日登记后随成员持久化，重启后完整恢复', () => {
  const file = tmpFile();
  const s1 = createStore(file);
  const a = s1.addMember('甲').member;
  const r = s1.setAnniversaries(a.id, { birthday: { month: 3, day: 15 }, deathday: null });
  assert.equal(r.error, null);

  // 落盘内容直接带纪念日字段
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.members[0].birthday, { month: 3, day: 15 });
  assert.equal(raw.members[0].deathday, null);

  // 模拟重启
  const s2 = createStore(file);
  const m = s2.list().members[0];
  assert.deepEqual(m.birthday, { month: 3, day: 15 });
  assert.equal(m.deathday, null);
});

test('登记 2 月 29 日合法；修改与清除走同一入口', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  assert.equal(
    store.setAnniversaries(a.id, { birthday: { month: 2, day: 29 }, deathday: { month: 12, day: 8 } }).error,
    null,
  );
  assert.deepEqual(store.list().members[0].birthday, { month: 2, day: 29 });

  // 修改
  assert.equal(
    store.setAnniversaries(a.id, { birthday: { month: 3, day: 1 }, deathday: { month: 12, day: 8 } }).error,
    null,
  );
  assert.deepEqual(store.list().members[0].birthday, { month: 3, day: 1 });

  // 清除（全部置 null）
  assert.equal(store.setAnniversaries(a.id, { birthday: null, deathday: null }).error, null);
  assert.equal(store.list().members[0].birthday, null);
  assert.equal(store.list().members[0].deathday, null);
  assert.match(store.list().undo.label, /清除「甲」的纪念日/);
});

test('非法日期整单拒绝：数据、版本与撤销快照都不变', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  assert.equal(store.setAnniversaries(a.id, { birthday: { month: 5, day: 6 }, deathday: null }).error, null);
  const v = store.getVersion();

  for (const bad of [
    { birthday: { month: 2, day: 30 }, deathday: null },
    { birthday: null, deathday: { month: 13, day: 1 } },
    { birthday: { month: 4, day: 31 }, deathday: { month: 1, day: 1 } },
    { birthday: '5-6', deathday: null },
  ]) {
    const r = store.setAnniversaries(a.id, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(r.error);
  }
  // 数据完全未变
  assert.equal(store.getVersion(), v);
  assert.deepEqual(store.list().members[0].birthday, { month: 5, day: 6 });
  assert.equal(store.list().members[0].deathday, null);
  // 撤销快照仍指向上一次成功写入（登记纪念日），未被失败请求覆盖
  assert.match(store.list().undo.label, /更新「甲」的纪念日/);
});

test('缺少字段 / 成员不存在被拒绝', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  const v = store.getVersion();

  const missing = store.setAnniversaries(a.id, { birthday: { month: 1, day: 1 } });
  assert.equal(missing.status, 400);
  assert.match(missing.error, /deathday/);

  const notFound = store.setAnniversaries('no-such-id', { birthday: null, deathday: null });
  assert.equal(notFound.status, 404);

  const badBody = store.setAnniversaries(a.id, null);
  assert.equal(badBody.status, 400);

  assert.equal(store.getVersion(), v);
  assert.equal(store.list().members[0].birthday, null);
});

test('删除成员：纪念日随成员一并删除，清单不再出现', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  const b = store.addMember('乙').member;
  store.setAnniversaries(a.id, { birthday: { month: 9, day: 26 }, deathday: null });
  store.setAnniversaries(b.id, { birthday: { month: 9, day: 27 }, deathday: null });

  assert.equal(store.deleteMember(a.id).error, null);
  const r = upcomingAnniversaries(store.getState().members, { year: 2026, month: 9, day: 25 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].memberName, '乙');
});

test('撤销：纪念日的登记与清除都可回退（仅一级撤销）', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;

  // 撤销登记：回到未登记
  assert.equal(
    store.setAnniversaries(a.id, { birthday: { month: 2, day: 29 }, deathday: { month: 11, day: 3 } }).error,
    null,
  );
  assert.match(store.list().undo.label, /更新「甲」的纪念日/);
  assert.equal(store.undoLast(store.getVersion()).error, null);
  assert.equal(store.list().members[0].birthday, null);
  assert.equal(store.list().members[0].deathday, null);

  // 撤销清除：已登记的纪念日恢复
  assert.equal(
    store.setAnniversaries(a.id, { birthday: { month: 5, day: 6 }, deathday: null }).error,
    null,
  );
  assert.equal(store.setAnniversaries(a.id, { birthday: null, deathday: null }).error, null);
  assert.equal(store.list().members[0].birthday, null);
  assert.match(store.list().undo.label, /清除「甲」的纪念日/);
  assert.equal(store.undoLast(store.getVersion()).error, null);
  assert.deepEqual(store.list().members[0].birthday, { month: 5, day: 6 });
  assert.equal(store.list().undo, null); // 不能重复撤销
});

test('撤销快照随纪念日落盘：重启后撤销重命名，纪念日随快照完整恢复', () => {
  const file = tmpFile();
  const s1 = createStore(file);
  const a = s1.addMember('甲').member;
  s1.setAnniversaries(a.id, { birthday: { month: 2, day: 29 }, deathday: { month: 11, day: 3 } });
  s1.renameMember(a.id, '甲某'); // 快照为「含纪念日、名为甲」的状态

  // 落盘的撤销快照里带着纪念日
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.undo.family.members[0].birthday, { month: 2, day: 29 });

  // 重启后撤销重命名：姓名与纪念日一起回到快照原貌
  const s2 = createStore(file);
  assert.equal(s2.undoLast(s2.getVersion()).error, null);
  const m = s2.list().members[0];
  assert.equal(m.name, '甲');
  assert.deepEqual(m.birthday, { month: 2, day: 29 });
  assert.deepEqual(m.deathday, { month: 11, day: 3 });
});

test('旧数据文件缺少纪念日字段：加载后视为未登记', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    maxMembers: 30,
    members: [
      { id: 'a', name: '甲' }, // 无纪念日字段
      { id: 'b', name: '乙', birthday: { month: 2, day: 30 } }, // 手工改坏的非法值
      { id: 'c', name: '丙', birthday: { month: 7, day: 7 }, deathday: null },
    ],
    edges: [],
  }));
  const store = createStore(file);
  const [a, b, c] = store.list().members;
  assert.equal(a.birthday, null);
  assert.equal(a.deathday, null);
  assert.equal(b.birthday, null); // 非法值被净化为未登记
  assert.deepEqual(c.birthday, { month: 7, day: 7 });
});

/* ---------------- 备份与恢复 ---------------- */

test('备份校验：纪念日合法时随成员返回，非法时逐项报错', () => {
  const ok = validateBackup({
    members: [
      { id: 'a', name: '甲', birthday: { month: 2, day: 29 }, deathday: null },
      { id: 'b', name: '乙' }, // 旧备份：无纪念日字段
    ],
    edges: [],
  });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.members[0].birthday, { month: 2, day: 29 });
  assert.equal(ok.members[0].deathday, null);
  assert.equal(ok.members[1].birthday, null);
  assert.equal(ok.members[1].deathday, null);

  const bad = validateBackup({
    members: [
      { id: 'a', name: '甲', birthday: { month: 2, day: 30 } },
      { id: 'b', name: '乙', deathday: { month: 4, day: 31 } },
    ],
    edges: [],
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.where === 'member' && e.index === 0 && /生日/.test(e.message)));
  assert.ok(bad.errors.some((e) => e.where === 'member' && e.index === 1 && /忌日/.test(e.message)));
});

test('备份恢复：纪念日随家谱整体迁移到另一台实例', () => {
  const source = createStore(tmpFile());
  const a = source.addMember('甲').member;
  const b = source.addMember('乙').member;
  source.setAnniversaries(a.id, { birthday: { month: 5, day: 6 }, deathday: { month: 7, day: 8 } });
  source.addEdge(a.id, b.id);
  const content = JSON.stringify({
    members: source.list().members.map((m) => ({
      id: m.id, name: m.name, birthday: m.birthday, deathday: m.deathday,
    })),
    edges: source.list().edges,
  });

  const target = createStore(tmpFile());
  const preview = target.previewRestore(content);
  assert.equal(preview.valid, true);
  assert.equal(target.restoreBackup(content, preview.fingerprint, target.getVersion()).error, null);
  const restored = target.list().members.find((m) => m.id === a.id);
  assert.deepEqual(restored.birthday, { month: 5, day: 6 });
  assert.deepEqual(restored.deathday, { month: 7, day: 8 });
  // 未登记的成员恢复后仍为 null
  const other = target.list().members.find((m) => m.id === b.id);
  assert.equal(other.birthday, null);

  // 恢复可被撤销：撤销后纪念日随旧家谱一并回来（此处旧家谱为空）
  assert.equal(target.undoLast(target.getVersion()).error, null);
  assert.equal(target.list().members.length, 0);
});

test('旧备份缺少纪念日字段：恢复后视为未登记', () => {
  const store = createStore(tmpFile());
  const content = JSON.stringify({
    members: [{ id: 'x', name: '旧甲' }, { id: 'y', name: '旧乙' }],
    edges: [{ parentId: 'x', childId: 'y' }],
  });
  const preview = store.previewRestore(content);
  assert.equal(preview.valid, true);
  assert.equal(store.restoreBackup(content, preview.fingerprint, store.getVersion()).error, null);
  for (const m of store.list().members) {
    assert.equal(m.birthday, null);
    assert.equal(m.deathday, null);
  }
});

test('恢复确认：备份中纪念日非法时重验失败、零写入', () => {
  const store = createStore(tmpFile());
  store.addMember('旧');
  const v = store.getVersion();
  const bad = JSON.stringify({
    members: [{ id: 'a', name: '甲', deathday: { month: 2, day: 30 } }],
    edges: [],
  });
  const preview = store.previewRestore(bad);
  assert.equal(preview.valid, false);
  const r = store.restoreBackup(bad, preview.fingerprint, v);
  assert.equal(r.status, 400);
  assert.ok(r.errors.some((e) => /忌日/.test(e.message)));
  // 零写入：数据与版本不变
  assert.equal(store.list().members.length, 1);
  assert.equal(store.list().members[0].name, '旧');
  assert.equal(store.getVersion(), v);
});
