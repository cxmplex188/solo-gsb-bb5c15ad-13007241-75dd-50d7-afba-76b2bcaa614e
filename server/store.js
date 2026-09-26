'use strict';

/**
 * JSON 文件持久化：启动时读取，每次变更后同步写入（先写临时文件再 rename）。
 *
 * 先落盘、后发布：每次变更先在内存状态的深拷贝（候选家谱）上应用，
 * 把「候选家谱 + 新版本 + 撤销快照」完整写入磁盘（临时文件 + rename）成功后，
 * 才替换内存中的家谱、版本与撤销快照。临时文件写入或重命名失败时，
 * 内存中的成员、关系、纪念日、版本与最近一次撤销信息全部保持原值，
 * 本次临时文件被清理，调用方收到可识别的错误对象（HTTP 500，code: PERSIST_FAILED），
 * 写盘条件恢复后即可再次提交。普通变更、备份恢复与撤销都遵守此规则，
 * 因此不会出现「请求报错但 /api/state 已显示未落盘新数据」的状态漂移。
 *
 * 家谱版本 version：每次成功变更（成员增删改、关系增删/批量提交、合并、撤销）单调 +1，
 * 并随数据落盘。批量预检返回当时的 version，提交时必须原样带回；
 * 预检与提交之间家谱若被其他操作改动，version 不匹配则整批拒绝。
 *
 * 撤销（仅一级，不能重复撤销）：
 * 每次成功写入前，先把「变更前的完整家谱」（含成员 ID/姓名/纪念日、全部关系与当时版本）
 * 作为唯一可撤销快照 undo，与新状态、新版本在同一次写盘里原子持久化；
 * 因此重启后仍可撤销。撤销本身也是一次成功写入：恢复快照后 version 继续 +1、
 * 快照清空并落盘，之后不能再次撤销（redo 不存在），直到下一次成功写入产生新快照。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  createState,
  validateEdge,
  validateEdgeBatch,
  validateBackup,
  previewMergeMembers,
  isReachableUp,
  pairKeyOf,
  MAX_MEMBERS,
} = require('./familyGraph');
const {
  ANNIVERSARY_TYPES,
  TYPE_LABEL,
  validateMonthDay,
  sanitizeMonthDay,
} = require('./anniversaries');

/** 成员纪念日字段的序列化（深拷贝 { month, day }，缺失为 null） */
function serializeAnniversaries(member) {
  const copy = (md) => (md ? { month: md.month, day: md.day } : null);
  return {
    birthday: copy(member.birthday),
    deathday: copy(member.deathday),
  };
}

/** 纪念日月日的可读展示（用于撤销快照的操作说明） */
function monthDayLabel(md) {
  return md ? `${md.month}月${md.day}日` : '未登记';
}

