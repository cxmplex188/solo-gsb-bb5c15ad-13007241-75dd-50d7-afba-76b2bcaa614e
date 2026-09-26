'use strict';

const path = require('path');
const express = require('express');
const { createStore } = require('./store');
const {
  findCommonAncestors,
  findGenerationConflicts,
  validateEdge,
  previewEdgeImpact,
  previewMemberDeletion,
  descendantBranches,
  MAX_DESCENDANT_GENERATIONS,
} = require('./familyGraph');
const { layoutFamilyChart } = require('./familyChart');
const { findCriticalLinks } = require('./criticalLinks');
const { parseLocalDate, upcomingAnniversaries } = require('./anniversaries');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'family.json');

const store = createStore(DATA_FILE);
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function sendError(res, status, message) {
  const payload = typeof message === 'string' ? { error: message } : message;
  return res.status(status).json(payload);
}

/**
 * 把 store 返回的错误对象转成 JSON 响应：优先使用其自带 status，
 * 并透传可识别的 code（如落盘失败 PERSIST_FAILED）与 currentVersion。
 */
function sendStoreError(res, result, fallbackStatus) {
  const payload = { error: result.error };
  if (result.code) payload.code = result.code;
  if (result.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
  return sendError(res, result.status || fallbackStatus, payload);
}

/** 统一的输入校验：从请求体取非空字符串字段 */
function requireId(body, field) {
  const value = body && typeof body[field] === 'string' ? body[field].trim() : '';
  return value || null;
}

function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 50);
}

/** 获取全部数据：成员 + 关系 */
app.get('/api/state', (req, res) => {
  res.json(store.list());
});

/** 新增成员（最多 30 人） */
app.post('/api/members', (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) return sendError(res, 400, '姓名不能为空');
  const result = store.addMember(name);
  if (result.error) return sendStoreError(res, result, 400);
  res.status(201).json(store.list());
});

/** 修改成员姓名（支持修改后重新查询） */
app.patch('/api/members/:id', (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) return sendError(res, 400, '姓名不能为空');
  const result = store.renameMember(req.params.id, name);
  if (result.error) return sendStoreError(res, result, 404);
  res.json(store.list());
});

/** 删除成员（级联删除相关关系；纪念日随成员一并删除） */
app.delete('/api/members/:id', (req, res) => {
  const result = store.deleteMember(req.params.id);
  if (result.error) return sendStoreError(res, result, 404);
  res.json(store.list());
});

/**
 * 登记 / 修改 / 清除成员纪念日：生日与忌日一次整体设定。
 * 请求体：{ "birthday": { "month": 3, "day": 15 } | null,
 *           "deathday": { "month": 10, "day": 2 } | null }
 * 两个字段都必须给出（不登记显式传 null）；非法月日（如 2 月 30 日）
 * 返回 400 且不改变任何数据。成功写入随成员数据持久化，可经「最近操作」撤销。
 */
app.put('/api/members/:id/anniversaries', (req, res) => {
  const result = store.setAnniversaries(req.params.id, req.body);
  if (result.error) return sendStoreError(res, result, 400);
  res.json(store.list());
});

/**
 * 未来 30 天纪念日清单（只读）：按浏览器提交的本地日期生成，包含当天。
 * 查询参数 from=YYYY-MM-DD（省略时取服务器本地当天；格式非法返回 400）。
 * 逐年求每项纪念日的下一次发生日期：2 月 29 日在平年落到 2 月 28 日，跨年准确；
 * 同日按姓名、类型（生日先于忌日）稳定排序，每项附距今天数 daysUntil（当天为 0）。
 */
app.get('/api/anniversaries/upcoming', (req, res) => {
  let from;
  if (typeof req.query.from === 'string' && req.query.from.trim()) {
    from = parseLocalDate(req.query.from);
    if (!from) {
      return sendError(res, 400, 'from 参数必须是合法的公历日期（YYYY-MM-DD），如 2026-09-25');
    }
  } else {
    const now = new Date();
    from = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }
  res.json(upcomingAnniversaries(store.getState().members, from));
});

