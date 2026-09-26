'use strict';

/* 家谱关系核对 —— 原生前端逻辑 */

const state = {
  version: 0,
  maxMembers: 30,
  members: [],
  edges: [], // { parentId, childId }
  undo: null, // 最近一次可撤销操作：{ label, time, version } | null
};

// 批量录入草稿：{ key, parentId, childId }，key 仅用于前端定位，不参与判定
let draftSeq = 0;
const drafts = [];
// 最近一次预检结果：{ version, valid, error, byKey: Map<key, { errors, parentName, childName }> }
// 仅当 version 与当前家谱版本一致且草稿未被改动时有效
let preview = null;
let previewStale = false; // 预检后家谱/草稿是否已变化

// 记住下拉框的选择，数据刷新后尽量保持
const selection = {
  edgeParent: '',
  edgeChild: '',
  queryA: '',
  queryB: '',
  genFilter: '',
  mergeKeep: '',
  mergeRemove: '',
  impactParent: '',
  impactChild: '',
  branchRoot: '',
};

let queryStale = false; // 关系被修改后，共同祖先查询结果标记为过期
let genStale = false; // 成员或关系被修改后，辈分矛盾核查结果标记为过期

// 最近一次合并预览：{ version, keepId, mergeId, valid, ...服务端返回 }
// 仅当 version 与当前家谱版本一致且两人选择未改变时有效
let mergePreview = null;
let mergeStale = false;
let mergeStaleReason = '';

// 最近一次变更影响预览：{ version, action, parentId, childId, added, removed, changed, ...服务端返回 }
// 结果保持展示；家谱发生写入或预览条件变化后标记为过期并提示重新预览
let impactPreview = null;
let impactStale = false;
let impactStaleReason = '';

// 最近一次「删除成员影响预览」：{ version, memberId, disconnected, lengthened, ...服务端返回 }
// 结果保持展示；家谱发生写入（版本变化）后标记为过期并提示重新预览；目标成员被删除后清空
let memberImpactPreview = null;
let memberImpactStale = false;
let memberImpactStaleReason = '';

// 最近一次恢复预览：{ version, fingerprint, content, valid, errors, memberCount, edgeCount, memberNames }
// 仅当 version 与当前家谱版本一致且所选文件未变化时有效；确认时原样带回指纹与版本
let restorePreview = null;
let restoreStale = false;
let restoreStaleReason = '';

// 未来 30 天纪念日清单（服务端按浏览器提交的本地日期计算）：{ from, days, items }
let upcoming = null;

// 最近一次后代支系视图结果（服务端返回，含 version）
// 结果保持展示；家谱发生写入或查询条件变化后标记为过期并提示重新生成
let branchResult = null;
let branchStale = false;
let branchStaleReason = '';

// 最近一次整谱关系图结果（服务端返回，含 version 与分层布局）
// 结果保持展示；家谱发生写入后标记为过期并提示重新生成
let chartResult = null;
let chartStale = false;
let chartStaleReason = '';

// 最近一次关键连接分析结果（服务端返回，含 version 与桥梁明细）
// 结果保持展示；家谱发生写入后标记为过期并提示重新计算
let criticalResult = null;
let criticalStale = false;
let criticalStaleReason = '';

const $ = (id) => document.getElementById(id);

/** 安全创建 DOM 元素，避免 innerHTML 注入 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const nameOf = (id) => {
  const m = state.members.find((x) => x.id === id);
  return m ? m.name : '（已删除）';
};

/* ---------------- 网络请求 ---------------- */

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `请求失败（${res.status}）`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// 慢网络保护：完整家谱响应（/api/state 读取与一切写入的返回）必须按服务端 version
// 单调发布。旧读取可能先发出、在写入成功之后才返回；若无条件应用，旧响应会把成员、
// 关系与最近撤销信息整体回退。这里以「版本不小于已发布版本」为准入条件，任何过期
// 响应（含过期写入响应）都直接丢弃，不更新状态、不渲染、不使预览失效。
// 同版本的完整快照内容一致（写入不可变、只有新写入才推进版本），仅首次加载允许应用，
// 之后同版本响应同样视为过期，避免重复渲染与重复拉取纪念日清单。
let statePublished = false;

/**
 * 按版本单调发布一份完整家谱快照。
 * @returns {boolean} 是否已实际发布；false 表示响应版本过期、被丢弃。
 */
function publishState(data) {
  if (statePublished && data.version < state.version) return false;
  const versionChanged = data.version !== state.version;
  state.version = data.version;
  state.maxMembers = data.maxMembers;
  state.members = data.members;
  state.edges = data.edges;
  state.undo = data.undo || null;
  statePublished = true;
  reconcileSelection();
  if (versionChanged && preview && !previewStale) invalidatePreview('家谱已变化，请重新预检');
  if (versionChanged && mergePreview && !mergeStale) invalidateMergePreview('家谱已变化，请重新预览合并');
  if (versionChanged && impactPreview && !impactStale) {
    invalidateImpactPreview('家谱已发生写入，以下预览基于旧版本，请重新预览');
  }
  invalidateMemberImpactOnRefresh(versionChanged);
  if (versionChanged && restorePreview && !restoreStale) {
    invalidateRestorePreview('家谱已发生写入，以下恢复预览基于旧版本，请重新预览');
  }
  if (versionChanged && branchResult && !branchStale) {
    invalidateBranchResult('家谱已发生写入，以下支系视图基于旧版本，请重新生成');
  }
  if (versionChanged && chartResult && !chartStale) {
    invalidateChartResult('家谱已发生写入，以下关系图基于旧版本，请重新生成');
  }
  if (versionChanged && criticalResult && !criticalStale) {
    invalidateCriticalResult('家谱已发生写入，以下关键连接结果基于旧版本，请重新计算');
  }
  render();
  loadUpcoming();
  return true;
}

/** 拉取完整家谱：慢网络下迟到的旧读取若落后于已发布版本，会被 publishState 丢弃 */
async function refresh() {
  const data = await api('/api/state');
  return publishState(data);
}

/**
 * 家谱刷新后处理「删除影响预览」：
 * 被预览的成员已不在谱中（可能已被删除或被合并）→ 预览直接清空并回到占位提示；
 * 其余任何写入（版本推进）→ 保留展示但标记过期，提示重新预览。
 */
function invalidateMemberImpactOnRefresh(versionChanged) {
  if (!memberImpactPreview) return;
  if (!state.members.some((m) => m.id === memberImpactPreview.memberId)) {
    memberImpactPreview = null;
    memberImpactStale = false;
    memberImpactStaleReason = '';
    renderMemberImpactPlaceholder();
    return;
  }
  if (versionChanged && !memberImpactStale) {
    invalidateMemberImpactPreview('家谱已发生写入，以下删除影响预览基于旧版本，请重新预览');
  }
}

function reconcileSelection() {
  const ids = new Set(state.members.map((m) => m.id));
  for (const key of Object.keys(selection)) {
    if (!ids.has(selection[key])) selection[key] = '';
  }
}

/* ---------------- Toast ---------------- */

let toastTimer = null;
function toast(message, isError = false) {
  const box = $('toast');
  box.textContent = message;
  box.className = isError ? 'toast error' : 'toast';
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 3200);
}

/* ---------------- 渲染 ---------------- */

function render() {
  renderMembers();
  renderEdges();
  renderSelects();
  renderDrafts();
  renderMerge();
  renderStaleBanner();
  renderUndo();
  renderRestore();
  renderAnniversaries();
  renderUpcoming();
}

/* ---------------- 最近操作与撤销 ---------------- */

function formatUndoTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch (_) {
    return d.toISOString();
  }
}

function renderUndo() {
  const info = $('undo-info');
  const btn = $('undo-button');
  if (!state.undo) {
    info.textContent = '暂无可撤销的操作：成功添加/修改/删除成员、登记/清除纪念日、建立/删除关系、批量提交或合并成员后，此处会显示最近一次操作。';
    btn.disabled = true;
    btn.textContent = '撤销这次操作';
    return;
  }
  const time = formatUndoTime(state.undo.time);
  info.replaceChildren(
    el('strong', { text: state.undo.label }),
    document.createTextNode(time ? `（${time}，家谱版本 ${state.undo.version}）` : `（家谱版本 ${state.undo.version}）`),
  );
  btn.disabled = false;
  btn.textContent = `撤销：${state.undo.label}`;
}

/** 撤销最近一次成功写入：携带所见版本；其他标签页改动过家谱则被 409 拒绝且数据不变 */
async function undoLastChange() {
  if (!state.undo) { toast('没有可撤销的操作', true); return; }
  const label = state.undo.label;
  if (!confirm(`确定撤销「${label}」？\n家谱将恢复为该操作之前的成员 ID、姓名与全部关系，且撤销后不能再次撤销。`)) return;
  const btn = $('undo-button');
  btn.disabled = true;
  try {
    const data = await api('/api/undo', {
      method: 'POST',
      body: JSON.stringify({ version: state.version }),
    });
    publishState(data);
    markStale(); // 恢复后让已有共同祖先查询结果失效
    toast(`已撤销：${data.undone || label}`);
  } catch (err) {
    // 409：其他标签页已修改家谱（版本不符），或快照已不存在——拉取最新状态与最近操作
    if (err.status === 409) refresh().catch(() => {});
    toast(err.message, true);
  } finally {
    btn.disabled = !state.undo;
  }
}

$('undo-button').addEventListener('click', undoLastChange);

function renderMembers() {
  $('member-count').textContent = `${state.members.length}/${state.maxMembers}`;
  const list = $('member-list');
  list.replaceChildren();

  if (state.members.length === 0) {
    list.appendChild(el('li', { class: 'empty-hint', text: '尚未添加成员，请先在上方录入。' }));
    return;
  }

  // 父母计数，便于展示
  const parentCount = new Map();
  const childCount = new Map();
  for (const e of state.edges) {
    parentCount.set(e.parentId, (parentCount.get(e.parentId) || 0) + 1);
    childCount.set(e.childId, (childCount.get(e.childId) || 0) + 1);
  }

  for (const m of state.members) {
    const li = el('li');
    li.appendChild(el('span', { class: 'name', text: m.name }));
    li.appendChild(
      el('span', {
        class: 'sub',
        text: `子女 ${parentCount.get(m.id) || 0} · 父母 ${childCount.get(m.id) || 0}`,
      })
    );
    li.appendChild(el('button', {
      class: 'danger-link',
      text: '重命名',
      onClick: () => startRename(li, m),
    }));
    li.appendChild(el('button', {
      class: 'link-action',
      text: '删除影响',
      onClick: () => previewMemberDeletionImpact(m),
    }));
    li.appendChild(el('button', {
      class: 'danger-link',
      text: '删除',
      onClick: () => removeMember(m),
    }));
    list.appendChild(li);
  }
}