function createStore(filePath) {
  const loaded = loadState(filePath);
  let state = loaded.state;
  let version = loaded.version;
  // 唯一可撤销快照：{ label, time, version, family } | null
  let undo = loaded.undo;

  /** 把当前内存状态序列化为边表格式的纯数据（深拷贝，与落盘格式一致） */
  function serializeFamily() {
    return {
      maxMembers: state.maxMembers,
      members: state.members.map((m) => ({
        id: m.id,
        name: m.name,
        ...serializeAnniversaries(m),
      })),
      edges: edgesList(state),
    };
  }

  /**
   * 统一的「先落盘、后发布」出口：把候选状态、新版本与撤销快照完整写入磁盘
   * （临时文件 + rename），全部成功后才替换内存中的家谱、版本与撤销快照。
   * 落盘失败时内存保持原值（本次临时文件由 writeFile 负责清理），
   * 返回可识别的错误对象；写盘条件恢复后可再次提交。
   * 成功返回 null，失败返回 { error, status: 500, code: 'PERSIST_FAILED' }。
   */
  function persistAndPublish(candidate, nextVersion, nextUndo) {
    try {
      writeFile(filePath, nextVersion, candidate, nextUndo);
    } catch (err) {
      return {
        error: `家谱数据写入磁盘失败，本次变更未生效：${err.message}`,
        status: 500,
        code: 'PERSIST_FAILED',
      };
    }
    state = candidate;
    version = nextVersion;
    undo = nextUndo;
    return null;
  }

  /**
   * 所有成功写入的统一入口：
   * 先抓取「变更前的完整家谱」作为唯一可撤销快照（覆盖旧快照），
   * 再在候选家谱（当前内存状态的深拷贝）上应用 mutate，随后把候选家谱、版本 +1
   * 与撤销快照写入同一个 JSON 文件（临时文件 + rename，原子落盘）；
   * 完整落盘成功后才发布到内存，落盘失败时内存数据保持原值并返回错误对象。
   * 校验必须在调用本函数之前完成，mutate 不应再返回错误。
   * mutate 以候选家谱为参数；返回一个状态对象可整体替换候选（备份恢复用）。
   * 返回 null 表示成功，返回错误对象表示落盘失败（内存未变）。
   */
  function commit(label, mutate) {
    const snapshot = {
      label,
      time: new Date().toISOString(),
      version,
      family: serializeFamily(),
    };
    let candidate = cloneState(state);
    const replacement = mutate(candidate);
    if (replacement) candidate = replacement;
    return persistAndPublish(candidate, version + 1, snapshot);
  }

  /**
   * 撤销最近一次成功写入：恢复快照中的完整家谱（成员 ID、姓名与关系原貌），
   * 撤销本身推进版本且清空快照，与新状态原子落盘；重启后同样可用。
   * 携带的 expectedVersion 必须等于当前版本（乐观锁，与批量/合并提交一致）：
   * 其他标签页已修改家谱（版本不符）时返回 409 且数据保持不变。
   * 撤销同样先落盘、后发布：落盘失败时家谱、版本与可撤销快照全部保持原值，
   * 恢复写盘条件后可重试。
   */
  function undoLast(expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return { error: '缺少家谱版本号，请刷新页面后再撤销', status: 400 };
    }
    if (expectedVersion !== version) {
      return {
        error: '家谱已被其他操作修改，无法撤销旧版本，请刷新后查看最近操作',
        status: 409,
        currentVersion: version,
      };
    }
    if (!undo) {
      return { error: '没有可撤销的最近操作', status: 409, currentVersion: version };
    }
    const restored = familyToState(undo.family);
    const label = undo.label;
    // 一次落盘：恢复状态、推进版本、清空快照；成功后才发布到内存
    const failed = persistAndPublish(restored, version + 1, null);
    if (failed) return failed;
    return { error: null, label };
  }

  /** 对外状态：附最近操作（撤销入口所需元数据，不含家谱副本） */
  function list() {
    return {
      version,
      maxMembers: state.maxMembers,
      members: state.members.map((m) => ({
        id: m.id,
        name: m.name,
        ...serializeAnniversaries(m),
      })),
      edges: edgesList(state),
      undo: undo
        ? { label: undo.label, time: undo.time, version: undo.version }
        : null,
    };
  }

  function addMember(rawName) {
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 50) : '';
    if (!name) return { error: '姓名不能为空' };
    if (state.members.length >= state.maxMembers) {
      return { error: `成员数量上限为 ${state.maxMembers} 人，无法继续添加` };
    }
    const member = { id: crypto.randomUUID(), name, birthday: null, deathday: null };
    const failed = commit(`添加成员「${name}」`, (s) => {
      s.members.push(member);
      s.parentsOf[member.id] = [];
    });
    if (failed) return failed;
    return { error: null, member };
  }

  function renameMember(id, rawName) {
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 50) : '';
    if (!name) return { error: '姓名不能为空' };
    const member = state.members.find((m) => m.id === id);
    if (!member) return { error: '成员不存在' };
    const previousName = member.name;
    const failed = commit(`重命名成员「${previousName}」→「${name}」`, (s) => {
      s.members.find((m) => m.id === id).name = name;
    });
    if (failed) return failed;
    return { error: null, member: state.members.find((m) => m.id === id) };
  }

  /**
   * 登记 / 修改 / 清除成员的纪念日（生日与忌日一次整体设定，null 表示不登记）。
   * 非法月日（如 2 月 30 日、13 月）整单拒绝且不改变任何数据；
   * 合法时走统一 commit 入口：版本 +1、产生撤销快照、随成员数据一次落盘。
   * 请求体必须同时给出 birthday 与 deathday 两个字段（不登记显式传 null），
   * 避免「漏传字段」被误当作「清除」。
   */
  function setAnniversaries(id, raw) {
    const member = state.members.find((m) => m.id === id);
    if (!member) return { error: '成员不存在', status: 404 };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: '请求体必须是对象：{ "birthday": …, "deathday": … }', status: 400 };
    }
    for (const type of ANNIVERSARY_TYPES) {
      if (!(type in raw)) {
        return {
          error: `缺少 ${type} 字段：请同时提供生日与忌日（不登记请显式传 null）`,
          status: 400,
        };
      }
    }
    const next = {};
    for (const type of ANNIVERSARY_TYPES) {
      const check = validateMonthDay(raw[type]);
      if (check.error) {
        return { error: `${TYPE_LABEL[type]}无效：${check.error}`, status: 400 };
      }
      next[type] = check.value;
    }

    const cleared = !next.birthday && !next.deathday;
    const label = cleared
      ? `清除「${member.name}」的纪念日`
      : `更新「${member.name}」的纪念日（生日 ${monthDayLabel(next.birthday)} · 忌日 ${monthDayLabel(next.deathday)}）`;
    const failed = commit(label, (s) => {
      const target = s.members.find((m) => m.id === id);
      target.birthday = next.birthday;
      target.deathday = next.deathday;
    });
    if (failed) return failed;
    return { error: null, member: state.members.find((m) => m.id === id) };
  }

  /** 删除成员：同时移除以其为父母或子女的全部边（级联）；纪念日随成员一并删除 */
  function deleteMember(id) {
    const member = state.members.find((m) => m.id === id);
    if (!member) return { error: '成员不存在' };
    const failed = commit(`删除成员「${member.name}」及其关系`, (s) => {
      s.members = s.members.filter((m) => m.id !== id);
      delete s.parentsOf[id];
      for (const childId of Object.keys(s.parentsOf)) {
        s.parentsOf[childId] = s.parentsOf[childId].filter((p) => p !== id);
      }
    });
    if (failed) return failed;
    return { error: null };
  }

  function addEdge(parentId, childId) {
    const check = validateEdge(state, parentId, childId);
    if (check.error) return check;
    const failed = commit(`建立关系「${memberName(parentId)} → ${memberName(childId)}」`, (s) => {
      s.parentsOf[childId].push(parentId);
    });
    if (failed) return failed;
    return { error: null };
  }

  function deleteEdge(parentId, childId) {
    const parents = state.parentsOf[childId];
    if (!parents || !parents.includes(parentId)) {
      return { error: '关系不存在' };
    }
    const failed = commit(`删除关系「${memberName(parentId)} → ${memberName(childId)}」`, (s) => {
      s.parentsOf[childId] = s.parentsOf[childId].filter((p) => p !== parentId);
    });
    if (failed) return failed;
    return { error: null };
  }

  function memberName(id) {
    const m = state.members.find((x) => x.id === id);
    return m ? m.name : '（已删除）';
  }

  /**
   * 整批原子提交父母→子女关系。
   * 先比对家谱版本（乐观锁），再在「当前关系 + 整批草稿」的合并结果上重跑
   * 与预检完全一致的校验；任何一条无效或版本已变化，都不写入任何一条。
   * 全部合法时一次性写入、一次落盘（只产生一个新版本与一份撤销快照）。
   */
  function commitEdges(edges, expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return { error: '缺少家谱版本号，请先预检后再提交', status: 400 };
    }
    if (expectedVersion !== version) {
      return {
        error: '家谱在预检后已被修改，请重新预检后再提交',
        status: 409,
        currentVersion: version,
      };
    }

    const result = validateEdgeBatch(state, edges);
    if (result.error) {
      return { error: result.error, status: 400, result };
    }

    // 全部合法：按批内去重后的边一次写入（校验已保证与现有关系不重复）。
    // 去重键按有序端点编码（pairKeyOf）：成员 ID 含 "|"、空格等字符时
    // 不同关系也不会碰撞，不会静默丢边。
    const seen = new Set();
    const toAdd = [];
    for (const item of result.items) {
      const key = pairKeyOf(item.parentId, item.childId);
      if (seen.has(key)) continue;
      seen.add(key);
      toAdd.push(item);
    }
    const failed = commit(`批量建立 ${toAdd.length} 条关系`, (s) => {
      for (const item of toAdd) s.parentsOf[item.childId].push(item.parentId);
    });
    if (failed) return failed;
    return { error: null };
  }

  /**
   * 合并成员预检：把 mergeId 在全部关系中的 ID 替换为 keepId 后去重、检测冲突。
   * 纯只读，不写入任何数据。
   */
  function previewMerge(keepId, mergeId) {
    return previewMergeMembers(state, keepId, mergeId);
  }

  /**
   * 合并成员提交（乐观锁 + 服务端重算）。
   * 先比对家谱版本，再按与预检完全相同的规则重新计算：
   * 版本变化（409）或仍有冲突（400）时整单拒绝、不修改任何数据；
   * 合法时保留保留成员的姓名，以合并后的边集整体替换关系，删除被合并成员，
   * 一次落盘且版本只加一（同时产生一份撤销快照）。
   */
  function commitMerge(keepId, mergeId, expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return { error: '缺少家谱版本号，请先预览后再提交', status: 400 };
    }
    if (expectedVersion !== version) {
      return {
        error: '家谱在预览后已被修改，请重新预览后再提交',
        status: 409,
        currentVersion: version,
      };
    }

    const result = previewMergeMembers(state, keepId, mergeId);
    if (result.error) {
      // 结构非法（成员不存在 / 同一人）属于请求错误
      if (result.valid === undefined) return { error: result.error, status: 400 };
      // 合并冲突：整单拒绝、零写入
      return { error: result.error, status: 400, result };
    }

    const keepName = memberName(keepId);
    const mergeName = memberName(mergeId);
    const mergedEdges = result.edges.map((e) => ({ parentId: e.parentId, childId: e.childId }));
    const failed = commit(`合并成员「${mergeName}」到「${keepName}」`, (s) => {
      // 一次应用：重建父母邻接表 + 删除被合并成员（保留成员姓名不动）
      s.members = s.members.filter((m) => m.id !== mergeId);
      for (const childId of Object.keys(s.parentsOf)) delete s.parentsOf[childId];
      for (const m of s.members) s.parentsOf[m.id] = [];
      for (const e of mergedEdges) {
        s.parentsOf[e.childId].push(e.parentId);
      }
    });
    if (failed) return failed;
    return { error: null };
  }

  /** 备份内容指纹（SHA-256）：预览与确认必须携带同一指纹，防止预览后文件被调换 */
  function fingerprintOf(content) {
    return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
  }

  /**
   * 备份恢复预览（只读，不修改任何数据、不推进版本）。
   * 解析备份原文并整份严格校验（30 人上限、重复 ID、缺失端点、自指、
   * 重复关系、每名子女至多两位父母、祖先环路），逐项返回全部问题；
   * 同时返回内容指纹，确认恢复时必须原样带回。
   */
  function previewRestore(content) {
    const fingerprint = fingerprintOf(content);
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        valid: false,
        error: '备份文件不是合法的 JSON',
        errors: [{ where: 'file', index: null, message: `JSON 解析失败：${err.message}` }],
        memberCount: 0,
        edgeCount: 0,
        members: [],
        edges: [],
        fingerprint,
      };
    }
    const result = validateBackup(parsed, state.maxMembers);
    return { ...result, fingerprint };
  }

  /**
   * 备份恢复确认（乐观锁 + 内容指纹 + 服务端重验）。
   * 版本不符（409，预览后家谱被修改）、指纹不符（409，文件在预览后被调换）
   * 或重验失败（400，逐项 errors）都整单拒绝、不修改任何数据；
   * 成功时以备份整体替换当前家谱，走统一 commit 入口：
   * 变更前完整家谱成为唯一撤销快照、版本 +1、一次落盘。
   */
  function restoreBackup(content, fingerprint, expectedVersion) {
    if (typeof content !== 'string' || !content.trim()) {
      return { error: '缺少备份文件内容', status: 400 };
    }
    if (typeof fingerprint !== 'string' || !fingerprint.trim()) {
      return { error: '缺少备份内容指纹，请先预览后再恢复', status: 400 };
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return { error: '缺少家谱版本号，请先预览后再恢复', status: 400 };
    }
    if (expectedVersion !== version) {
      return {
        error: '家谱在预览后已被修改，请重新预览后再恢复',
        status: 409,
        currentVersion: version,
      };
    }
    if (fingerprintOf(content) !== fingerprint.trim()) {
      return {
        error: '备份内容指纹不符：文件在预览后已被修改，请重新选择文件并预览',
        status: 409,
        currentVersion: version,
      };
    }
    // 服务端重验整份文件（与预览完全相同的规则）
    const check = previewRestore(content);
    if (!check.valid) {
      return { error: check.error, status: 400, errors: check.errors };
    }

    const restored = stateFromValidBackup(check.members, check.edges, state.maxMembers);
    // mutate 直接返回重建好的状态，整体替换候选家谱
    const failed = commit(`恢复备份（${check.memberCount} 名成员、${check.edgeCount} 条关系）`, () => restored);
    if (failed) return failed;
    return { error: null };
  }

  return {
    list,
    addMember,
    renameMember,
    setAnniversaries,
    deleteMember,
    addEdge,
    deleteEdge,
    commitEdges,
    validateEdgeBatch: (edges) => validateEdgeBatch(state, edges),
    previewMerge,
    commitMerge,
    previewRestore,
    restoreBackup,
    undoLast,
    getState: () => state,
    getVersion: () => version,
  };
}