/**
 * 添加 父母→子女 关系。
 * 服务端拒绝：自指、重复边、超过两位父母、祖先环路。
 */
app.post('/api/edges', (req, res) => {
  const parentId = requireId(req.body, 'parentId');
  const childId = requireId(req.body, 'childId');
  if (!parentId || !childId) return sendError(res, 400, '请选择父母与子女');

  // 双重校验（store.addEdge 内部同样校验，保证单一规则来源）
  const check = validateEdge(store.getState(), parentId, childId);
  if (check.error) return sendError(res, 400, check.error);

  const result = store.addEdge(parentId, childId);
  if (result.error) return sendStoreError(res, result, 400);
  res.status(201).json(store.list());
});

/** 删除关系（修改关系 = 删除后重新添加） */
app.delete('/api/edges', (req, res) => {
  const parentId = requireId(req.body, 'parentId');
  const childId = requireId(req.body, 'childId');
  if (!parentId || !childId) return sendError(res, 400, '缺少关系参数');
  const result = store.deleteEdge(parentId, childId);
  if (result.error) return sendStoreError(res, result, 404);
  res.json(store.list());
});

/**
 * 变更影响预览（只读，不写入任何数据）：
 * 以当前家谱为基准，假设「新增一条父母→子女关系」或「移除一条现有关系」，
 * 构造不落盘的假设图，对比变更前后的辈分矛盾——按祖先与后代成员对列出
 * 新增、消失与代数范围变化的矛盾，每条给出变化前后两侧的最短与最长成员链
 * （不是只比较矛盾总数）。
 * 新增沿用与真实建边完全相同的校验（成员存在、重复、父母上限、祖先环路），
 * 失败返回 400 并说明原因；移除的目标关系不存在同样返回 400。
 * 响应携带当前家谱版本 version：页面据此标注「基于版本 N」，
 * 家谱发生写入后应提示重新预览。
 * 请求体：{ action: 'add' | 'remove', parentId, childId }
 */
app.post('/api/edges/impact/preview', (req, res) => {
  const result = previewEdgeImpact(store.getState(), {
    action: req.body && req.body.action,
    parentId: requireId(req.body, 'parentId') || '',
    childId: requireId(req.body, 'childId') || '',
  });
  if (result.error) return sendError(res, 400, result.error);

  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const nameOf = (id) => byId.get(id) || '（已删除）';
  const decorateProfile = (p) =>
    p && {
      minGen: p.minGen,
      maxGen: p.maxGen,
      shortestPath: p.shortestPath.map((id) => ({ id, name: nameOf(id) })),
      longestPath: p.longestPath.map((id) => ({ id, name: nameOf(id) })),
    };
  const decorateItem = (item) => ({
    ancestorId: item.ancestorId,
    ancestorName: nameOf(item.ancestorId),
    descendantId: item.descendantId,
    descendantName: nameOf(item.descendantId),
    before: decorateProfile(item.before),
    after: decorateProfile(item.after),
  });

  res.json({
    version: store.getVersion(),
    action: result.action,
    parentId: result.parentId,
    parentName: nameOf(result.parentId),
    childId: result.childId,
    childName: nameOf(result.childId),
    beforeTotal: result.beforeTotal,
    afterTotal: result.afterTotal,
    unchangedCount: result.unchangedCount,
    added: result.added.map(decorateItem),
    removed: result.removed.map(decorateItem),
    changed: result.changed.map(decorateItem),
  });
});

/**
 * 删除成员影响预览（只读，不写入任何数据）：
 * 以当前家谱为基准构造不落盘的只读假设图——移除该成员及其相连的全部亲子关系，
 * 只比较删除后仍在谱中的有序「祖先 → 后代」成员对（以删除前原本可达为准），
 * 按最短代数逐对判定：原本可达而删除后不可达的列入 disconnected（删除后链为空），
 * 仍可达但最短代数增加的列入 lengthened（仍有同代替代路径的不报断联），
 * 每条给出变更前后各一条最短成员链。响应携带当前家谱版本 version：
 * 页面据此标注「基于版本 N」，家谱发生写入后结果标记过期、需重新预览。
 * 请求体：{ memberId }
 */