function startRename(li, member) {
  li.classList.add('renaming');
  li.replaceChildren();
  const input = el('input', {
    type: 'text',
    value: member.name,
    maxlength: '50',
  });
  const saveBtn = el('button', { type: 'button', text: '保存' });
  const cancelBtn = el('button', { type: 'button', text: '取消', class: 'danger-link' });

  const doSave = async () => {
    const name = input.value.trim();
    if (!name) { toast('姓名不能为空', true); return; }
    try {
      const data = await api(`/api/members/${encodeURIComponent(member.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      publishState(data);
      markStale();
      toast('已重命名');
    } catch (err) {
      toast(err.message, true);
    }
  };

  saveBtn.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
  });
  cancelBtn.addEventListener('click', () => render());
  li.append(input, saveBtn, cancelBtn);
  input.focus();
  input.select();
}

function renderEdges() {
  const list = $('edge-list');
  list.replaceChildren();

  if (state.edges.length === 0) {
    list.appendChild(el('li', {
      class: 'empty-hint',
      text: '尚未建立关系。选择父母与子女后点击「建立关系」。',
    }));
    return;
  }

  // 排序：先按子女姓名，再按父母姓名，便于查看
  const sorted = [...state.edges].sort((a, b) => {
    const ca = nameOf(a.childId), cb = nameOf(b.childId);
    if (ca !== cb) return ca.localeCompare(cb, 'zh');
    return nameOf(a.parentId).localeCompare(nameOf(b.parentId), 'zh');
  });

  for (const e of sorted) {
    const li = el('li');
    li.appendChild(el('span', { class: 'edge-text' }, [
      el('span', { class: 'p-name', text: nameOf(e.parentId) }),
      document.createTextNode(' → '),
      el('span', { class: 'c-name', text: nameOf(e.childId) }),
    ]));
    li.appendChild(el('button', {
      class: 'danger-link',
      text: '删除',
      onClick: () => removeEdge(e),
    }));
    list.appendChild(li);
  }
}

function renderSelects() {
  fillSelect($('edge-parent'), selection.edgeParent, '选择父母');
  fillSelect($('edge-child'), selection.edgeChild, '选择子女');
  fillSelect($('query-a'), selection.queryA, '选择成员甲');
  fillSelect($('query-b'), selection.queryB, '选择成员乙');
  fillSelect($('gen-filter'), selection.genFilter, '全部成员（不筛选）');
  fillSelect($('merge-keep'), selection.mergeKeep, '选择保留成员');
  fillSelect($('merge-remove'), selection.mergeRemove, '选择被合并成员');
  fillSelect($('impact-parent'), selection.impactParent, '选择父母');
  fillSelect($('impact-child'), selection.impactChild, '选择子女');
  fillSelect($('branch-root'), selection.branchRoot, '选择始祖');
}

function fillSelect(select, selectedId, placeholder) {
  const current = selectedId || select.value;
  select.replaceChildren();
  if (state.members.length === 0) {
    select.appendChild(el('option', { value: '', text: `（请先添加成员）` }));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.appendChild(el('option', { value: '', text: `（${placeholder}）` }));
  for (const m of state.members) {
    const attrs = { value: m.id, text: m.name };
    if (m.id === current) attrs.selected = 'selected';
    select.appendChild(el('option', attrs));
  }
  if (!current) select.value = '';
}

function renderStaleBanner() {
  renderOneStaleBanner(
    $('query-result'),
    queryStale,
    '⚠️ 关系在上次查询后发生过修改，以下结果可能已过期，请重新查询。',
  );
  renderOneStaleBanner(
    $('gen-result'),
    genStale,
    '⚠️ 成员或关系在上次核查后发生过修改，以下结果可能已过期，请重新核查。',
  );
  renderOneStaleBanner(
    $('impact-result'),
    impactStale,
    `⚠️ ${impactStaleReason || '家谱在上次预览后发生过写入，以下结果可能已过期，请重新预览。'}`,
  );
  renderOneStaleBanner(
    $('member-impact-result'),
    memberImpactStale,
    `⚠️ ${memberImpactStaleReason || '家谱在上次预览后发生过写入，以下结果可能已过期，请重新预览。'}`,
  );
  renderOneStaleBanner(
    $('branch-result'),
    branchStale,
    `⚠️ ${branchStaleReason || '家谱在上次生成后发生过写入，以下结果可能已过期，请重新生成。'}`,
  );
  renderOneStaleBanner(
    $('chart-result'),
    chartStale,
    `⚠️ ${chartStaleReason || '家谱在上次生成后发生过写入，以下关系图可能已过期，请重新生成。'}`,
  );
  renderOneStaleBanner(
    $('critical-result'),
    criticalStale,
    `⚠️ ${criticalStaleReason || '家谱在上次计算后发生过写入，以下关键连接结果可能已过期，请重新计算。'}`,
  );
  // 结果过期或尚未生成时禁止下载，避免导出与展示不一致的旧数据
  $('branch-export').disabled = !(branchResult && !branchStale);
  // 关系图过期、尚未生成或为空谱时禁止下载
  $('chart-download').disabled = !(chartResult && !chartStale && !chartResult.empty);
}

function renderOneStaleBanner(box, stale, message) {
  if (!box || !box.dataset.hasResult) return;
  const existing = box.querySelector('.stale-banner');
  if (stale) {
    if (existing) existing.textContent = message;
    else box.prepend(el('p', { class: 'stale-banner', text: message }));
  } else if (existing) {
    existing.remove();
  }
}

function markStale() {
  queryStale = true;
  genStale = true;
  renderStaleBanner();
}

/* ---------------- 事件处理 ---------------- */

$('member-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('member-name');
  const name = input.value.trim();
  if (!name) { toast('姓名不能为空', true); return; }
  try {
    const data = await api('/api/members', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    publishState(data);
    input.value = '';
    input.focus();
    toast('成员已添加');
  } catch (err) {
    toast(err.message, true);
  }
});

async function removeMember(member) {
  if (!confirm(`确定删除成员「${member.name}」？\n与之相关的全部父母/子女关系将一并删除。`)) return;
  try {
    const data = await api(`/api/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
    publishState(data);
    markStale();
    toast('成员已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

function syncSelectionFromForm() {
  selection.edgeParent = $('edge-parent').value;
  selection.edgeChild = $('edge-child').value;
  selection.queryA = $('query-a').value;
  selection.queryB = $('query-b').value;
  selection.genFilter = $('gen-filter').value;
  selection.mergeKeep = $('merge-keep').value;
  selection.mergeRemove = $('merge-remove').value;
  selection.impactParent = $('impact-parent').value;
  selection.impactChild = $('impact-child').value;
  selection.branchRoot = $('branch-root').value;
}

$('edge-parent').addEventListener('change', syncSelectionFromForm);
$('edge-child').addEventListener('change', syncSelectionFromForm);
$('query-a').addEventListener('change', syncSelectionFromForm);
$('query-b').addEventListener('change', syncSelectionFromForm);
$('gen-filter').addEventListener('change', syncSelectionFromForm);

// 合并的两个成员一旦改变，旧预览立即失效
$('merge-keep').addEventListener('change', () => {
  syncSelectionFromForm();
  invalidateMergePreview('保留成员已改变，请重新预览合并');
});
$('merge-remove').addEventListener('change', () => {
  syncSelectionFromForm();
  invalidateMergePreview('被合并成员已改变，请重新预览合并');
});
$('merge-form').addEventListener('submit', (e) => {
  e.preventDefault();
  previewMerge();
});

$('edge-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  syncSelectionFromForm();
  const parentId = $('edge-parent').value;
  const childId = $('edge-child').value;
  if (!parentId || !childId) { toast('请选择父母与子女', true); return; }
  if (parentId === childId) { toast('拒绝自指关系：不能成为自己的父母', true); return; }
  try {
    const data = await api('/api/edges', {
      method: 'POST',
      body: JSON.stringify({ parentId, childId }),
    });
    publishState(data);
    markStale();
    toast('关系已建立');
  } catch (err) {
    toast(err.message, true);
  }
});

async function removeEdge(edge) {
  if (!confirm(`确定删除关系「${nameOf(edge.parentId)} → ${nameOf(edge.childId)}」？`)) return;
  try {
    const data = await api('/api/edges', {
      method: 'DELETE',
      body: JSON.stringify({ parentId: edge.parentId, childId: edge.childId }),
    });
    publishState(data);
    markStale();
    toast('关系已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 批量关系草稿 ---------------- */

let staleReason = ''; // 预检失效原因（草稿变化或家谱版本变化）

function invalidatePreview(reason) {
  preview = null;
  previewStale = true;
  staleReason = reason;
  renderDrafts();
}

function draftKeys() {
  return drafts.map((d) => d.key);
}

function addDraftFromForm() {
  syncSelectionFromForm();
  const parentId = $('edge-parent').value;
  const childId = $('edge-child').value;
  if (!parentId || !childId) { toast('请选择父母与子女', true); return; }
  drafts.push({ key: `d${++draftSeq}`, parentId, childId });
  invalidatePreview('草稿已修改，请重新预检');
  renderDrafts();
}

function removeDraft(key) {
  const idx = drafts.findIndex((d) => d.key === key);
  if (idx >= 0) drafts.splice(idx, 1);
  invalidatePreview('草稿已修改，请重新预检');
  renderDrafts();
}

function clearDrafts() {
  if (drafts.length === 0) return;
  if (!confirm('确定清空全部草稿？（不会影响已有关系）')) return;
  drafts.length = 0;
  invalidatePreview('');
  previewStale = false;
  staleReason = '';
  renderDrafts();
}

/** 预检整批：每条草稿的错误 + 整批可否提交 + 当前家谱版本（不写入数据） */
async function previewBatch() {
  if (drafts.length === 0) { toast('草稿为空，无法预检', true); return; }
  const keys = draftKeys();
  const status = $('batch-status');
  status.hidden = false;
  status.className = 'batch-status info';
  status.textContent = '预检中…';
  try {
    const data = await api('/api/edges/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ edges: drafts.map((d) => ({ parentId: d.parentId, childId: d.childId })) }),
    });
    // 请求往返期间草稿可能已被改动：结果只对当时的草稿快照有效
    if (JSON.stringify(keys) !== JSON.stringify(draftKeys())) {
      invalidatePreview('草稿在预检期间已变化，请重新预检');
      return;
    }
    const byKey = new Map();
    for (const item of data.items) {
      byKey.set(keys[item.index], {
        errors: item.errors,
        parentName: item.parentName,
        childName: item.childName,
      });
    }
    preview = { version: data.version, valid: data.valid, byKey, keys };
    previewStale = false;
    staleReason = '';
    renderDrafts();
  } catch (err) {
    toast(err.message, true);
    renderDrafts();
  }
}

/** 提交整批：必须携带预检返回的版本；任何一条非法或期间家谱变化都会被整批拒绝 */
async function submitBatch() {
  if (!preview || previewStale || !preview.valid) {
    toast('请先预检且整批全部合法后再提交', true);
    return;
  }
  const btn = $('batch-submit');
  btn.disabled = true;
  try {
    const data = await api('/api/edges/batch', {
      method: 'POST',
      body: JSON.stringify({
        version: preview.version,
        edges: drafts.map((d) => ({ parentId: d.parentId, childId: d.childId })),
      }),
    });
    drafts.length = 0;
    preview = null;
    previewStale = false;
    staleReason = '';
    publishState(data);
    markStale();
    toast('整批关系已一次写入');
  } catch (err) {
    // 409 版本冲突：服务端家谱已更新，拉取最新状态并要求重新预检
    if (/重新预检/.test(err.message)) {
      invalidatePreview('家谱在预检后已被修改，请重新预检后再提交');
      refresh().catch(() => {});
    }
    toast(err.message, true);
    renderDrafts();
  } finally {
    btn.disabled = false;
  }
}

function renderDrafts() {
  const list = $('draft-list');
  const empty = $('draft-empty');
  const count = $('draft-count');
  const status = $('batch-status');
  const submitBtn = $('batch-submit');
  const previewBtn = $('batch-preview');

  count.textContent = String(drafts.length);
  list.replaceChildren();

  if (drafts.length === 0) {
    empty.hidden = false;
    list.hidden = true;
    status.hidden = true;
    submitBtn.disabled = true;
    previewBtn.disabled = true;
    return;
  }
  empty.hidden = true;
  list.hidden = false;
  previewBtn.disabled = false;

  const currentKeys = JSON.stringify(draftKeys());
  const previewLive = preview && !previewStale && JSON.stringify(preview.keys) === currentKeys;

  for (const [i, d] of drafts.entries()) {
    const info = previewLive ? preview.byKey.get(d.key) : null;
    const rowInvalid = !!(info && info.errors.length > 0);
    const li = el('li', { class: rowInvalid ? 'draft-row invalid' : info ? 'draft-row valid' : 'draft-row' });

    const head = el('div', { class: 'draft-main' });
    head.appendChild(el('span', { class: 'draft-index', text: `#${i + 1}` }));
    head.appendChild(el('span', { class: 'edge-text' }, [
      el('span', { class: 'p-name', text: info ? info.parentName : nameOf(d.parentId) }),
      document.createTextNode(' → '),
      el('span', { class: 'c-name', text: info ? info.childName : nameOf(d.childId) }),
    ]));
    if (info) {
      head.appendChild(el('span', {
        class: rowInvalid ? 'draft-tag bad' : 'draft-tag ok',
        text: rowInvalid ? `✗ ${info.errors.length} 项错误` : '✓ 合法',
      }));
    }
    head.appendChild(el('button', {
      class: 'danger-link',
      text: '移除',
      onClick: () => removeDraft(d.key),
    }));
    li.appendChild(head);

    if (info && rowInvalid) {
      const ul = el('ul', { class: 'draft-errors' });
      for (const msg of info.errors) ul.appendChild(el('li', { text: msg }));
      li.appendChild(ul);
    }
    list.appendChild(li);
  }

  // 整批状态提示
  status.hidden = false;
  if (!previewLive) {
    status.className = 'batch-status warn';
    status.textContent = staleReason || '草稿尚未预检，或预检结果已失效：请点击「预检整批」。';
    submitBtn.disabled = true;
    return;
  }
  if (preview.valid) {
    status.className = 'batch-status ok';
    status.textContent =
      `预检通过：${drafts.length} 条草稿全部合法，整批可以提交。提交将基于家谱版本 ${preview.version} 原子写入；若期间家谱被修改会被拒绝。`;
    submitBtn.disabled = false;
  } else {
    const bad = drafts.filter((d) => (preview.byKey.get(d.key) || { errors: [] }).errors.length > 0).length;
    status.className = 'batch-status error';
    status.textContent =
      `预检未通过：${bad}/${drafts.length} 条草稿存在错误（见各行下方），整批不可提交；修正草稿后请重新预检。`;
    submitBtn.disabled = true;
  }
}

$('draft-add').addEventListener('click', addDraftFromForm);
$('batch-preview').addEventListener('click', previewBatch);
$('batch-submit').addEventListener('click', submitBatch);
$('batch-clear').addEventListener('click', clearDrafts);

/* ---------------- 合并重复成员 ---------------- */

function invalidateMergePreview(reason) {
  mergePreview = null;
  mergeStale = true;
  mergeStaleReason = reason;
  renderMerge();
}

/** 预览是否对应当前两位选择且版本未变 */
function mergePreviewLive() {
  if (!mergePreview || mergeStale) return false;
  if (mergePreview.version !== state.version) return false;
  if (mergePreview.keepId !== selection.mergeKeep) return false;
  if (mergePreview.mergeId !== selection.mergeRemove) return false;
  return true;
}

/** 预览合并：替换 ID、去重、列出冲突；预览不修改家谱 */
async function previewMerge() {
  syncSelectionFromForm();
  const keepId = selection.mergeKeep;
  const mergeId = selection.mergeRemove;
  if (!keepId || !mergeId) { toast('请选择保留成员与被合并成员', true); return; }
  if (keepId === mergeId) { toast('保留成员与被合并成员不能是同一人', true); return; }

  const status = $('merge-status');
  status.hidden = false;
  status.className = 'batch-status info';
  status.textContent = '预览中…（不会修改家谱）';
  try {
    const data = await api('/api/members/merge/preview', {
      method: 'POST',
      body: JSON.stringify({ keepId, mergeId }),
    });
    // 请求往返期间选择可能已被改动：结果只对当时的两人快照有效
    if (keepId !== selection.mergeKeep || mergeId !== selection.mergeRemove) {
      invalidateMergePreview('选择在预览期间已变化，请重新预览合并');
      return;
    }
    mergePreview = data;
    mergeStale = false;
    mergeStaleReason = '';
    renderMerge();
  } catch (err) {
    toast(err.message, true);
    renderMerge();
  }
}

/** 提交合并：携带预览版本；版本变化或仍有冲突时服务端整单拒绝、不改数据 */
async function submitMerge() {
  if (!mergePreviewLive() || !mergePreview.valid) {
    toast('请先预览且不存在冲突后再提交合并', true);
    return;
  }
  const btn = $('merge-submit');
  btn.disabled = true;
  const { keepId, mergeId, keepName, mergeName } = mergePreview;
  try {
    const data = await api('/api/members/merge', {
      method: 'POST',
      body: JSON.stringify({ version: mergePreview.version, keepId, mergeId }),
    });
    mergePreview = null;
    mergeStale = false;
    mergeStaleReason = '';
    selection.mergeKeep = '';
    selection.mergeRemove = '';
    publishState(data);
    markStale();
    toast(`已将「${mergeName}」并入「${keepName}」，保留成员「${keepName}」`);
  } catch (err) {
    if (/重新预览/.test(err.message)) {
      invalidateMergePreview('家谱在预览后已被修改，请重新预览后再提交');
      refresh().catch(() => {});
    }
    toast(err.message, true);
    renderMerge();
  } finally {
    btn.disabled = false;
  }
}

$('merge-preview').addEventListener('click', previewMerge);
$('merge-submit').addEventListener('click', submitMerge);

function renderMerge() {
  const empty = $('merge-empty');
  const status = $('merge-status');
  const result = $('merge-result');
  const previewBtn = $('merge-preview');
  const submitBtn = $('merge-submit');
  const form = $('merge-form');

  if (state.members.length < 2) {
    empty.hidden = false;
    form.hidden = true;
    status.hidden = true;
    result.hidden = true;
    previewBtn.disabled = true;
    submitBtn.disabled = true;
    return;
  }
  empty.hidden = true;
  form.hidden = false;
  previewBtn.disabled = false;

  // 同一人时禁止预览/提交
  const sameChosen = !!selection.mergeKeep && selection.mergeKeep === selection.mergeRemove;
  const live = mergePreviewLive();

  if (!live) {
    result.hidden = true;
    status.hidden = false;
    if (sameChosen) {
      status.className = 'batch-status error';
      status.textContent = '保留成员与被合并成员不能是同一人。';
    } else {
      status.className = 'batch-status warn';
      status.textContent = mergeStaleReason || '尚未预览，或预览结果已失效：请点击「预览合并」。';
    }
    submitBtn.disabled = true;
    return;
  }

  status.hidden = false;
  result.hidden = false;
  renderMergeResult(result, mergePreview);

  if (mergePreview.valid) {
    status.className = 'batch-status ok';
    status.textContent =
      `预览通过：合并后保留「${mergePreview.keepName}」、删除「${mergePreview.mergeName}」，` +
      `共 ${mergePreview.edges.length} 条关系（${mergePreview.affectedEdgeCount} 条涉及被合并成员，` +
      `去重移除 ${mergePreview.removedDuplicateCount} 条重复关系）。` +
      `提交基于家谱版本 ${mergePreview.version}，只落盘一次并使版本加一；期间家谱被修改会被拒绝。`;
    submitBtn.disabled = false;
  } else {
    status.className = 'batch-status error';
    status.textContent =
      `预览发现 ${mergePreview.conflicts.length} 项冲突（见下），已禁止提交；` +
      `请调整保留/被合并成员或先修正家谱关系后重新预览。`;
    submitBtn.disabled = true;
  }
}

function renderMergeResult(box, data) {
  box.replaceChildren();

  // 冲突清单
  if (data.conflicts.length > 0) {
    const conf = el('div', { class: 'merge-conflicts' });
    conf.appendChild(el('h4', { text: `冲突（${data.conflicts.length} 项）` }));
    const ul = el('ul');
    for (const c of data.conflicts) {
      ul.appendChild(el('li', { text: c.message }));
    }
    conf.appendChild(ul);
    box.appendChild(conf);
  }

  // 合并后的关系
  const edgeBox = el('div');
  edgeBox.appendChild(el('h4', {
    text: `合并后的关系（${data.edges.length} 条；去重移除 ${data.removedDuplicateCount} 条）`,
  }));
  if (data.edges.length === 0) {
    edgeBox.appendChild(el('p', { class: 'empty-hint', text: '合并后没有任何父母→子女关系。' }));
  } else {
    const list = el('ul', { class: 'edge-list merge-edge-list' });
    for (const e of data.edges) {
      const li = el('li');
      li.appendChild(el('span', { class: 'edge-text' }, [
        el('span', { class: 'p-name', text: e.parentName }),
        document.createTextNode(' → '),
        el('span', { class: 'c-name', text: e.childName }),
      ]));
      if (e.replaced) {
        li.appendChild(el('span', { class: 'merge-tag', text: 'ID 已替换' }));
      }
      list.appendChild(li);
    }
    edgeBox.appendChild(list);
  }
  box.appendChild(edgeBox);
}

/* ---------------- 共同祖先查询结果渲染 ---------------- */

function renderPathLine(path) {
  // path: [{id,name}, ...] 从查询人向上到祖先
  const gen = path.length - 1;
  const frag = document.createDocumentFragment();
  path.forEach((node, idx) => {
    if (idx > 0) frag.appendChild(el('span', { class: 'path-arrow', text: '↑' }));
    frag.appendChild(document.createTextNode(node.name));
  });
  return el('div', { class: 'path-line' }, [
    el('span', { class: 'gen-tag', text: `${gen} 代` }),
    frag,
  ]);
}

function renderAncestorBlock(ancestor, labelA, labelB) {
  const block = el('div', { class: 'ancestor-block' });
  block.appendChild(el('h3', { text: `共同祖先：${ancestor.name}` }));
  block.appendChild(el('p', { class: 'ancestor-meta' }, [
    document.createTextNode(
      `${labelA}到该祖先 ${ancestor.genA} 代，${labelB}到该祖先 ${ancestor.genB} 代，`
    ),
    el('strong', { text: `合计 ${ancestor.totalGen} 代` }),
    document.createTextNode(
      `；${labelA}侧最短路径 ${ancestor.pathsA.length} 条，${labelB}侧 ${ancestor.pathsB.length} 条（同代数不同路径均保留）。`
    ),
  ]));

  const paths = el('div', { class: 'paths' });

  const colA = el('div', { class: 'path-col' }, [
    el('h4', { text: `${labelA} 向上到「${ancestor.name}」` }),
  ]);
  ancestor.pathsA.forEach((p) => colA.appendChild(renderPathLine(p)));

  const colB = el('div', { class: 'path-col' }, [
    el('h4', { text: `${labelB} 向上到「${ancestor.name}」` }),
  ]);
  ancestor.pathsB.forEach((p) => colB.appendChild(renderPathLine(p)));

  paths.append(colA, colB);
  block.appendChild(paths);
  return block;
}

function renderQueryResult(data, nameA, nameB) {
  const box = $('query-result');
  box.replaceChildren();
  box.dataset.hasResult = '1';

  if (data.samePerson) {
    const a = data.ancestors[0];
    box.appendChild(el('div', { class: 'summary' }, [
      el('div', {}, [el('strong', { text: `两位成员是同一人：「${a.name}」` })]),
      el('div', { text: '其本人即为最近共同祖先，沿父母链向上的总代数为 0 代。' }),
    ]));
    box.appendChild(renderAncestorBlock(a, nameA, nameB));
    return;
  }

  if (data.ancestors.length === 0) {
    box.appendChild(el('div', { class: 'summary no-match' }, [
      el('strong', { text: `「${nameA}」与「${nameB}」没有共同祖先。` }),
      el('div', {
        text: '沿双方父母链向上均找不到同一位成员。若确有亲缘关系，请检查是否漏录了中间世代的父母→子女关系。',
      }),
    ]));
    return;
  }

  box.appendChild(el('div', { class: 'summary' }, [
    el('div', {}, [
      document.createTextNode('「'),
      el('strong', { text: nameA }),
      document.createTextNode('」与「'),
      el('strong', { text: nameB }),
      document.createTextNode('」的 '),
      el('strong', { text: `最少总代数为 ${data.minTotalGen} 代` }),
      document.createTextNode('。'),
    ]),
    el('div', {
      text: `达到该最小值的最近共同祖先共 ${data.ancestors.length} 位（全部列出），双方到各祖先的全部最短亲缘路径如下：`,
    }),
  ]));

  for (const ancestor of data.ancestors) {
    box.appendChild(renderAncestorBlock(ancestor, `「${nameA}」`, `「${nameB}」`));
  }
}

$('query-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  syncSelectionFromForm();
  const personA = $('query-a').value;
  const personB = $('query-b').value;
  if (!personA || !personB) { toast('请选择两位成员', true); return; }

  const nameA = nameOf(personA);
  const nameB = nameOf(personB);

  try {
    const params = new URLSearchParams({ personA, personB });
    const data = await api(`/api/common-ancestors?${params.toString()}`);
    queryStale = false;
    renderQueryResult(data, nameA, nameB);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- 辈分矛盾核查结果渲染 ---------------- */

/** 渲染一条 祖先 → 子女 → … → 后代 的完整成员链（方向自上而下） */
function renderGenChainLine(path, genTag) {
  const frag = document.createDocumentFragment();
  path.forEach((node, idx) => {
    if (idx > 0) frag.appendChild(el('span', { class: 'path-arrow', text: '↓' }));
    frag.appendChild(document.createTextNode(node.name));
  });
  return el('div', { class: 'path-line' }, [
    el('span', { class: 'gen-tag', text: genTag }),
    frag,
  ]);
}

function renderConflictBlock(c) {
  const block = el('div', { class: 'conflict-block ancestor-block' });
  block.appendChild(el('h3', {}, [
    document.createTextNode('「'),
    el('strong', { text: c.ancestorName }),
    document.createTextNode('」 → … → 「'),
    el('strong', { text: c.descendantName }),
    document.createTextNode('」'),
  ]));
  block.appendChild(el('p', { class: 'ancestor-meta' }, [
    document.createTextNode('最短路径 '),
    el('strong', { text: `${c.minGen} 代` }),
    document.createTextNode('，最长路径 '),
    el('strong', { text: `${c.maxGen} 代` }),
    document.createTextNode('，'),
    el('strong', { class: 'conflict-diff', text: `代数差 ${c.diff} 代` }),
    document.createTextNode('：同一对祖先与后代沿不同关系路径的辈分隔辈数不一致。'),
  ]));

  const paths = el('div', { class: 'paths' });
  const colShort = el('div', { class: 'path-col' }, [
    el('h4', { text: `最短成员链（${c.minGen} 代）` }),
    renderGenChainLine(c.shortestPath, `${c.shortestPath.length - 1} 代`),
  ]);
  const colLong = el('div', { class: 'path-col' }, [
    el('h4', { text: `最长成员链（${c.maxGen} 代）` }),
    renderGenChainLine(c.longestPath, `${c.longestPath.length - 1} 代`),
  ]);
  paths.append(colShort, colLong);
  block.appendChild(paths);
  return block;
}

function renderGenResult(data) {
  const box = $('gen-result');
  box.replaceChildren();
  box.dataset.hasResult = '1';

  if (data.conflicts.length === 0) {
    const summary = el('div', { class: 'summary no-match' });
    if (data.filtered) {
      summary.appendChild(el('strong', { text: '当前筛选的成员没有参与任何辈分矛盾。' }));
      summary.appendChild(el('div', {
        text: `全家家谱共核查出 ${data.total} 对辈分矛盾（清空成员筛选后可查看全部）；同代不同路径不会报警。`,
      }));
    } else if (data.total === 0) {
      summary.appendChild(el('strong', { text: '未发现辈分矛盾。' }));
      summary.appendChild(el('div', {
        text: '全部存在祖先关系的成员对，沿不同父母→子女路径得到的代数都一致；同代不同路径（如经父系与母系同代到达同一祖先）不属于矛盾。',
      }));
    } else {
      summary.appendChild(el('strong', { text: '当前筛选条件下没有矛盾。' }));
    }
    box.appendChild(summary);
    return;
  }

  const summary = el('div', { class: 'summary' });
  if (data.filtered) {
    summary.appendChild(el('div', {}, [
      document.createTextNode('全家家谱共 '),
      el('strong', { text: `${data.total} 对` }),
      document.createTextNode(' 辈分矛盾，其中与所选成员相关的 '),
      el('strong', { text: `${data.count} 对` }),
      document.createTextNode(' 如下（按代数差从大到小排列）：'),
    ]));
  } else {
    summary.appendChild(el('div', {}, [
      document.createTextNode('共核查出 '),
      el('strong', { text: `${data.total} 对` }),
      document.createTextNode(' 辈分矛盾（同一对祖先与后代的最少、最多代数不一致），按代数差从大到小排列：'),
    ]));
  }
  summary.appendChild(el('div', {
    class: 'empty-hint',
    text: '每条给出两端成员、代数差以及最短、最长各一条完整成员链（祖先 → 子女 → … → 后代）。',
  }));
  box.appendChild(summary);

  for (const c of data.conflicts) box.appendChild(renderConflictBlock(c));
}

$('gen-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  syncSelectionFromForm();
  const memberId = selection.genFilter;
  const params = new URLSearchParams();
  if (memberId) params.set('member', memberId);
  try {
    const url = '/api/generation-conflicts' + (params.toString() ? `?${params.toString()}` : '');
    const data = await api(url);
    genStale = false;
    renderGenResult(data);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- 变更影响预览 ---------------- */

function invalidateImpactPreview(reason) {
  impactStale = true;
  impactStaleReason = reason;
  renderStaleBanner();
}

// 预览条件（变更类型 / 父母 / 子女）一旦改变，旧结果立即标记过期
$('impact-action').addEventListener('change', () => {
  invalidateImpactPreview('预览条件已修改，以下结果与当前选择不符，请重新预览。');
});
$('impact-parent').addEventListener('change', () => {
  syncSelectionFromForm();
  invalidateImpactPreview('预览条件已修改，以下结果与当前选择不符，请重新预览。');
});
$('impact-child').addEventListener('change', () => {
  syncSelectionFromForm();
  invalidateImpactPreview('预览条件已修改，以下结果与当前选择不符，请重新预览。');
});

/** 预览影响：在不落盘的假设图上试算新增/移除一条关系，对比前后辈分矛盾 */
$('impact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  syncSelectionFromForm();
  const action = $('impact-action').value;
  const parentId = selection.impactParent;
  const childId = selection.impactChild;
  if (!parentId || !childId) { toast('请选择父母与子女', true); return; }
  if (action === 'add' && parentId === childId) {
    toast('拒绝自指关系：不能成为自己的父母', true);
    return;
  }
  try {
    const data = await api('/api/edges/impact/preview', {
      method: 'POST',
      body: JSON.stringify({ action, parentId, childId }),
    });
    // 请求往返期间选择可能已被改动：结果只对当时的条件快照有效
    if (
      action !== $('impact-action').value ||
      parentId !== selection.impactParent ||
      childId !== selection.impactChild
    ) {
      invalidateImpactPreview('预览条件在预览期间已变化，请重新预览。');
      return;
    }
    impactPreview = data;
    impactStale = false;
    impactStaleReason = '';
    renderImpactResult(data);
  } catch (err) {
    // 新增关系校验失败（成员不存在/重复/父母上限/祖先环路）或移除的目标不存在：展示原因
    toast(err.message, true);
  }
});

/** 渲染一侧（变更前 / 变更后）的代际档案：辈分一致、矛盾双链或无祖先关系 */
function renderImpactProfile(label, profile) {
  const col = el('div', { class: 'path-col' });
  if (!profile) {
    col.appendChild(el('h4', { text: label }));
    col.appendChild(el('p', { class: 'empty-hint', text: '两人不存在祖先关系。' }));
    return col;
  }
  if (profile.minGen === profile.maxGen) {
    // 辈分一致：所有路径同代，展示一条成员链即可
    col.appendChild(el('h4', { text: `${label}（辈分一致，${profile.minGen} 代）` }));
    col.appendChild(renderGenChainLine(profile.shortestPath, `${profile.minGen} 代`));
    return col;
  }
  col.appendChild(el('h4', { text: `${label}（矛盾：最短 ${profile.minGen} 代 · 最长 ${profile.maxGen} 代）` }));
  col.appendChild(renderGenChainLine(profile.shortestPath, `最短 ${profile.minGen} 代`));
  col.appendChild(renderGenChainLine(profile.longestPath, `最长 ${profile.maxGen} 代`));
  return col;
}

function renderImpactItem(item) {
  const block = el('div', { class: 'conflict-block ancestor-block' });
  block.appendChild(el('h3', {}, [
    document.createTextNode('「'),
    el('strong', { text: item.ancestorName }),
    document.createTextNode('」 → … → 「'),
    el('strong', { text: item.descendantName }),
    document.createTextNode('」'),
  ]));
  const paths = el('div', { class: 'paths' });
  paths.appendChild(renderImpactProfile('变更前', item.before));
  paths.appendChild(renderImpactProfile('变更后', item.after));
  block.appendChild(paths);
  return block;
}

function renderImpactGroup(title, items) {
  const group = el('div', { class: 'impact-group' });
  group.appendChild(el('h3', { class: 'list-title', text: `${title}（${items.length} 对）` }));
  for (const item of items) group.appendChild(renderImpactItem(item));
  return group;
}

function renderImpactResult(data) {
  const box = $('impact-result');
  box.replaceChildren();
  box.dataset.hasResult = '1';

  const actionLabel = data.action === 'add' ? '新增' : '移除';
  const hasDetails = data.added.length > 0 || data.removed.length > 0 || data.changed.length > 0;
  const summary = el('div', { class: 'summary' });
  summary.appendChild(el('div', {}, [
    document.createTextNode(`假设${actionLabel}关系「`),
    el('strong', { text: data.parentName }),
    document.createTextNode(' → '),
    el('strong', { text: data.childName }),
    document.createTextNode(`」：基于家谱版本 ${data.version} 的假设图试算，未写入家谱。`),
  ]));
  summary.appendChild(el('div', {}, [
    document.createTextNode('辈分矛盾 '),
    el('strong', { text: `${data.beforeTotal} 对` }),
    document.createTextNode(' → '),
    el('strong', { text: `${data.afterTotal} 对` }),
    document.createTextNode(
      `（新增 ${data.added.length} · 消失 ${data.removed.length} · ` +
      `代数范围变化 ${data.changed.length} · 范围不变 ${data.unchangedCount}）` +
      (hasDetails ? '，逐对明细如下。' : '。'),
    ),
  ]));
  box.appendChild(summary);

  if (!hasDetails) {
    box.appendChild(el('p', {
      class: 'empty-hint',
      text: '该变更不影响任何祖先—后代对的辈分矛盾：逐对对比无新增、消失或代数范围变化。',
    }));
    return;
  }

  if (data.added.length > 0) box.appendChild(renderImpactGroup('新增的矛盾', data.added));
  if (data.removed.length > 0) box.appendChild(renderImpactGroup('消失的矛盾', data.removed));
  if (data.changed.length > 0) box.appendChild(renderImpactGroup('代数范围变化的矛盾', data.changed));
}

/* ---------------- 删除成员影响预览 ---------------- */

function invalidateMemberImpactPreview(reason) {
  memberImpactStale = true;
  memberImpactStaleReason = reason;
  renderStaleBanner();
}

function renderMemberImpactPlaceholder() {
  const box = $('member-impact-result');
  box.replaceChildren();
  delete box.dataset.hasResult;
  box.appendChild(el('p', {
    class: 'placeholder',
    text: '在「① 成员」中点击某位成员的「删除影响」查看预览。',
  }));
}

/** 删除影响预览：在不落盘的只读假设图上移除该成员及其亲子关系，逐对对比最短可达性 */
async function previewMemberDeletionImpact(member) {
  try {
    const data = await api('/api/members/delete-impact/preview', {
      method: 'POST',
      body: JSON.stringify({ memberId: member.id }),
    });
    // 请求往返期间该成员可能已被其他操作删除
    if (!state.members.some((m) => m.id === member.id)) {
      renderMemberImpactPlaceholder();
      toast('该成员已不在当前家谱中', true);
      return;
    }
    memberImpactPreview = data;
    memberImpactStale = false;
    memberImpactStaleReason = '';
    renderMemberImpactResult(data);
    $('member-impact-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(err.message, true);
  }
}

/** 渲染删除前后各一侧的最短成员链（after 为 null 时为空，即不可达） */
function renderDeletionSide(label, profile) {
  const col = el('div', { class: 'path-col' });
  col.appendChild(el('h4', { text: label }));
  if (!profile) {
    col.appendChild(el('p', { class: 'empty-hint', text: '不可达（无成员链）。' }));
    return col;
  }
  col.appendChild(renderGenChainLine(profile.shortestPath, `${profile.minGen} 代`));
  return col;
}

function renderDeletionItem(item, kind) {
  const block = el('div', { class: 'conflict-block ancestor-block' });
  block.appendChild(el('h3', {}, [
    document.createTextNode('「'),
    el('strong', { text: item.ancestorName }),
    document.createTextNode('」 → … → 「'),
    el('strong', { text: item.descendantName }),
    document.createTextNode('」'),
  ]));
  if (kind === 'lengthened') {
    block.appendChild(el('p', { class: 'ancestor-meta' }, [
      document.createTextNode('删除后仍可达，但最短代数 '),
      el('strong', { text: `${item.before.minGen} 代 → ${item.after.minGen} 代` }),
      document.createTextNode('（'),
      el('strong', { class: 'conflict-diff', text: `增加 ${item.genIncrease} 代` }),
      document.createTextNode('）：最短链必须绕开被删成员改走替代路径。'),
    ]));
  } else {
    block.appendChild(el('p', { class: 'ancestor-meta' }, [
      document.createTextNode('删除前最短 '),
      el('strong', { text: `${item.before.minGen} 代` }),
      document.createTextNode(' 可达；删除后'),
      el('strong', { class: 'conflict-diff', text: '不再可达' }),
      document.createTextNode('——两人间的全部通路都经过被删成员。'),
    ]));
  }
  const paths = el('div', { class: 'paths' });
  paths.appendChild(renderDeletionSide('删除前（当前家谱）最短成员链', item.before));
  paths.appendChild(renderDeletionSide('删除后（假设图）最短成员链', item.after));
  block.appendChild(paths);
  return block;
}

function renderDeletionGroup(title, items, kind) {
  const group = el('div', { class: 'impact-group' });
  group.appendChild(el('h3', { class: 'list-title', text: `${title}（${items.length} 对）` }));
  for (const item of items) group.appendChild(renderDeletionItem(item, kind));
  return group;
}

function renderMemberImpactResult(data) {
  const box = $('member-impact-result');
  box.replaceChildren();
  box.dataset.hasResult = '1';

  const affected = data.disconnectedCount + data.lengthenedCount;
  const summary = el('div', { class: 'summary' });
  summary.appendChild(el('div', {}, [
    document.createTextNode('假设删除成员「'),
    el('strong', { text: data.memberName }),
    document.createTextNode(
      `」：将一并移除 ${data.removedEdgeCount} 条相连亲子关系，删除后家谱剩 ` +
      `${data.remainingMemberCount} 名成员。基于家谱版本 ${data.version} 的只读假设图试算，未写入家谱。`,
    ),
  ]));
  summary.appendChild(el('div', {}, [
    document.createTextNode('共比较删除前原本可达、删除后两端仍在谱的有序祖先→后代成员对 '),
    el('strong', { text: `${data.comparedCount} 对` }),
    document.createTextNode('：'),
    el('strong', { class: 'conflict-diff', text: `删除后不可达 ${data.disconnectedCount} 对` }),
    document.createTextNode('，'),
    el('strong', { text: `最短代数增加 ${data.lengthenedCount} 对` }),
    document.createTextNode(`，不受影响 ${data.unaffectedCount} 对。`),
  ]));
  box.appendChild(summary);

  if (affected === 0) {
    box.appendChild(el('p', {
      class: 'empty-hint',
      text:
        '删除该成员不会使任何仍在谱的祖先→后代成员对断联或绕远：' +
        '仍可达的成员对都保留同代通路（多路径情形不会误报为断联）。',
    }));
    return;
  }

  if (data.disconnected.length > 0) {
    box.appendChild(renderDeletionGroup('删除后不可达的成员对（断联）', data.disconnected, 'disconnected'));
  }
  if (data.lengthened.length > 0) {
    box.appendChild(renderDeletionGroup('仍可达但最短代数增加的成员对（绕远）', data.lengthened, 'lengthened'));
  }
}

/* ---------------- 后代支系视图 ---------------- */

function invalidateBranchResult(reason) {
  branchStale = true;
  branchStaleReason = reason;
  renderStaleBanner();
}

// 查询条件（始祖 / 代数上限）一旦改变，旧结果立即标记过期
$('branch-root').addEventListener('change', () => {
  syncSelectionFromForm();
  invalidateBranchResult('查询条件已修改，以下结果与当前选择不符，请重新生成');
});
$('branch-max-gen').addEventListener('change', () => {
  invalidateBranchResult('查询条件已修改，以下结果与当前选择不符，请重新生成');
});

/** 生成支系视图：只读查询，服务端按当前最新家谱状态计算 */
$('branch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  syncSelectionFromForm();
  const rootId = selection.branchRoot;
  const maxGen = $('branch-max-gen').value;
  if (!rootId) { toast('请选择始祖成员', true); return; }
  try {
    const params = new URLSearchParams({ root: rootId, maxGen });
    const data = await api(`/api/descendant-branches?${params.toString()}`);
    // 请求往返期间查询条件可能已被改动：结果只对当时的条件快照有效
    if (rootId !== selection.branchRoot || maxGen !== $('branch-max-gen').value) {
      invalidateBranchResult('查询条件在生成期间已变化，请重新生成');
      return;
    }
    branchResult = data;
    branchStale = false;
    branchStaleReason = '';
    renderBranchResult(data);
    renderStaleBanner();
  } catch (err) {
    toast(err.message, true);
  }
});

/** 下载当前结果：局部导出（成员 ID、姓名、代数、分支及支系内关系），注明非整谱备份 */
$('branch-export').addEventListener('click', () => {
  if (!branchResult || branchStale) { toast('请先生成最新的支系视图', true); return; }
  const d = branchResult;
  const doc = {
    note:
      `局部导出：仅含以「${d.rootName}」为始祖、${d.maxGen} 代以内的后代支系视图` +
      '（成员 ID、姓名、代数、所属分支与支系内亲子关系），不是整谱备份；' +
      '整谱备份请使用「⑥ 备份与恢复」下载。',
    exportedAt: new Date().toISOString(),
    familyVersion: d.version,
    root: { id: d.rootId, name: d.rootName },
    maxGen: d.maxGen,
    memberCount: d.memberCount,
    edgeCount: d.edgeCount,
    branches: d.branches,
    members: d.members,
    edges: d.edges,
  };
  const blob = new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const a = el('a', {
    href: url,
    download: `family-branch-${d.rootName}-${d.maxGen}代-${date}.json`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`已下载支系视图 JSON（${d.memberCount} 名成员、${d.edgeCount} 条关系；局部导出，非整谱备份）`);
});

function renderBranchResult(data) {
  const box = $('branch-result');
  box.replaceChildren();
  box.dataset.hasResult = '1';

  const summary = el('div', { class: 'summary' });
  summary.appendChild(el('div', {}, [
    document.createTextNode('始祖 '),
    el('strong', { text: `「${data.rootName}」` }),
    document.createTextNode(`，${data.maxGen} 代以内共 `),
    el('strong', { text: `${data.memberCount} 名成员` }),
    document.createTextNode('（含始祖）、'),
    el('strong', { text: `${data.edgeCount} 条` }),
    document.createTextNode(`支系内亲子关系（基于家谱版本 ${data.version}）。`),
  ]));
  summary.appendChild(el('div', {
    class: 'empty-hint',
    text: data.branches.length > 0
      ? `共 ${data.branches.length} 个始祖直系子女分支：${data.branches.map((b) => `「${b.name}」${b.memberCount} 人`).join('、')}。`
      : '该成员在所选代数上限内没有后代。',
  }));
  box.appendChild(summary);

  // 按距始祖的最短代数分组展示
  const byGen = new Map();
  for (const m of data.members) {
    if (!byGen.has(m.gen)) byGen.set(m.gen, []);
    byGen.get(m.gen).push(m);
  }
  const groups = el('div', { class: 'branch-gens' });
  for (const [gen, members] of [...byGen.entries()].sort((a, b) => a[0] - b[0])) {
    const group = el('div', { class: 'branch-gen-group' });
    group.appendChild(el('h3', {
      class: 'list-title',
      text: gen === 0 ? '第 0 代（始祖）' : `第 ${gen} 代（${members.length} 人）`,
    }));
    const chips = el('div', { class: 'branch-members' });
    for (const m of members) {
      const chip = el('span', { class: 'branch-member' });
      chip.appendChild(el('span', { class: 'name', text: m.name }));
      for (const b of m.branches) {
        chip.appendChild(el('span', { class: 'branch-tag', text: `${b.name}系` }));
      }
      chips.appendChild(chip);
    }
    group.appendChild(chips);
    groups.appendChild(group);
  }
  box.appendChild(groups);

  // 支系内亲子关系（仅两端都在支系中的关系）
  const edgeBox = el('div', { class: 'branch-edges' });
  edgeBox.appendChild(el('h3', { class: 'list-title', text: `支系内亲子关系（${data.edgeCount} 条）` }));
  if (data.edges.length === 0) {
    edgeBox.appendChild(el('p', {
      class: 'empty-hint',
      text: '支系内没有父母→子女关系（仅展示父母与子女都在支系中的关系）。',
    }));
  } else {
    const list = el('ul', { class: 'edge-list' });
    for (const e of data.edges) {
      const li = el('li');
      li.appendChild(el('span', { class: 'edge-text' }, [
        el('span', { class: 'p-name', text: e.parentName }),
        document.createTextNode(' → '),
        el('span', { class: 'c-name', text: e.childName }),
      ]));
      list.appendChild(li);
    }
    edgeBox.appendChild(list);
  }
  box.appendChild(edgeBox);
}

/* ---------------- 整谱关系图 ---------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const CHART_ZOOM_MIN = 0.15;
const CHART_ZOOM_MAX = 5;

let chartSvgSeq = 0; // 箭头标记 id 序号，避免多份 SVG 之间 id 冲突
let chartSvgEl = null; // 当前展示的 SVG 元素
let chartViewportEl = null; // 当前展示 SVG 的视口分组（缩放/平移变换挂载点）
const chartView = { scale: 1, tx: 0, ty: 0 }; // 当前视图的缩放与平移

function invalidateChartResult(reason) {
  chartStale = true;
  chartStaleReason = reason;
  renderStaleBanner();
}

/** 安全创建 SVG 元素（命名空间），避免 innerHTML 注入 */
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * 由服务端布局结果构建 SVG。interactive 为 true 时按容器展示（宽高由 CSS 控制）；
 * 为 false 时生成自包含的静态 SVG（显式宽高、无视图变换、白底），供下载。
 * 图上标注生成时的家谱版本（caption 由服务端随布局给出）。
 */
function buildChartSvg(data, interactive) {
  const markerId = `chart-arrow-${++chartSvgSeq}`;
  const attrs = {
    xmlns: SVG_NS,
    'font-family': CHART_FONT,
    role: 'img',
    'aria-label': `整谱关系图（家谱版本 ${data.version}）`,
  };
  if (interactive) {
    attrs.class = 'chart-svg';
  } else {
    attrs.width = data.width;
    attrs.height = data.height;
  }
  const svg = svgEl('svg', attrs);

  // 箭头标记：父母 → 子女方向（指向下方的子女节点）
  const defs = svgEl('defs');
  const marker = svgEl('marker', {
    id: markerId,
    viewBox: '0 0 10 10',
    refX: '9',
    refY: '5',
    markerWidth: '7',
    markerHeight: '7',
    orient: 'auto',
  });
  marker.appendChild(svgEl('path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: '#94a3b8' }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  const viewport = svgEl('g');
  // 画布背景（下载的 SVG 自带白底）
  viewport.appendChild(svgEl('rect', { x: 0, y: 0, width: data.width, height: data.height, fill: '#ffffff' }));

  // 连通分量背景带：多于一个分量时标出分组与分量之间的留白
  if (data.componentCount > 1) {
    for (const comp of data.components) {
      viewport.appendChild(svgEl('rect', {
        x: comp.x,
        y: comp.y,
        width: comp.width,
        height: comp.height,
        rx: 10,
        fill: '#f8fafc',
        stroke: '#e2e8f0',
      }));
    }
  }

  // 关系连线：父母节点底边中点 → 子女节点顶边中点（三次贝塞尔，箭头指向子女）；
  // 多位父母指向同一子女时各条连线全部保留
  const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
  for (const e of data.edges) {
    const p = nodeById.get(e.parentId);
    const c = nodeById.get(e.childId);
    if (!p || !c) continue;
    const x1 = p.x;
    const y1 = p.y + p.h / 2;
    const x2 = c.x;
    const y2 = c.y - c.h / 2;
    const midY = (y1 + y2) / 2;
    viewport.appendChild(svgEl('path', {
      d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
      fill: 'none',
      stroke: '#94a3b8',
      'stroke-width': '1.5',
      'marker-end': `url(#${markerId})`,
    }));
  }

  // 成员节点：同一成员只绘一个节点，姓名居中
  for (const n of data.nodes) {
    const g = svgEl('g');
    g.appendChild(svgEl('rect', {
      x: n.x - n.w / 2,
      y: n.y - n.h / 2,
      width: n.w,
      height: n.h,
      rx: 8,
      fill: '#ffffff',
      stroke: '#2563eb',
      'stroke-width': '1.5',
    }));
    g.appendChild(svgEl('text', {
      x: n.x,
      y: n.y,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': '13',
      fill: '#1f2933',
    }, n.name));
    g.appendChild(svgEl('title', {}, `${n.name}（第 ${n.layer} 层 · 分量 ${n.component + 1}）`));
    viewport.appendChild(g);
  }

  // 图上标注：生成时的家谱版本（文本由服务端给出，下载的 SVG 同样携带）
  viewport.appendChild(svgEl('text', {
    x: data.caption.x,
    y: data.caption.y,
    'font-size': '13',
    fill: '#6b7280',
  }, data.caption.text));

  svg.appendChild(viewport);
  return { svg, viewport };
}

function applyChartView() {
  if (chartViewportEl) {
    chartViewportEl.setAttribute(
      'transform',
      `translate(${chartView.tx} ${chartView.ty}) scale(${chartView.scale})`,
    );
  }
}

/** 重置视图：整张图适应容器（放大不超过 100%），水平垂直居中 */
function resetChartView() {
  if (!chartSvgEl || !chartResult || chartResult.empty) return;
  const boxW = chartSvgEl.clientWidth || 800;
  const boxH = chartSvgEl.clientHeight || 520;
  const fit = Math.min(boxW / chartResult.width, boxH / chartResult.height, 1);
  chartView.scale = fit * 0.98;
  chartView.tx = (boxW - chartResult.width * chartView.scale) / 2;
  chartView.ty = (boxH - chartResult.height * chartView.scale) / 2;
  applyChartView();
}

/** 以容器内某点为锚点缩放（锚点处的图内容保持不动）；无锚点时以中心缩放 */
function zoomChart(factor, clientX, clientY) {
  if (!chartSvgEl || !chartResult || chartResult.empty) return;
  const rect = chartSvgEl.getBoundingClientRect();
  const mx = clientX === undefined ? rect.width / 2 : clientX - rect.left;
  const my = clientY === undefined ? rect.height / 2 : clientY - rect.top;
  const next = Math.min(CHART_ZOOM_MAX, Math.max(CHART_ZOOM_MIN, chartView.scale * factor));
  const k = next / chartView.scale;
  chartView.tx = mx - (mx - chartView.tx) * k;
  chartView.ty = my - (my - chartView.ty) * k;
  chartView.scale = next;
  applyChartView();
}

/** 为展示用 SVG 挂上交互：滚轮缩放（以光标为锚点）、拖动平移 */
function attachChartInteractions(svg) {
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomChart(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY);
  }, { passive: false });

  let pan = null;
  svg.addEventListener('pointerdown', (e) => {
    pan = { x: e.clientX, y: e.clientY, tx: chartView.tx, ty: chartView.ty };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pan) return;
    chartView.tx = pan.tx + (e.clientX - pan.x);
    chartView.ty = pan.ty + (e.clientY - pan.y);
    applyChartView();
  });
  const endPan = () => {
    pan = null;
    svg.classList.remove('panning');
  };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);
}

/** 生成整谱关系图：只读查询，服务端按当前最新家谱状态计算布局 */
$('chart-generate').addEventListener('click', async () => {
  try {
    const data = await api('/api/family-chart');
    chartResult = data;
    chartStale = false;
    chartStaleReason = '';
    renderChartResult(data);
    renderStaleBanner();
  } catch (err) {
    toast(err.message, true);
  }
});

/** 下载当前图：重新构建一份自包含 SVG（显式宽高、无视图变换），带版本标注 */
$('chart-download').addEventListener('click', () => {
  if (!chartResult || chartStale || chartResult.empty) {
    toast('请先生成最新的整谱关系图', true);
    return;
  }
  const { svg } = buildChartSvg(chartResult, false);
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}\n`;
  const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const a = el('a', {
    href: url,
    download: `family-chart-v${chartResult.version}-${date}.svg`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`已下载整谱关系图 SVG（家谱版本 ${chartResult.version}）`);
});

$('chart-zoom-in').addEventListener('click', () => zoomChart(1.25));
$('chart-zoom-out').addEventListener('click', () => zoomChart(1 / 1.25));
$('chart-zoom-reset').addEventListener('click', resetChartView);

function renderChartResult(data) {
  const box = $('chart-result');
  box.replaceChildren();
  box.dataset.hasResult = '1';
  chartSvgEl = null;
  chartViewportEl = null;

  // 空谱：展示空状态，不绘图
  if (data.empty) {
    box.appendChild(el('div', { class: 'summary no-match' }, [
      el('strong', { text: '空谱：当前家谱没有任何成员，无法绘制关系图。' }),
      el('div', {
        text: '请先在「① 成员」中录入成员（可在「② 父母 → 子女关系」中建立关系），再重新生成整谱关系图。',
      }),
    ]));
    return;
  }

  const summary = el('div', { class: 'summary' });
  summary.appendChild(el('div', {}, [
    document.createTextNode('整谱关系图（只读）：共 '),
    el('strong', { text: `${data.memberCount} 名成员` }),
    document.createTextNode('、'),
    el('strong', { text: `${data.edgeCount} 条关系` }),
    document.createTextNode('，按忽略方向划分为 '),
    el('strong', { text: `${data.componentCount} 个连通分量` }),
    document.createTextNode(`；图上标注生成时的家谱版本 ${data.version}。`),
  ]));
  summary.appendChild(el('div', {
    class: 'empty-hint',
    text: '拖动平移、滚轮或按钮缩放；「下载当前图（SVG）」导出带版本标注的矢量图。家谱写入后此处会提示重新生成。',
  }));
  box.appendChild(summary);

  const { svg, viewport } = buildChartSvg(data, true);
  attachChartInteractions(svg);
  box.appendChild(svg);
  chartSvgEl = svg;
  chartViewportEl = viewport;
  resetChartView();
}

/* ---------------- 关键连接 ---------------- */

function invalidateCriticalResult(reason) {
  criticalStale = true;
  criticalStaleReason = reason;
  renderStaleBanner();
}

/** 查找关键连接：只读查询，服务端按当前最新家谱状态计算 */
$('critical-generate').addEventListener('click', async () => {
  try {
    const data = await api('/api/critical-links');
    criticalResult = data;
    criticalStale = false;
    criticalStaleReason = '';
    renderCriticalResult(data);
    renderStaleBanner();
  } catch (err) {
    toast(err.message, true);
  }
});

/** 渲染断开后一侧的成员名单（姓名芯片） */
function renderCriticalSide(label, side) {
  const col = el('div', { class: 'path-col' });
  col.appendChild(el('h4', { text: `${label}（${side.count} 人）` }));
  const chips = el('div', { class: 'member-chips' });
  for (const m of side.members) {
    chips.appendChild(el('span', { class: 'member-chip', text: m.name }));
  }
  col.appendChild(chips);
  return col;
}

function renderCriticalBlock(b, index) {
  const block = el('div', { class: 'critical-block ancestor-block' });
  block.appendChild(el('h3', {}, [
    document.createTextNode(`关键连接 ${index + 1}：「`),
    el('strong', { text: b.parentName }),
    document.createTextNode(' → '),
    el('strong', { text: b.childName }),
    document.createTextNode(`」（第 ${b.componentIndex + 1} 个家族）`),
  ]));
  block.appendChild(el('p', { class: 'ancestor-meta' }, [
    document.createTextNode('这条关系是两侧成员之间'),
    el('strong', { class: 'conflict-diff', text: '唯一的连接' }),
    document.createTextNode(
      `：断开后原家族（${b.componentMemberCount} 人）将拆分为 ` +
      `${b.parentSide.count} 人与 ${b.childSide.count} 人两部分。`,
    ),
  ]));
  const paths = el('div', { class: 'paths' });
  paths.appendChild(renderCriticalSide(`父母「${b.parentName}」一侧`, b.parentSide));
  paths.appendChild(renderCriticalSide(`子女「${b.childName}」一侧`, b.childSide));
  block.appendChild(paths);
  return block;
}

function renderCriticalResult(data) {
  const box = $('critical-result');
  box.replaceChildren();
  box.dataset.hasResult = '1';

  // 空谱：明确提示，不做分析
  if (data.empty) {
    box.appendChild(el('div', { class: 'summary no-match' }, [
      el('strong', { text: '空谱：当前家谱没有任何成员，无法分析关键连接。' }),
      el('div', {
        text: '请先在「① 成员」中录入成员，并在「② 父母 → 子女关系」中建立关系，再重新查找关键连接。',
      }),
    ]));
    return;
  }

  const summary = el('div', { class: 'summary' });
  summary.appendChild(el('div', {}, [
    document.createTextNode('关键连接分析（只读）：共 '),
    el('strong', { text: `${data.memberCount} 名成员` }),
    document.createTextNode('、'),
    el('strong', { text: `${data.edgeCount} 条关系` }),
    document.createTextNode('，按忽略方向划分为 '),
    el('strong', { text: `${data.componentCount} 个家族` }),
    document.createTextNode(`（基于家谱版本 ${data.version}）。`),
  ]));
  // 原本互不连通的家族分别计算：多于一个家族时给出各家族明细
  if (data.componentCount > 1) {
    summary.appendChild(el('div', {
      class: 'empty-hint',
      text:
        `各家族分别计算：${data.components
          .map((c) => `第 ${c.index + 1} 个家族 ${c.memberCount} 人（关键连接 ${c.bridgeCount} 条）`)
          .join('；')}。`,
    }));
  }
  box.appendChild(summary);

  // 无桥梁：明确提示
  if (data.bridgeCount === 0) {
    summary.appendChild(el('div', {}, [
      el('strong', { text: '未发现关键连接' }),
      document.createTextNode('：没有任何一条关系被移除后会拆开其所在家族。'),
    ]));
    summary.appendChild(el('div', {
      class: 'empty-hint',
      text: data.edgeCount === 0
        ? '当前家谱还没有任何父母→子女关系；建立关系后可重新查找。'
        : '每条关系的两端之间都另有连接路径（或其所在家族只有一名成员），移除单条关系不会使家族断开。',
    }));
    return;
  }

  summary.appendChild(el('div', {}, [
    document.createTextNode('共发现 '),
    el('strong', { class: 'conflict-diff', text: `${data.bridgeCount} 条关键连接` }),
    document.createTextNode('：移除其中任意一条，其所在家族都会断开为两部分；逐条明细如下。'),
  ]));
  data.bridges.forEach((b, i) => box.appendChild(renderCriticalBlock(b, i)));
}

/* ---------------- 备份与恢复 ---------------- */

function invalidateRestorePreview(reason) {
  restorePreview = null;
  restoreStale = true;
  restoreStaleReason = reason;
  renderRestore();
}

/** 下载备份：仅含成员 ID、姓名与父母→子女关系的 JSON 文件 */
$('backup-download').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/backup');
    if (!res.ok) throw new Error(`下载失败（${res.status}）`);
    const blob = await res.blob();
    const dispo = res.headers.get('Content-Disposition') || '';
    const match = /filename="?([^";]+)"?/.exec(dispo);
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: match ? match[1] : 'family-backup.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`已下载备份（${state.members.length} 名成员、${state.edges.length} 条关系）`);
  } catch (err) {
    toast(err.message, true);
  }
});

// 重新选择文件后旧预览立即失效
$('restore-file').addEventListener('change', () => {
  invalidateRestorePreview('已重新选择文件，请重新预览恢复');
});

/** 预览恢复：服务端整份校验备份文件并逐项报错；预览不修改家谱 */
async function previewRestoreBackup() {
  const input = $('restore-file');
  const file = input.files && input.files[0];
  if (!file) { toast('请先选择备份 JSON 文件', true); return; }
  let content;
  try {
    content = await file.text();
  } catch (_) {
    toast('无法读取所选文件', true);
    return;
  }
  const status = $('restore-status');
  status.hidden = false;
  status.className = 'batch-status info';
  status.textContent = '校验预览中…（不会修改家谱）';
  try {
    const data = await api('/api/backup/restore/preview', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    // 请求往返期间文件选择可能已变化：结果只对当时的文件快照有效
    if (!input.files || input.files[0] !== file) {
      invalidateRestorePreview('文件选择在预览期间已变化，请重新预览');
      return;
    }
    restorePreview = { ...data, content };
    restoreStale = false;
    restoreStaleReason = '';
    renderRestore();
  } catch (err) {
    toast(err.message, true);
    renderRestore();
  }
}

/** 确认恢复：携带预览的内容指纹与家谱版本；文件被调换或版本过期都会被服务端拒绝 */
async function submitRestore() {
  if (!restorePreview || restoreStale || !restorePreview.valid) {
    toast('请先预览且备份校验通过后再恢复', true);
    return;
  }
  const msg =
    '确定用备份整体替换当前家谱？\n\n' +
    `备份内容：${restorePreview.memberCount} 名成员、${restorePreview.edgeCount} 条关系\n` +
    `当前家谱：${state.members.length} 名成员、${state.edges.length} 条关系（将被整体替换）\n\n` +
    '恢复成功后可通过「最近操作」撤销一次。';
  if (!confirm(msg)) return;
  const btn = $('restore-submit');
  btn.disabled = true;
  try {
    const data = await api('/api/backup/restore', {
      method: 'POST',
      body: JSON.stringify({
        version: restorePreview.version,
        fingerprint: restorePreview.fingerprint,
        content: restorePreview.content,
      }),
    });
    restorePreview = null;
    restoreStale = false;
    restoreStaleReason = '';
    $('restore-file').value = '';
    publishState(data);
    markStale();
    toast('备份已恢复：家谱已整体替换，如需回退可在「最近操作」中撤销');
  } catch (err) {
    if (err.status === 409) {
      // 版本过期或内容指纹不符（文件被调换）：拉取最新状态并要求重新预览
      invalidateRestorePreview(err.message);
      refresh().catch(() => {});
    } else if (err.body && Array.isArray(err.body.errors)) {
      // 服务端重验未通过：逐项展示错误并禁止恢复
      restorePreview = {
        valid: false,
        errors: err.body.errors,
        error: err.body.error,
        content: restorePreview.content,
      };
      restoreStale = false;
      renderRestore();
    }
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

$('restore-preview').addEventListener('click', previewRestoreBackup);
$('restore-submit').addEventListener('click', submitRestore);

function renderRestore() {
  const status = $('restore-status');
  const result = $('restore-result');
  const previewBtn = $('restore-preview');
  const submitBtn = $('restore-submit');
  const hasFile = !!($('restore-file').files && $('restore-file').files.length);

  previewBtn.disabled = !hasFile;
  const live = restorePreview && !restoreStale;

  if (!live) {
    result.hidden = true;
    submitBtn.disabled = true;
    if (!hasFile) {
      status.hidden = true;
      return;
    }
    status.hidden = false;
    status.className = 'batch-status warn';
    status.textContent =
      restoreStaleReason || '已选择文件但尚未预览：请点击「预览恢复」（预览不会修改家谱）。';
    return;
  }

  status.hidden = false;
  result.hidden = false;
  renderRestoreResult(result, restorePreview);

  if (restorePreview.valid) {
    status.className = 'batch-status ok';
    status.textContent =
      `预览通过：备份含 ${restorePreview.memberCount} 名成员、${restorePreview.edgeCount} 条关系，` +
      `确认后将整体替换当前家谱（当前 ${state.members.length} 名成员、${state.edges.length} 条关系）。` +
      `基于家谱版本 ${restorePreview.version}，确认后版本 +1 并可经「最近操作」撤销；预览未修改任何数据。`;
    submitBtn.disabled = false;
  } else {
    status.className = 'batch-status error';
    status.textContent =
      `备份文件未通过校验：共 ${restorePreview.errors.length} 项问题（见下），已禁止恢复；` +
      '请修正文件后重新选择并预览。';
    submitBtn.disabled = true;
  }
}

function renderRestoreResult(box, data) {
  box.replaceChildren();

  if (!data.valid) {
    const errBox = el('div', { class: 'merge-conflicts' });
    errBox.appendChild(el('h4', { text: `校验未通过（${data.errors.length} 项问题）` }));
    const ul = el('ul', { class: 'restore-errors' });
    const whereLabel = { file: '文件', member: '成员', edge: '关系' };
    for (const item of data.errors) {
      ul.appendChild(el('li', {}, [
        el('span', { class: 'restore-where', text: `【${whereLabel[item.where] || '文件'}】` }),
        document.createTextNode(item.message),
      ]));
    }
    errBox.appendChild(ul);
    box.appendChild(errBox);
    return;
  }

  const okBox = el('div');
  okBox.appendChild(el('h4', {
    text: `备份内容（${data.memberCount} 名成员、${data.edgeCount} 条关系）`,
  }));
  if (data.memberCount === 0) {
    okBox.appendChild(el('p', {
      class: 'empty-hint',
      text: '备份为空家谱：确认后当前成员与关系将被全部清空（可撤销）。',
    }));
  } else {
    const chips = el('div', { class: 'restore-members' });
    for (const name of data.memberNames || []) {
      chips.appendChild(el('span', { class: 'member-chip', text: name }));
    }
    okBox.appendChild(chips);
  }
  box.appendChild(okBox);
}

/* ---------------- 成员纪念日 ---------------- */

function fmtMonthDay(md) {
  return md ? `${md.month}月${md.day}日` : '未登记';
}

/** 浏览器本地今天 → YYYY-MM-DD（服务端据此生成含当天的 30 天清单） */
function localToday() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/**
 * 拉取未来 30 天纪念日清单（只读；任何纪念日/成员变更后随状态发布重新拉取）。
 * 同样按请求顺序单调发布：慢网络下先发出的旧请求最后返回时不能覆盖新一轮清单。
 */
let upcomingSeq = 0;
async function loadUpcoming() {
  const seq = ++upcomingSeq;
  try {
    const data = await api(`/api/anniversaries/upcoming?from=${localToday()}`);
    if (seq !== upcomingSeq) return;
    upcoming = data;
    renderUpcoming();
  } catch (err) {
    if (seq !== upcomingSeq) return;
    toast(`纪念日清单加载失败：${err.message}`, true);
  }
}

const WEEKDAYS = '日一二三四五六';

function renderUpcoming() {
  const list = $('upcoming-list');
  const count = $('upcoming-count');
  list.replaceChildren();
  if (!upcoming) {
    count.textContent = '0';
    list.appendChild(el('li', { class: 'empty-hint', text: '清单加载中…' }));
    return;
  }
  count.textContent = String(upcoming.items.length);
  if (upcoming.items.length === 0) {
    list.appendChild(el('li', {
      class: 'empty-hint',
      text: `自 ${upcoming.from} 起 30 天内没有已登记的纪念日。`,
    }));
    return;
  }
  for (const item of upcoming.items) {
    const [y, mo, d] = item.date.split('-').map(Number);
    const weekday = WEEKDAYS[new Date(y, mo - 1, d).getDay()];
    const li = el('li', { class: 'upcoming-item' });
    li.appendChild(el('span', { class: 'upcoming-date', text: `${item.date} 周${weekday}` }));
    li.appendChild(el('span', { class: `anniv-tag ${item.type}`, text: item.typeLabel }));
    li.appendChild(el('span', { class: 'name', text: item.memberName }));
    // 平年 2 月 29 日落到 2 月 28 日时，标注实际登记日
    const adjusted = item.month === 2 && item.day === 29 && item.date.slice(5) !== '02-29';
    li.appendChild(el('span', {
      class: 'sub',
      text: adjusted ? '登记 2月29日（平年按 2月28日）' : `${item.month}月${item.day}日`,
    }));
    li.appendChild(el('span', {
      class: 'days-until',
      text: item.daysUntil === 0
        ? '今天'
        : item.daysUntil === 1
          ? '明天'
          : item.daysUntil === 2
            ? '后天'
            : `${item.daysUntil} 天后`,
    }));
    list.appendChild(li);
  }
}

function renderAnniversaries() {
  const list = $('anniv-list');
  const empty = $('anniv-empty');
  list.replaceChildren();
  if (state.members.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const m of state.members) {
    const li = el('li');
    li.appendChild(el('span', { class: 'name', text: m.name }));
    li.appendChild(el('span', {
      class: 'sub',
      text: `生日 ${fmtMonthDay(m.birthday)} · 忌日 ${fmtMonthDay(m.deathday)}`,
    }));
    li.appendChild(el('button', {
      class: 'danger-link',
      text: (m.birthday || m.deathday) ? '修改' : '登记',
      onClick: () => startAnnivEdit(li, m),
    }));
    if (m.birthday || m.deathday) {
      li.appendChild(el('button', {
        class: 'danger-link',
        text: '清除',
        onClick: () => clearAnniversaries(m),
      }));
    }
    list.appendChild(li);
  }
}

/** 纪念日行内编辑：生日、忌日各一组「月 + 日」，月选「不登记」即清除该项 */
function startAnnivEdit(li, member) {
  li.classList.add('anniv-editing');
  li.replaceChildren();

  const makeRow = (label, current) => {
    const monthSel = el('select');
    monthSel.appendChild(el('option', { value: '', text: '不登记' }));
    for (let mo = 1; mo <= 12; mo++) {
      monthSel.appendChild(el('option', { value: String(mo), text: `${mo} 月` }));
    }
    if (current) monthSel.value = String(current.month);
    const dayInput = el('input', {
      type: 'number',
      min: '1',
      max: '31',
      placeholder: '日',
      value: current ? String(current.day) : '',
    });
    const row = el('label', { class: 'anniv-field' }, [
      el('span', { class: 'anniv-field-label', text: label }),
      monthSel,
      dayInput,
    ]);
    return { row, monthSel, dayInput };
  };

  const birthday = makeRow('生日', member.birthday);
  const deathday = makeRow('忌日', member.deathday);
  const saveBtn = el('button', { type: 'button', text: '保存' });
  const cancelBtn = el('button', { type: 'button', text: '取消', class: 'danger-link' });

  const readValue = ({ monthSel, dayInput }, label) => {
    if (!monthSel.value) return { value: null };
    const month = Number(monthSel.value);
    const day = Number(dayInput.value);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return { error: `请填写${label}的日期（1–31 的整数）` };
    }
    return { value: { month, day } };
  };

  const doSave = async () => {
    const b = readValue(birthday, '生日');
    if (b.error) { toast(b.error, true); return; }
    const d = readValue(deathday, '忌日');
    if (d.error) { toast(d.error, true); return; }
    saveBtn.disabled = true;
    try {
      const data = await api(`/api/members/${encodeURIComponent(member.id)}/anniversaries`, {
        method: 'PUT',
        body: JSON.stringify({ birthday: b.value, deathday: d.value }),
      });
      publishState(data);
      toast('纪念日已保存');
    } catch (err) {
      // 非法日期被服务端拒绝：数据不变，保持编辑状态便于修正
      toast(err.message, true);
      saveBtn.disabled = false;
    }
  };

  saveBtn.addEventListener('click', doSave);
  cancelBtn.addEventListener('click', () => renderAnniversaries());
  li.append(
    el('span', { class: 'name', text: member.name }),
    birthday.row,
    deathday.row,
    saveBtn,
    cancelBtn,
  );
}

/** 清除成员全部纪念日（生日与忌日同时置空） */
async function clearAnniversaries(member) {
  if (!confirm(`确定清除「${member.name}」的生日与忌日登记？`)) return;
  try {
    const data = await api(`/api/members/${encodeURIComponent(member.id)}/anniversaries`, {
      method: 'PUT',
      body: JSON.stringify({ birthday: null, deathday: null }),
    });
    publishState(data);
    toast('纪念日已清除');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 启动 ---------------- */

// 代数上限选项（1～10 代，默认 3 代）
const branchMaxGenSelect = $('branch-max-gen');
for (let g = 1; g <= 10; g += 1) {
  branchMaxGenSelect.appendChild(el('option', { value: String(g), text: `${g} 代` }));
}
branchMaxGenSelect.value = '3';

refresh().catch((err) => toast(`初始化失败：${err.message}`, true));