/**
 * 统一落盘：新状态 + 新版本 + 唯一撤销快照写入同一文件（临时文件 + rename）。
 * 任一步骤失败都清理本次临时文件并抛出异常——调用方保证此时内存尚未发布新状态，
 * 因此请求失败时内存与磁盘都保持变更前的原值。
 */
function writeFile(filePath, version, state, undo) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const snapshot = {
    version,
    maxMembers: state.maxMembers,
    members: state.members.map((m) => ({
      id: m.id,
      name: m.name,
      ...serializeAnniversaries(m),
    })),
    edges: edgesList(state),
    undo: undo
      ? {
          label: undo.label,
          time: undo.time,
          version: undo.version,
          family: undo.family,
        }
      : null,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // 清理本次临时文件（可能尚未创建，清理失败不掩盖原始错误）
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* 临时文件不存在或已无法删除 */
    }
    throw err;
  }
}

/** 运行时状态的深拷贝（原样复制成员、纪念日与父母邻接表，不做任何净化） */
function cloneState(source) {
  const copy = createState(source.maxMembers);
  copy.members = source.members.map((m) => ({
    id: m.id,
    name: m.name,
    birthday: m.birthday ? { month: m.birthday.month, day: m.birthday.day } : null,
    deathday: m.deathday ? { month: m.deathday.month, day: m.deathday.day } : null,
  }));
  for (const [childId, parents] of Object.entries(source.parentsOf)) {
    copy.parentsOf[childId] = [...parents];
  }
  return copy;
}