app.post('/api/members/delete-impact/preview', (req, res) => {
  const memberId = requireId(req.body, 'memberId');
  if (!memberId) return sendError(res, 400, '请选择要预览删除的成员');

  const result = previewMemberDeletion(store.getState(), memberId);
  if (result.error) return sendError(res, 400, result.error);

  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const nameOf = (id) => byId.get(id) || '（已删除）';
  const decorateChain = (path) => path.map((id) => ({ id, name: nameOf(id) }));
  const decorateProfile = (p) =>
    p && { minGen: p.minGen, shortestPath: decorateChain(p.shortestPath) };
  const decorateItem = (item) => ({
    ancestorId: item.ancestorId,
    ancestorName: nameOf(item.ancestorId),
    descendantId: item.descendantId,
    descendantName: nameOf(item.descendantId),
    ...(item.genIncrease !== undefined ? { genIncrease: item.genIncrease } : {}),
    before: decorateProfile(item.before),
    after: decorateProfile(item.after),
  });

  res.json({
    version: store.getVersion(),
    memberId: result.memberId,
    memberName: nameOf(result.memberId),
    removedEdgeCount: result.removedEdgeCount,
    remainingMemberCount: result.remainingMemberCount,
    comparedCount: result.comparedCount,
    disconnectedCount: result.disconnectedCount,
    lengthenedCount: result.lengthenedCount,
    unaffectedCount: result.unaffectedCount,
    disconnected: result.disconnected.map(decorateItem),
    lengthened: result.lengthened.map(decorateItem),
  });
});

/** 为预检结果补上成员姓名（成员可能已在预检前被删除） */
function decorateBatchResult(result) {
  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  return {
    version: store.getVersion(),
    valid: result.valid,
    error: result.error,
    items: result.items.map((item) => ({
      index: item.index,
      parentId: item.parentId,
      childId: item.childId,
      parentName: item.parentId ? byId.get(item.parentId) || '（已删除）' : '',
      childName: item.childId ? byId.get(item.childId) || '（已删除）' : '',
      errors: item.errors,
    })),
  };
}

/**
 * 批量关系预检：在「当前关系 + 整批草稿」的合并结果上校验
 * 成员存在、自指、批内及已有重复、父母上限与祖先环路。
 * 不写入任何数据，只返回每条草稿的错误、整批可否提交及当前家谱版本。
 * 请求体：{ edges: [{ parentId, childId }, ...] }
 */
app.post('/api/edges/batch/preview', (req, res) => {
  const edges = req.body && req.body.edges;
  const result = store.validateEdgeBatch(edges);
  res.json(decorateBatchResult(result));
});

/**
 * 批量关系提交：必须携带预检返回的家谱版本 version。
 * 服务端重新比对版本并重跑全部校验：版本变化（409）或任何一条非法（400）
 * 都整批拒绝、不写入任何一条；合法时整批一次持久化并返回最新关系列表。
 * 请求体：{ version: number, edges: [...] }
 */
app.post('/api/edges/batch', (req, res) => {
  const edges = req.body && req.body.edges;
  const expectedVersion = req.body && req.body.version;
  const result = store.commitEdges(edges, expectedVersion);
  if (result.error) {
    const payload = { error: result.error };
    if (result.code) payload.code = result.code;
    if (result.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
    // 非法条目明细一并返回，便于前端展示每条错误
    if (result.result) payload.preview = decorateBatchResult(result.result);
    return sendError(res, result.status || 400, payload);
  }
  res.status(201).json(store.list());
});

/** 为合并预览的结果补上成员姓名与可读冲突信息（不写入数据） */
function decorateMergeResult(result) {
  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const nameOf = (id) => byId.get(id) || '（已删除）';

  const conflicts = result.conflicts.map((c) => {
    if (c.type === 'self') {
      return {
        type: c.type,
        memberId: c.parentId,
        memberName: nameOf(c.parentId),
        message:
          `拒绝自指关系：合并后「${nameOf(c.originParentId)}」与「${nameOf(c.originChildId)}」` +
          `变成同一人「${nameOf(c.parentId)}」，将产生其成为自己父母的关系`,
      };
    }
    if (c.type === 'too-many-parents') {
      return {
        type: c.type,
        childId: c.childId,
        childName: nameOf(c.childId),
        count: c.count,
        message:
          `每名子女至多 2 位父母：合并后「${nameOf(c.childId)}」将有 ${c.count} 位父母` +
          `（${c.parentIds.map((id) => `「${nameOf(id)}」`).join('、')}）`,
      };
    }
    // cycle
    return {
      type: c.type,
      parentId: c.parentId,
      parentName: nameOf(c.parentId),
      childId: c.childId,
      childName: nameOf(c.childId),
      message:
        `拒绝祖先环路：合并后「${nameOf(c.parentId)}」将成为「${nameOf(c.childId)}」的后代，` +
        `形成循环祖先关系`,
    };
  });

  return {
    version: store.getVersion(),
    valid: result.valid,
    error: result.error,
    keepId: result.keepId,
    keepName: nameOf(result.keepId),
    mergeId: result.mergeId,
    mergeName: nameOf(result.mergeId),
    originalEdgeCount: result.originalEdgeCount,
    affectedEdgeCount: result.affectedEdgeCount,
    removedDuplicateCount: result.removedDuplicateCount,
    edges: result.edges.map((e) => ({
      parentId: e.parentId,
      childId: e.childId,
      parentName: nameOf(e.parentId),
      childName: nameOf(e.childId),
      replaced: e.replaced,
    })),
    conflicts,
  };
}

/**
 * 合并重复成员预检：选择保留成员与被合并成员。
 * 将被合并成员在全部父母→子女关系中的 ID 替换为保留成员后去重，
 * 返回合并后的关系、去重数量与全部冲突（自指 / 超过两位父母 / 祖先环路）。
 * 预览不修改家谱，仅返回当前家谱版本。
 * 请求体：{ keepId, mergeId }
 */
app.post('/api/members/merge/preview', (req, res) => {
  const keepId = requireId(req.body, 'keepId');
  const mergeId = requireId(req.body, 'mergeId');
  if (!keepId || !mergeId) return sendError(res, 400, '请选择保留成员与被合并成员');

  const result = store.previewMerge(keepId, mergeId);
  if (result.error && result.valid === undefined) {
    return sendError(res, 400, result.error);
  }
  res.json(decorateMergeResult(result));
});

/**
 * 合并重复成员提交：必须携带预览返回的家谱版本 version。
 * 服务端重新比对版本并按同一规则重算：版本变化（409）或仍有冲突（400）
 * 都整单拒绝、不修改任何数据；合法时保留保留成员姓名、去重关系、删除被合并成员，
 * 一次落盘且版本加一。
 * 请求体：{ version: number, keepId, mergeId }
 */
app.post('/api/members/merge', (req, res) => {
  const keepId = requireId(req.body, 'keepId');
  const mergeId = requireId(req.body, 'mergeId');
  if (!keepId || !mergeId) return sendError(res, 400, '请选择保留成员与被合并成员');

  const result = store.commitMerge(keepId, mergeId, req.body && req.body.version);
  if (result.error) {
    const payload = { error: result.error };
    if (result.code) payload.code = result.code;
    if (result.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
    if (result.result) payload.preview = decorateMergeResult(result.result);
    return sendError(res, result.status || 400, payload);
  }
  res.status(201).json(store.list());
});

/**
 * 撤销最近一次成功写入（成员增删改、单条/批量关系变更、成员合并均覆盖）。
 * 每次成功写入时服务端已把「变更前的完整家谱」作为唯一撤销快照与新状态一起原子落盘，
 * 故重启后仍可撤销。请求必须携带当前所见版本 version：
 * 版本不符（其他标签页/脚本已修改家谱）返回 409 且数据保持不变；
 * 没有可撤销快照（从未变更或已经撤销过）同样返回 409。
 * 撤销成功后家谱版本继续 +1、快照清空（不能重复撤销），返回恢复后的完整 state。
 * 请求体：{ version: number }
 */
app.post('/api/undo', (req, res) => {
  const result = store.undoLast(req.body && req.body.version);
  if (result.error) return sendStoreError(res, result, 409);
  res.json({ ...store.list(), undone: result.label });
});

/**
 * 下载备份：仅含成员 ID、姓名、纪念日与父母→子女关系的 JSON 文件，
 * 可迁移到另一台本地实例恢复。不含版本号与撤销快照。
 */
app.get('/api/backup', (req, res) => {
  const data = store.list();
  const backup = {
    members: data.members.map((m) => ({
      id: m.id,
      name: m.name,
      birthday: m.birthday || null,
      deathday: m.deathday || null,
    })),
    edges: data.edges.map((e) => ({ parentId: e.parentId, childId: e.childId })),
  };
  const filename = `family-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.type('application/json').send(`${JSON.stringify(backup, null, 2)}\n`);
});

/**
 * 备份恢复预览（只读，不写入任何数据）：
 * 把备份文件原文整份严格校验（30 人上限、重复 ID、缺失端点、自指、
 * 重复关系、每名子女至多两位父母、祖先环路），逐项返回全部问题；
 * 通过时返回将恢复的成员/关系数量、内容指纹 fingerprint 与当前家谱版本 version。
 * 请求体：{ content: "<备份文件原文>" }
 */
app.post('/api/backup/restore/preview', (req, res) => {
  const content = req.body && req.body.content;
  if (typeof content !== 'string' || !content.trim()) {
    return sendError(res, 400, '请提供备份文件内容（content 字段）');
  }
  const result = store.previewRestore(content);
  res.json({
    version: store.getVersion(),
    valid: result.valid,
    error: result.error,
    errors: result.errors,
    memberCount: result.memberCount,
    edgeCount: result.edgeCount,
    memberNames: result.members.map((m) => m.name),
    fingerprint: result.fingerprint,
  });
});

/**
 * 备份恢复确认：必须携带预览返回的家谱版本 version 与内容指纹 fingerprint。
 * 服务端重新计算指纹并整份重验：版本过期或文件被调换（409）、重验失败（400，
 * 带逐项 errors）都整单拒绝、不修改任何数据；成功时原子替换整个家谱、
 * 版本 +1 并纳入最近一次撤销（变更前家谱成为唯一可撤销快照）。
 * 请求体：{ version: number, fingerprint: string, content: "<备份文件原文>" }
 */
app.post('/api/backup/restore', (req, res) => {
  const body = req.body || {};
  const result = store.restoreBackup(body.content, body.fingerprint, body.version);
  if (result.error) {
    const payload = { error: result.error };
    if (result.code) payload.code = result.code;
    if (result.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
    if (result.errors) payload.errors = result.errors;
    return sendError(res, result.status || 400, payload);
  }
  res.json(store.list());
});

/**
 * 查询两人共同祖先：
 * 沿父母链 BFS，找出总代数最少的全部共同祖先，
 * 并返回双方到每个祖先的全部最短亲缘路径（同代数不同路径全部保留）。
 */
app.get('/api/common-ancestors', (req, res) => {
  const { personA, personB } = req.query;
  if (typeof personA !== 'string' || typeof personB !== 'string') {
    return sendError(res, 400, '请选择两位成员');
  }
  const result = findCommonAncestors(store.getState(), personA, personB);
  if (result.error) return sendError(res, 404, result.error);

  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const decoratePath = (p) =>
    p.map((id) => ({ id, name: byId.get(id) || '（已删除）' }));

  res.json({
    samePerson: result.samePerson,
    minTotalGen: result.minTotalGen,
    ancestors: result.ancestors.map((a) => ({
      id: a.id,
      name: byId.get(a.id) || '（已删除）',
      genA: a.genA,
      genB: a.genB,
      totalGen: a.totalGen,
      pathsA: a.pathsA.map(decoratePath),
      pathsB: a.pathsB.map(decoratePath),
    })),
  });
});

/**
 * 辈分矛盾核查（只读，不写入任何数据）：
 * 枚举每一对存在祖先关系的成员，沿父母→子女关系分别求最少与最多代数，
 * 仅当两者不等时列为矛盾（同代不同路径不报警），
 * 每条结果给出代数差及最短、最长各一条完整成员链。
 * 可选查询参数 member=<id>：只返回该成员作为祖先或后代参与的矛盾
 * （total 仍为过滤前总数）。成员或关系变更后重新查询即得到最新结果。
 */
app.get('/api/generation-conflicts', (req, res) => {
  const memberId =
    typeof req.query.member === 'string' && req.query.member.trim()
      ? req.query.member.trim()
      : null;
  const result = findGenerationConflicts(store.getState(), memberId);
  if (result.error) return sendError(res, 404, result.error);

  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const nameOf = (id) => byId.get(id) || '（已删除）';
  const decoratePath = (p) =>
    p.map((id) => ({ id, name: nameOf(id) }));

  res.json({
    version: store.getVersion(),
    total: result.total,
    filtered: result.filtered,
    count: result.conflicts.length,
    conflicts: result.conflicts.map((c) => ({
      ancestorId: c.ancestorId,
      ancestorName: nameOf(c.ancestorId),
      descendantId: c.descendantId,
      descendantName: nameOf(c.descendantId),
      minGen: c.minGen,
      maxGen: c.maxGen,
      diff: c.diff,
      shortestPath: decoratePath(c.shortestPath),
      longestPath: decoratePath(c.longestPath),
    })),
  });
});

/**
 * 后代支系视图（只读，不写入任何数据）：
 * 以 root 为「始祖」、maxGen（1～10 的整数）为代数上限，沿父母→子女关系向下提取后代。
 * 同一后代经多条路径到达时只出现一次，按距始祖的最短代数（BFS 首达）分组，
 * 并标记其所属的每个始祖直系子女分支（在提取出的支系子图上做可达性判定，
 * 不限于最短路径）；仅保留两端都在支系内的亲子关系，不带入支系外成员。
 * 成员或关系变更后重新查询即得到最新结果；响应携带当前家谱版本 version，
 * 页面据此在发生写入后提示重新生成。
 * 查询参数：root=<成员 id>&maxGen=<1-10 的整数>
 */
app.get('/api/descendant-branches', (req, res) => {
  const rootId = typeof req.query.root === 'string' ? req.query.root.trim() : '';
  if (!rootId) return sendError(res, 400, '请选择始祖成员');
  const maxGenRaw = typeof req.query.maxGen === 'string' ? req.query.maxGen.trim() : '';
  const maxGen = Number(maxGenRaw);
  if (!Number.isInteger(maxGen) || maxGen < 1 || maxGen > MAX_DESCENDANT_GENERATIONS) {
    return sendError(res, 400, `代数上限必须是 1～${MAX_DESCENDANT_GENERATIONS} 的整数`);
  }
  const result = descendantBranches(store.getState(), rootId, maxGen);
  if (result.error) return sendError(res, 404, result.error);

  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const nameOf = (id) => byId.get(id) || '（已删除）';

  res.json({
    version: store.getVersion(),
    rootId,
    rootName: nameOf(rootId),
    maxGen,
    memberCount: result.members.length,
    edgeCount: result.edges.length,
    branches: result.branchRoots.map((id) => ({
      id,
      name: nameOf(id),
      memberCount: result.members.filter((m) => m.branches.includes(id)).length,
    })),
    members: result.members.map((m) => ({
      id: m.id,
      name: nameOf(m.id),
      gen: m.gen,
      branches: m.branches.map((id) => ({ id, name: nameOf(id) })),
    })),
    edges: result.edges.map((e) => ({
      parentId: e.parentId,
      parentName: nameOf(e.parentId),
      childId: e.childId,
      childName: nameOf(e.childId),
    })),
  });
});

/**
 * 整谱关系图布局（只读，不写入任何数据、不推进版本）：
 * 把当前全部成员与父母→子女关系排布成分层平面图，供前端绘制可缩放的 SVG 并下载。
 * 先按忽略方向的关系划分连通分量（分量之间留白），各分量按最长父母链分层；
 * 层内按直接父母节点横坐标的重心排序（平局按姓名、ID），没有父母的层按姓名、ID；
 * 多位父母指向同一子女时只布局一个成员节点并保留各条连线；节点与姓名互不重叠。
 * 空谱返回 empty: true。响应携带当前家谱版本 version 与图上的版本标注 caption，
 * 页面据此在图上标注生成时的版本，并在家谱写入后提示重新生成。
 */
app.get('/api/family-chart', (req, res) => {
  const layout = layoutFamilyChart(store.getState(), store.getVersion());
  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const nameOf = (id) => byId.get(id) || '（已删除）';
  res.json({
    version: store.getVersion(),
    ...layout,
    edges: layout.edges.map((e) => ({
      parentId: e.parentId,
      parentName: nameOf(e.parentId),
      childId: e.childId,
      childName: nameOf(e.childId),
    })),
  });
});

/**
 * 关键连接（桥梁关系）分析（只读，不写入任何数据、不推进版本）：
 * 把当前全部成员与父母→子女关系视为无向连接，按连通分量（原本互不连通的家族）
 * 分别找出「移除单条就会拆开其家族」的桥梁关系；每条给出关系两端、所属家族，
 * 以及断开后原家族两侧（父母一侧 / 子女一侧）各自的成员数与姓名名单。
 * 两端之间仍有其他连接路径的关系不会被误报。空谱返回 empty: true。
 * 响应携带当前家谱版本 version，页面据此在家谱写入后提示重新计算。
 */
app.get('/api/critical-links', (req, res) => {
  const result = findCriticalLinks(store.getState());
  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const nameOf = (id) => byId.get(id) || '（已删除）';
  const decorateSide = (ids) => ({ count: ids.length, members: ids.map((id) => ({ id, name: nameOf(id) })) });
  res.json({
    version: store.getVersion(),
    empty: result.empty,
    memberCount: result.memberCount,
    edgeCount: result.edgeCount,
    componentCount: result.componentCount,
    components: result.components.map((c) => ({
      index: c.index,
      memberCount: c.memberIds.length,
      bridgeCount: c.bridgeCount,
    })),
    bridgeCount: result.bridgeCount,
    bridges: result.bridges.map((b) => ({
      parentId: b.parentId,
      parentName: nameOf(b.parentId),
      childId: b.childId,
      childName: nameOf(b.childId),
      componentIndex: b.componentIndex,
      componentMemberCount: b.componentMemberCount,
      parentSide: decorateSide(b.parentSide),
      childSide: decorateSide(b.childSide),
    })),
  });
});

/** JSON 解析错误兜底 */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return sendError(res, 400, '请求体不是合法的 JSON');
  }
  if (err && err.type === 'entity.too.large') {
    return sendError(res, 413, '请求体过大：备份文件超出大小限制');
  }
  return next(err);
});

/** 未预期错误兜底：始终返回可识别的 JSON 错误（而非 Express 默认的 HTML 错误页） */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('未预期的服务器错误:', err);
  return sendError(res, 500, { error: `服务器内部错误：${err.message}`, code: 'INTERNAL_ERROR' });
});

// 直接运行（node server/index.js / npm start / Docker CMD）时启动监听；
// 被测试 require 时只导出 app，由测试自行监听随机端口。
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`家谱关系核对应用已启动: http://localhost:${PORT}`);
    console.log(`数据文件: ${DATA_FILE}`);
  });
}

module.exports = app;