function edgesList(state) {
  const edges = [];
  for (const [childId, parents] of Object.entries(state.parentsOf)) {
    for (const parentId of parents) edges.push({ parentId, childId });
  }
  return edges;
}

/** 把序列化的家谱（成员 + 边表）重建为运行时状态，复用与启动加载相同的净化规则 */
function familyToState(family) {
  return buildState({
    maxMembers: family.maxMembers,
    members: family.members,
    edges: family.edges,
  });
}

/**
 * 由已通过整份校验的备份数据重建运行时状态。
 * 与 buildState 的净化加载不同：此处数据已被 validateBackup 证明合法
 * （无重复 ID、无缺失端点、无自指/重复/超限/环路），按原样构建，不丢弃任何条目。
 */
function stateFromValidBackup(members, edges, maxMembers) {
  const state = createState(Number.isInteger(maxMembers) ? maxMembers : MAX_MEMBERS);
  for (const m of members) {
    state.members.push({
      id: m.id,
      name: m.name,
      birthday: m.birthday || null,
      deathday: m.deathday || null,
    });
    state.parentsOf[m.id] = [];
  }
  for (const e of edges) {
    state.parentsOf[e.childId].push(e.parentId);
  }
  return state;
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    return { state: createState(MAX_MEMBERS), version: 0, undo: null };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`无法解析数据文件 ${filePath}: ${err.message}`);
  }

  const state = buildState(raw);
  const version = Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 0;

  // 撤销快照同样落盘：重启后仍可撤销。快照是写盘时抓取的自身旧状态，
  // 仍走一遍净化规则，防止数据文件被手工改坏。
  let undo = null;
  const u = raw.undo;
  if (u && typeof u === 'object' && u.family && typeof u.family === 'object') {
    const label = typeof u.label === 'string' && u.label.trim() ? u.label.slice(0, 100) : '最近一次变更';
    const time = typeof u.time === 'string' ? u.time : new Date(0).toISOString();
    const snapshotVersion = Number.isInteger(u.version) && u.version >= 0 ? u.version : 0;
    undo = { label, time, version: snapshotVersion, family: serializeFamilyFromRaw(u.family) };
  }

  return { state, version, undo };
}

/** 从落盘 JSON（含兼容的 parentsOf 邻接表格式）构建净化后的运行时状态 */
function buildState(raw) {
  const state = createState(Number.isInteger(raw && raw.maxMembers) ? raw.maxMembers : MAX_MEMBERS);

  if (raw && Array.isArray(raw.members)) {
    for (const m of raw.members) {
      if (m && typeof m.id === 'string' && typeof m.name === 'string') {
        // 旧数据文件没有纪念日字段：净化后为 null（视为未登记）
        state.members.push({
          id: m.id,
          name: m.name,
          birthday: sanitizeMonthDay(m.birthday),
          deathday: sanitizeMonthDay(m.deathday),
        });
      }
    }
  }
  const ids = new Set(state.members.map((m) => m.id));
  if (raw && Array.isArray(raw.edges)) {
    for (const e of raw.edges) {
      if (e && ids.has(e.parentId) && ids.has(e.childId) && e.parentId !== e.childId) {
        (state.parentsOf[e.childId] ||= []).push(e.parentId);
      }
    }
  } else if (raw && raw.parentsOf && typeof raw.parentsOf === 'object') {
    // 兼容早期版本落盘的 parentsOf 邻接表格式
    for (const [childId, parents] of Object.entries(raw.parentsOf)) {
      if (!ids.has(childId) || !Array.isArray(parents)) continue;
      for (const parentId of parents) {
        if (ids.has(parentId) && parentId !== childId) {
          (state.parentsOf[childId] ||= []).push(parentId);
        }
      }
    }
  }
  for (const m of state.members) {
    const ps = state.parentsOf[m.id] || [];
    state.parentsOf[m.id] = [...new Set(ps)].slice(0, 2);
  }
  // 手工编辑数据文件可能引入环路（正常 API 路径已在写入前拦截）。
  // 按成员出现顺序做拓扑净化：丢弃会让父母链重新回到已处理成员的边，
  // 保证加载后的图一定是 DAG，避免查询时死循环。
  for (const child of state.members) {
    state.parentsOf[child.id] = state.parentsOf[child.id].filter(
      (parentId) => !isReachableUp(state, parentId, child.id),
    );
  }
  return state;
}

/** 净化撤销快照中保存的家谱，返回与序列化格式一致的纯数据 */
function serializeFamilyFromRaw(rawFamily) {
  const restored = buildState(rawFamily);
  return {
    maxMembers: restored.maxMembers,
    members: restored.members.map((m) => ({
      id: m.id,
      name: m.name,
      ...serializeAnniversaries(m),
    })),
    edges: edgesList(restored),
  };
}

module.exports = { createStore };
