'use strict';

/**
 * 家谱图核心逻辑（纯函数，不依赖 Node API，便于测试）。
 *
 * 关系模型：每条边 parent -> child（父母 → 子女）。
 * parentsOf[child] = [parentA, parentB]，每名子女至多两位父母。
 * 每个连通结构必须是有向无环图（DAG），即沿父母链向上永远不会回到自身。
 */

const MAX_PARENTS_PER_CHILD = 2;
const MAX_MEMBERS = 30;
const MAX_BATCH_EDGES = 100;
const MAX_BACKUP_NAME_LENGTH = 50;
const MAX_DESCENDANT_GENERATIONS = 10;

const { ANNIVERSARY_TYPES, TYPE_LABEL, validateMonthDay } = require('./anniversaries');

/** 创建一个空的家谱状态对象 */
function createState(maxMembers = MAX_MEMBERS) {
  return {
    maxMembers,
    members: [], // [{ id, name, birthday, deathday }]（纪念日为 { month, day } 或 null）
    parentsOf: {}, // memberId -> [parentId, ...]
  };
}

function getMember(state, id) {
  return state.members.find((m) => m.id === id) || null;
}

function hasMember(state, id) {
  return state.members.some((m) => m.id === id);
}

/**
 * 成员对的规范化键：按有序端点 (firstId, secondId) 编码，两端顺序不同则键不同。
 *
 * 成员 ID 允许含 "|"、空格等任意字符，因此不能用分隔符拼接当键——拼接会让
 * 不同成员对碰撞：例如 "b|c"→"a" 与 "c"→"a|b" 都拼出 "a|b|c"，
 * "b c"→"a" 与 "c"→"a b" 都拼出 "a b c"，导致不同关系被误判为重复、
 * 批量提交静默丢边。JSON 数组编码与有序端点一一对应，任意 ID 都不碰撞。
 * 所有需要「按成员对识别」的位置（批内重复、合并去重、备份校验、
 * 变更影响比较、桥梁分析、批量提交去重）统一使用本函数。
 */
function pairKeyOf(firstId, secondId) {
  return JSON.stringify([firstId, secondId]);
}

/**
 * 判断从 from 出发沿“父母链”向上是否能到达 to（含 from === to）。
 * parentsOf 是一个 DAG（外部保证），此处用栈式 DFS。
 */
function isReachableUp(state, from, to) {
  if (from === to) return true;
  const stack = [...(state.parentsOf[from] || [])];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of state.parentsOf[cur] || []) stack.push(p);
  }
  return false;
}

/**
 * 校验并尝试添加一条 parent -> child 边。
 * 返回 { error: string } 或 { error: null }。
 * 不修改 state（由调用方在校验通过后写入）。
 */
function validateEdge(state, parentId, childId) {
  if (!hasMember(state, parentId)) return { error: '父母成员不存在' };
  if (!hasMember(state, childId)) return { error: '子女成员不存在' };

  if (parentId === childId) {
    return { error: '拒绝自指关系：不能成为自己的父母' };
  }

  const parents = state.parentsOf[childId] || [];
  if (parents.includes(parentId)) {
    return { error: '拒绝重复边：该父母→子女关系已存在' };
  }
  if (parents.length >= MAX_PARENTS_PER_CHILD) {
    return {
      error: `每名子女至多 ${MAX_PARENTS_PER_CHILD} 位父母，该成员已有 ${parents.length} 位父母`,
    };
  }

  // 祖先环路检测：若 parent 沿父母链向上能到达 child，
  // 再加 child 成为 parent 的祖先，则 child 会成为自己的祖先。
  if (isReachableUp(state, parentId, childId)) {
    return { error: '拒绝祖先环路：该父母已是此子女的后代，添加后将形成循环祖先关系' };
  }

  return { error: null };
}

/**
 * 批量校验待添加的父母→子女草稿（纯函数，不修改 state）。
 *
 * 校验基准是「当前已有关系 + 整批草稿」合并后的完整结果，而不是逐条顺序处理：
 * 因此先入草稿在判定中不会“生效”，草稿顺序如何排列都不影响任何一条的结论。
 *
 * 每条草稿可能同时命中多个错误，errors 为全部命中项：
 *   - 父母/子女成员不存在（或格式非法）
 *   - 自指
 *   - 批内重复（同一对父母→子女在草稿中出现多次）
 *   - 与已有关系重复
 *   - 合并后该子女父母超过两位（计数只含已有关系 + 批内去重后的边）
 *   - 祖先环路（在合并后的图上检测，任一条边使合并图成环都会被标记）
 *
 * 返回 { valid, error: string|null, items: [{ index, parentId, childId, errors }] }。
 * valid 仅在非空且每条草稿都无错误时为 true；任何一条无效，整批都不可提交。
 */
function validateEdgeBatch(state, rawEdges) {
  if (!Array.isArray(rawEdges)) {
    return { valid: false, error: '草稿必须是数组', items: [] };
  }
  if (rawEdges.length === 0) {
    return { valid: false, error: '草稿为空：请至少添加一条父母→子女关系', items: [] };
  }
  if (rawEdges.length > MAX_BATCH_EDGES) {
    return {
      valid: false,
      error: `单批最多 ${MAX_BATCH_EDGES} 条草稿，当前 ${rawEdges.length} 条`,
      items: [],
    };
  }

  // 第一阶段：结构校验（成员存在、自指），同时按「有序端点对 父母→子女」找批内重复。
  // 结构不合法的条目不参与后续计数与环路检测。
  const items = rawEdges.map((raw, index) => {
    const parentId =
      raw && typeof raw.parentId === 'string' ? raw.parentId.trim() : '';
    const childId =
      raw && typeof raw.childId === 'string' ? raw.childId.trim() : '';
    const errors = [];
    let structurallyValid = true;

    if (!parentId || !hasMember(state, parentId)) {
      errors.push('父母成员不存在');
      structurallyValid = false;
    }
    if (!childId || !hasMember(state, childId)) {
      errors.push('子女成员不存在');
      structurallyValid = false;
    }
    if (parentId && childId && parentId === childId) {
      errors.push('拒绝自指关系：不能成为自己的父母');
      structurallyValid = false;
    }

    return { index, parentId: parentId || null, childId: childId || null, errors, structurallyValid };
  });

  // 批内重复：同一条父母→子女在草稿中出现多次（所有副本一起标记）。
  // 键按有序端点编码（pairKeyOf）：成员 ID 含 "|"、空格等字符也不会碰撞。
  const keyOf = (parentId, childId) => pairKeyOf(parentId, childId);
  const groups = new Map();
  for (const item of items) {
    if (!item.structurallyValid) continue;
    const key = keyOf(item.parentId, item.childId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    if (group.length > 1) {
      for (const item of group) item.errors.push('批内重复：该父母→子女关系在草稿中出现多次');
    }
  }

  // 第二阶段：合并结果上的去重边集（已有关系 + 批内去重后的结构合法边）。
  // 与已有重复、超父母上限的边同样纳入合并图做环路检测：
  // 环路是整批合并结果的性质，与“哪些边最终能写入”无关，且判定不依赖顺序。
  const existingByChild = new Map();
  for (const e of edgesFromState(state)) {
    if (!existingByChild.has(e.childId)) existingByChild.set(e.childId, new Set());
    existingByChild.get(e.childId).add(e.parentId);
  }

  const merged = new Map(); // childId -> Set<parentId>（已有关系为底）
  for (const [childId, parents] of existingByChild) {
    merged.set(childId, new Set(parents));
  }

  const duplicateFreeCandidates = new Map(); // childId -> Set<parentId>，仅批内去重后
  const newCandidates = new Map(); // childId -> Set<parentId>，批内去重且不与已有重复
  for (const item of items) {
    if (!item.structurallyValid) continue;
    if (groups.get(keyOf(item.parentId, item.childId)).length > 1) continue;
    if (!duplicateFreeCandidates.has(item.childId)) duplicateFreeCandidates.set(item.childId, new Set());
    duplicateFreeCandidates.get(item.childId).add(item.parentId);
    const isExistingDup = !!(existingByChild.get(item.childId) && existingByChild.get(item.childId).has(item.parentId));
    if (!isExistingDup) {
      if (!newCandidates.has(item.childId)) newCandidates.set(item.childId, new Set());
      newCandidates.get(item.childId).add(item.parentId);
    }
    if (!merged.has(item.childId)) merged.set(item.childId, new Set());
    merged.get(item.childId).add(item.parentId);
  }

  for (const item of items) {
    if (!item.structurallyValid) continue;
    if (groups.get(keyOf(item.parentId, item.childId)).length > 1) continue;
    const existing = existingByChild.get(item.childId);
    if (existing && existing.has(item.parentId)) {
      item.errors.push('拒绝重复边：该父母→子女关系已存在');
    }
  }

  // 每名子女至多两位父母：合并后总父母数 = 现有父母 + 草稿中新引入的父母（去重）。
  // 与已有重复的边不会引入新父母，因此不参与计数；超限则该子女下全部新边都标记。
  for (const [childId, incoming] of newCandidates) {
    const existingCount = existingByChild.has(childId) ? existingByChild.get(childId).size : 0;
    const total = existingCount + incoming.size;
    if (total > MAX_PARENTS_PER_CHILD) {
      for (const parentId of incoming) {
        for (const item of items) {
          if (
            item.childId === childId &&
            item.parentId === parentId &&
            item.structurallyValid &&
            groups.get(keyOf(parentId, childId)).length === 1
          ) {
            item.errors.push(
              `每名子女至多 ${MAX_PARENTS_PER_CHILD} 位父母：合并草稿后该子女将有 ${total} 位父母（现有 ${existingCount} 位）`,
            );
          }
        }
      }
    }
  }

  // 祖先环路：在合并后的图上，对每条候选边检查 parent 是否沿父母链向上可达 child。
  // 可达性基于最终合并图（而非逐条累加），故结论与草稿顺序无关。
  const mergedState = {
    ...state,
    parentsOf: Object.fromEntries(
      [...merged.entries()].map(([childId, parents]) => [childId, [...parents]]),
    ),
  };
  for (const item of items) {
    if (!item.structurallyValid) continue;
    if (groups.get(keyOf(item.parentId, item.childId)).length > 1) continue;
    if (isReachableUp(mergedState, item.parentId, item.childId)) {
      item.errors.push('拒绝祖先环路：合并该批草稿后将形成循环祖先关系');
    }
  }

  const valid = items.every((item) => item.errors.length === 0);
  return {
    valid,
    error: valid
      ? null
      : `草稿中有 ${items.filter((i) => i.errors.length > 0).length} 条关系不合法，整批不可提交`,
    items: items.map(({ index, parentId, childId, errors }) => ({ index, parentId, childId, errors })),
  };
}

/**
 * 合并重复成员预检（纯函数，不修改 state）。
 *
 * 把被合并成员 mergeId 在「全部父母 → 子女关系」中的 ID 替换为保留成员 keepId，
 * 替换后完全相同的关系去重，再在合并结果上统一检查三类冲突：
 *   - 自指：替换后某条关系的父母与子女变成同一人
 *     （例如已有 A→B，把 B 并入 A 后会得到 A→A）；
 *   - 超过两位父母：去重后任一子女仍有超过 MAX_PARENTS_PER_CHILD 位父母；
 *   - 祖先环路：合并图中某条边的父母沿父母链向上可以到达其子女。
 * 冲突可同时命中多项，全部列入 conflicts；只要存在冲突 valid 即为 false。
 *
 * 返回：
 *   结构非法（成员不存在 / 两人相同）：{ error: string }
 *   正常：{
 *     valid, error, keepId, mergeId,
 *     originalEdgeCount,      // 合并前关系总数
 *     affectedEdgeCount,      // 其中端点涉及被合并成员的关系数
 *     removedDuplicateCount,  // ID 替换后去重掉的重复关系数
 *     edges: [{ parentId, childId, replaced }],  // 合并去重后的关系；
 *                                                // replaced 表示是否源自涉及被合并成员的关系
 *     conflicts: [{ type, ... }],
 *   }
 */
function previewMergeMembers(state, keepId, mergeId) {
  if (!hasMember(state, keepId)) return { error: '保留成员不存在' };
  if (!hasMember(state, mergeId)) return { error: '被合并成员不存在' };
  if (keepId === mergeId) return { error: '保留成员与被合并成员不能是同一人' };

  const original = edgesFromState(state);
  const substitute = (id) => (id === mergeId ? keepId : id);

  const conflicts = [];
  // 自指关系不参与去重与后续图校验，单独作为冲突报告
  const mergedByKey = new Map(); // 有序端点键（pairKeyOf）-> { parentId, childId, replaced }
  let affectedEdgeCount = 0;
  let removedDuplicateCount = 0;

  for (const e of original) {
    const touched = e.parentId === mergeId || e.childId === mergeId;
    if (touched) affectedEdgeCount += 1;
    const nextParent = substitute(e.parentId);
    const nextChild = substitute(e.childId);

    if (nextParent === nextChild) {
      conflicts.push({
        type: 'self',
        parentId: nextParent,
        childId: nextChild,
        originParentId: e.parentId,
        originChildId: e.childId,
      });
      continue;
    }

    const key = pairKeyOf(nextParent, nextChild);
    const existing = mergedByKey.get(key);
    if (existing) {
      removedDuplicateCount += 1;
      if (touched) existing.replaced = true;
    } else {
      mergedByKey.set(key, { parentId: nextParent, childId: nextChild, replaced: touched });
    }
  }

  const edges = [...mergedByKey.values()].sort((a, b) => {
    if (a.childId !== b.childId) return a.childId.localeCompare(b.childId);
    return a.parentId.localeCompare(b.parentId);
  });

  // 合并后的父母邻接表
  const parentsByChild = new Map();
  for (const e of edges) {
    if (!parentsByChild.has(e.childId)) parentsByChild.set(e.childId, []);
    parentsByChild.get(e.childId).push(e.parentId);
  }

  // 冲突一：子女超过两位父母
  for (const childId of [...parentsByChild.keys()].sort()) {
    const parentIds = parentsByChild.get(childId);
    if (parentIds.length > MAX_PARENTS_PER_CHILD) {
      conflicts.push({
        type: 'too-many-parents',
        childId,
        parentIds: [...parentIds],
        count: parentIds.length,
      });
    }
  }

  // 冲突二：祖先环路（自指边已剔除，from===to 的平凡情况不会出现）
  const mergedState = {
    ...state,
    parentsOf: Object.fromEntries(
      [...parentsByChild.entries()].map(([childId, parentIds]) => [childId, [...parentIds]]),
    ),
  };
  for (const e of edges) {
    if (isReachableUp(mergedState, e.parentId, e.childId)) {
      conflicts.push({ type: 'cycle', parentId: e.parentId, childId: e.childId });
    }
  }

  const valid = conflicts.length === 0;
  return {
    valid,
    error: valid
      ? null
      : `合并预览存在 ${conflicts.length} 项冲突，已禁止提交`,
    keepId,
    mergeId,
    originalEdgeCount: original.length,
    affectedEdgeCount,
    removedDuplicateCount,
    edges,
    conflicts,
  };
}

/** 从状态导出边表（与 store 内的 edgesList 保持一致的最小实现） */
function edgesFromState(state) {
  const edges = [];
  for (const [childId, parents] of Object.entries(state.parentsOf || {})) {
    for (const parentId of parents) edges.push({ parentId, childId });
  }
  return edges;
}

/**
 * BFS 沿父母链向上，返回从 start 到其全部祖先（含自身）的“全部最短路径”。
 *
 * 返回 Map: ancestorId -> {
 *   gen: number,                 // 最短代数（向上步数）：自身 0、父母 1、祖父母 2……
 *   paths: Array<Array<id>>,     // 所有长度等于 gen 的路径，方向 start → ... → ancestor
 * }
 *
 * 同代数的不同路径全部保留（例如同时通过父系与母系到达同一祖父母）。
 */
function allShortestPathsUp(state, start) {
  const result = new Map();
  result.set(start, { gen: 0, paths: [[start]] });
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const curInfo = result.get(cur);
    for (const p of state.parentsOf[cur] || []) {
      const nextGen = curInfo.gen + 1;
      if (!result.has(p)) {
        // 首次以 BFS 到达 p，nextGen 即最短代数
        result.set(p, {
          gen: nextGen,
          paths: curInfo.paths.map((path) => [...path, p]),
        });
        queue.push(p);
      } else if (result.get(p).gen === nextGen) {
        // 同一最短代数经另一条路径再次到达 → 保留该路径
        const info = result.get(p);
        for (const path of curInfo.paths) info.paths.push([...path, p]);
      }
      // result.get(p).gen < nextGen：更长路径，丢弃
    }
  }
  return result;
}

/**
 * 查询两人的共同祖先。
 * 返回 {
 *   samePerson: boolean,
 *   minTotalGen: number,
 *   ancestors: [{ id, genA, genB, pathsA: [[id]], pathsB: [[id]] }]
 * }
 * minTotalGen 为所有共同祖先中 genA + genB 的最小值；
 * 只返回达到该最小值的全部共同祖先；没有共同祖先时 ancestors 为空。
 */
function findCommonAncestors(state, idA, idB) {
  if (!hasMember(state, idA) || !hasMember(state, idB)) {
    return { error: '成员不存在' };
  }

  if (idA === idB) {
    const self = allShortestPathsUp(state, idA).get(idA);
    return {
      samePerson: true,
      minTotalGen: 0,
      ancestors: [
        {
          id: idA,
          genA: 0,
          genB: 0,
          totalGen: 0,
          pathsA: self.paths,
          pathsB: self.paths,
        },
      ],
    };
  }

  const upA = allShortestPathsUp(state, idA);
  const upB = allShortestPathsUp(state, idB);

  const common = [];
  let minTotalGen = Infinity;
  for (const [ancestorId, infoA] of upA) {
    const infoB = upB.get(ancestorId);
    if (!infoB) continue;
    const totalGen = infoA.gen + infoB.gen;
    if (totalGen < minTotalGen) minTotalGen = totalGen;
    common.push({
      id: ancestorId,
      genA: infoA.gen,
      genB: infoB.gen,
      totalGen,
      pathsA: infoA.paths,
      pathsB: infoB.paths,
    });
  }

  const nearest = common
    .filter((c) => c.totalGen === minTotalGen)
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    samePerson: false,
    minTotalGen: minTotalGen === Infinity ? null : minTotalGen,
    ancestors: nearest,
  };
}

/**
 * 后代支系视图（纯函数，不修改 state、不写入任何数据）。
 *
 * 以 rootId 为「始祖」、maxGen 为代数上限（1～MAX_DESCENDANT_GENERATIONS 的整数），
 * 沿「父母 → 子女」关系向下提取后代支系：
 *   - 同一后代经多条路径到达时只出现一次，gen 取距始祖的**最短代数**（BFS 首达步数）；
 *   - 每个成员标记其所属的**全部始祖直系子女分支**：分支以始祖的每位直系子女
 *     （第 1 代成员）为起点，只要在提取出的支系子图中该起点沿父母→子女关系
 *     向下可到达此成员（不限于最短路径），此成员即属于该分支；
 *   - 仅保留**两端都在支系内**的亲子关系：父母或子女任一不在提取结果中的边
 *     （如支系外成员的亲子关系、超出代数上限的边）一律不带入。
 *
 * 返回 { error } 或 {
 *   rootId, maxGen,
 *   branchRoots: [id],                       // 始祖的直系子女（各分支起点），按 id 排序
 *   members: [{ id, gen, branches: [id] }],  // 按 (gen, id) 排序；始祖 gen 0、branches 为空
 *   edges: [{ parentId, childId }],          // 支系内关系，按 (childId, parentId) 排序
 * }
 */
function descendantBranches(state, rootId, maxGen) {
  if (!hasMember(state, rootId)) return { error: '成员不存在' };
  if (!Number.isInteger(maxGen) || maxGen < 1 || maxGen > MAX_DESCENDANT_GENERATIONS) {
    return { error: `代数上限必须是 1～${MAX_DESCENDANT_GENERATIONS} 的整数` };
  }

  // 子女邻接表：childrenOf[parent] = [child, ...]（沿父母→子女向下）
  const childrenOf = {};
  for (const [childId, parents] of Object.entries(state.parentsOf || {})) {
    for (const parentId of parents) (childrenOf[parentId] ||= []).push(childId);
  }

  // BFS 向下：gen 为距始祖的最短代数，最多向下 maxGen 层
  const genOf = new Map([[rootId, 0]]);
  const queue = [rootId];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const gen = genOf.get(cur);
    if (gen >= maxGen) continue;
    for (const childId of childrenOf[cur] || []) {
      if (!genOf.has(childId)) {
        genOf.set(childId, gen + 1);
        queue.push(childId);
      }
    }
  }
  const included = new Set(genOf.keys());

  // 支系内关系：仅保留父母与子女都在提取结果中的边
  const edges = [];
  for (const childId of included) {
    for (const parentId of state.parentsOf[childId] || []) {
      if (included.has(parentId)) edges.push({ parentId, childId });
    }
  }
  edges.sort((a, b) =>
    a.childId === b.childId
      ? a.parentId.localeCompare(b.parentId)
      : a.childId.localeCompare(b.childId),
  );

  // 分支起点：距始祖 1 代的成员即始祖的直系子女
  const branchRoots = [...included].filter((id) => genOf.get(id) === 1);
  branchRoots.sort((a, b) => a.localeCompare(b));

  // 分支归属：从每个分支起点沿支系内边向下可达（含起点自身）的成员都属于该分支。
  // 按分支起点顺序逐个 DFS，每个成员的分支列表自然按起点顺序排列。
  const branchesOf = new Map([...included].map((id) => [id, []]));
  for (const branchRoot of branchRoots) {
    const stack = [branchRoot];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      branchesOf.get(cur).push(branchRoot);
      for (const childId of childrenOf[cur] || []) {
        if (included.has(childId)) stack.push(childId);
      }
    }
  }

  const members = [...included]
    .sort((a, b) => genOf.get(a) - genOf.get(b) || a.localeCompare(b))
    .map((id) => ({ id, gen: genOf.get(id), branches: branchesOf.get(id) }));

  return { error: null, rootId, maxGen, branchRoots, members, edges };
}

/**
 * 计算某位后代全部祖先的「代际档案」（纯函数，不修改 state）。
 *
 * 以 descendantId 为起点沿父母链向上：
 *   - 最少代数 minGen：BFS 首达步数，以及其中一条完整最短成员链；
 *   - 最多代数 maxGen：DAG 上的最长路（记忆化 DFS），以及一条完整最长成员链。
 *
 * 返回 Map: ancestorId -> {
 *   minGen, maxGen,
 *   shortestPath: [ancestorId, ..., descendantId],  // 祖先→子女→…→后代
 *   longestPath:  [ancestorId, ..., descendantId],
 * }
 * 后代本人不在结果中；没有任何祖先时返回空 Map。
 * minGen === maxGen 表示两人辈分一致（所有路径同代，例如经父系、母系同代到达）。
 */
function ancestorProfiles(state, descendantId) {
  const start = descendantId;
  const profiles = new Map();

  // BFS 向上：最少代数；shortestPrev 记录首达前驱（其子女），便于重建一条最短链
  const minGenOf = new Map([[start, 0]]);
  const shortestPrev = new Map([[start, null]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const p of state.parentsOf[cur] || []) {
      if (!minGenOf.has(p)) {
        minGenOf.set(p, minGenOf.get(cur) + 1);
        shortestPrev.set(p, cur);
        queue.push(p);
      }
    }
  }
  if (minGenOf.size <= 1) return profiles; // 该成员没有任何祖先

  // 子女邻接表：childrenOf[parent] = [child, ...]（沿父母→子女向下）
  const childrenOf = {};
  for (const childId of Object.keys(state.parentsOf || {})) {
    for (const parentId of state.parentsOf[childId] || []) {
      (childrenOf[parentId] ||= []).push(childId);
    }
  }

  // 最多代数：在「start 经父母链可达」的祖先子图（DAG）上做记忆化 DFS。
  // 向上走的图中边为 子女 → 父母，因此到达祖先 v 的最后一步来自 v 的某个
  // 同样可达的子女 c：longest(v) = max(longest(c) + 1)，base 为 start = 0。
  // parentsOf 保证整图为 DAG，递归必然收敛；不可达的子女不参与取 max。
  const memo = new Map([[start, 0]]);
  const longestPrev = new Map([[start, null]]);
  const longest = (v) => {
    if (memo.has(v)) return memo.get(v);
    let best = -Infinity;
    let bestChild = null;
    for (const c of childrenOf[v] || []) {
      if (!minGenOf.has(c)) continue; // 不在 start 可达祖先子图内
      const candidate = longest(c) + 1;
      if (candidate > best) {
        best = candidate;
        bestChild = c;
      }
    }
    memo.set(v, best);
    longestPrev.set(v, bestChild);
    return best;
  };

  // 沿前驱表重建 祖先 → 子女 → … → 后代 的完整成员链
  const rebuildPath = (prev, ancestorId) => {
    const path = [ancestorId];
    let cur = ancestorId;
    while (cur !== start) {
      cur = prev.get(cur);
      path.push(cur);
    }
    return path;
  };

  for (const ancestorId of minGenOf.keys()) {
    if (ancestorId === start) continue;
    profiles.set(ancestorId, {
      minGen: minGenOf.get(ancestorId),
      maxGen: longest(ancestorId),
      shortestPath: rebuildPath(shortestPrev, ancestorId),
      longestPath: rebuildPath(longestPrev, ancestorId),
    });
  }
  return profiles;
}

/**
 * 辈分矛盾核查（纯函数，不修改 state、不写入任何数据）。
 *
 * 对每一对存在祖先关系的成员（祖先 ancestor、后代 descendant，两人不同），
 * 沿「父母 → 子女」关系（后代向上）分别求：
 *   - 最少代数 minGen：BFS 首达步数，以及其中一条完整最短成员链；
 *   - 最多代数 maxGen：DAG 上的最长路（记忆化 DFS），以及一条完整最长成员链。
 * 只有 minGen < maxGen（同一对人在不同路径上代际跨度不一致）才列为矛盾；
 * 同代不同路径（minGen === maxGen，例如经父系、母系两条 2 代路径到同一祖父母）
 * 不报警。每一对祖先/后代只枚举一次（以后代为起点遍历其全部祖先）。
 *
 * filterId 可选：仅返回该成员作为祖先或后代参与的矛盾；
 * 但 total 仍为过滤前的矛盾总数，便于界面提示“全部 N 对、其中包含该成员 M 对”。
 * filterId 指向不存在的成员时返回 { error: '成员不存在' }。
 *
 * 返回 {
 *   total,      // 全部矛盾条数（过滤前）
 *   filtered,   // 是否使用了成员筛选
 *   conflicts: [{
 *     ancestorId, descendantId,
 *     minGen, maxGen, diff,           // diff = maxGen - minGen（代数差）
 *     shortestPath: [ancestorId, ..., descendantId],  // 祖先→子女→…→后代
 *     longestPath:  [ancestorId, ..., descendantId],
 *   }]
 * }
 */
function findGenerationConflicts(state, filterId = null) {
  if (filterId !== null && filterId !== undefined && !hasMember(state, filterId)) {
    return { error: '成员不存在' };
  }
  const filtered = !!filterId;

  const all = [];

  for (const descendant of state.members) {
    const profiles = ancestorProfiles(state, descendant.id);
    for (const [ancestorId, p] of profiles) {
      if (p.maxGen <= p.minGen) continue; // 同代不同路径不算矛盾
      all.push({
        ancestorId,
        descendantId: descendant.id,
        minGen: p.minGen,
        maxGen: p.maxGen,
        diff: p.maxGen - p.minGen,
        shortestPath: p.shortestPath,
        longestPath: p.longestPath,
      });
    }
  }

  all.sort((a, b) => {
    if (b.diff !== a.diff) return b.diff - a.diff;
    if (b.maxGen !== a.maxGen) return b.maxGen - a.maxGen;
    if (a.ancestorId !== b.ancestorId) return a.ancestorId.localeCompare(b.ancestorId);
    return a.descendantId.localeCompare(b.descendantId);
  });

  const conflicts = filtered
    ? all.filter((c) => c.ancestorId === filterId || c.descendantId === filterId)
    : all;

  return { total: all.length, filtered, conflicts };
}

/**
 * 变更影响预览（纯函数，不修改 state、不写入任何数据）。
 *
 * 以当前家谱为基准，假设应用一条变更，构造不落盘的假设图：
 *   - action 'add'：新增一条 parentId → childId 父母→子女关系。
 *     沿用与真实建边完全相同的 validateEdge 校验（成员存在、自指、重复边、
 *     每名子女至多两位父母、祖先环路），校验失败返回 { error } 并说明原因；
 *   - action 'remove'：移除一条现有关系；关系不存在返回 { error }。
 *
 * 随后在「当前图」与「假设图」上分别做辈分矛盾核查，按 祖先|后代 成员对逐对对比
 * （不是只比较矛盾总数）：
 *   - added：变更后新出现的矛盾（变更前该对无矛盾：可能本无祖先关系，或辈分一致）；
 *   - removed：变更后消失的矛盾；
 *   - changed：变更前后都是矛盾、但 [minGen, maxGen] 代数范围发生变化；
 *   - 范围完全一致的矛盾计入 unchangedCount，不逐条列出。
 * 每一条都给出变更前 / 变更后两侧的代际档案（minGen、maxGen 与最短、最长成员链），
 * 某侧两人不存在祖先关系时该侧为 null。
 *
 * 返回 { error } 或 {
 *   action, parentId, childId,
 *   beforeTotal, afterTotal, unchangedCount,
 *   added:   [{ ancestorId, descendantId, before, after }],
 *   removed: [{ ancestorId, descendantId, before, after }],
 *   changed: [{ ancestorId, descendantId, before, after }],
 * }  // before / after 为 { minGen, maxGen, shortestPath, longestPath } 或 null
 */
function previewEdgeImpact(state, change) {
  const action = change && change.action;
  const parentId = change && typeof change.parentId === 'string' ? change.parentId.trim() : '';
  const childId = change && typeof change.childId === 'string' ? change.childId.trim() : '';

  if (action !== 'add' && action !== 'remove') {
    return { error: '不支持的变更类型：仅支持新增（add）或移除（remove）一条父母→子女关系' };
  }
  if (!parentId || !childId) return { error: '请选择父母与子女' };

  // 构造假设图：深拷贝父母邻接表后应用变更，当前家谱保持不变
  const parentsOf = {};
  for (const [cid, parents] of Object.entries(state.parentsOf || {})) {
    parentsOf[cid] = [...parents];
  }

  if (action === 'add') {
    // 与真实建边完全一致的校验：成员存在、自指、重复、父母上限、祖先环路
    const check = validateEdge(state, parentId, childId);
    if (check.error) return { error: check.error };
    (parentsOf[childId] ||= []).push(parentId);
  } else {
    const parents = state.parentsOf[childId] || [];
    if (!parents.includes(parentId)) {
      return { error: '关系不存在：当前家谱中没有这条父母→子女关系，无法预览移除' };
    }
    parentsOf[childId] = parents.filter((p) => p !== parentId);
  }
  const hypoState = { ...state, parentsOf };

  const before = findGenerationConflicts(state);
  const after = findGenerationConflicts(hypoState);

  const keyOf = (c) => pairKeyOf(c.ancestorId, c.descendantId);
  const beforeByKey = new Map(before.conflicts.map((c) => [keyOf(c), c]));
  const afterByKey = new Map(after.conflicts.map((c) => [keyOf(c), c]));

  // 补全「非矛盾侧」代际档案时按后代缓存祖先档案，避免重复计算
  const beforeProfiles = new Map(); // descendantId -> ancestorProfiles(state, descendantId)
  const afterProfiles = new Map(); // descendantId -> ancestorProfiles(hypoState, descendantId)
  const profileOf = (cache, targetState, ancestorId, descendantId) => {
    if (!cache.has(descendantId)) {
      cache.set(descendantId, ancestorProfiles(targetState, descendantId));
    }
    return cache.get(descendantId).get(ancestorId) || null;
  };

  const pick = (c) => ({
    minGen: c.minGen,
    maxGen: c.maxGen,
    shortestPath: c.shortestPath,
    longestPath: c.longestPath,
  });

  const added = [];
  const removed = [];
  const changed = [];
  let unchangedCount = 0;

  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  for (const key of keys) {
    const b = beforeByKey.get(key);
    const a = afterByKey.get(key);
    if (b && a) {
      if (b.minGen === a.minGen && b.maxGen === a.maxGen) {
        unchangedCount += 1;
      } else {
        changed.push({
          ancestorId: a.ancestorId,
          descendantId: a.descendantId,
          before: pick(b),
          after: pick(a),
        });
      }
    } else if (a) {
      added.push({
        ancestorId: a.ancestorId,
        descendantId: a.descendantId,
        before: profileOf(beforeProfiles, state, a.ancestorId, a.descendantId),
        after: pick(a),
      });
    } else {
      removed.push({
        ancestorId: b.ancestorId,
        descendantId: b.descendantId,
        before: pick(b),
        after: profileOf(afterProfiles, hypoState, b.ancestorId, b.descendantId),
      });
    }
  }

  // 排序：变化幅度大者优先，同幅度按成员 ID 保证确定性
  const byIds = (x, y) => {
    if (x.ancestorId !== y.ancestorId) return x.ancestorId.localeCompare(y.ancestorId);
    return x.descendantId.localeCompare(y.descendantId);
  };
  const diffOf = (p) => p.maxGen - p.minGen;
  added.sort((x, y) => diffOf(y.after) - diffOf(x.after) || byIds(x, y));
  removed.sort((x, y) => diffOf(y.before) - diffOf(x.before) || byIds(x, y));
  changed.sort((x, y) => {
    const dx = Math.abs(diffOf(x.after) - diffOf(x.before));
    const dy = Math.abs(diffOf(y.after) - diffOf(y.before));
    return dy - dx || byIds(x, y);
  });

  return {
    action,
    parentId,
    childId,
    beforeTotal: before.total,
    afterTotal: after.total,
    unchangedCount,
    added,
    removed,
    changed,
  };
}

/**
 * 删除成员影响预览（纯函数，不修改 state、不写入任何数据）。
 *
 * 以当前家谱为基准，构造一个不落盘的只读假设图：移除目标成员本身，以及全部
 * 以其为父母或子女的亲子关系（与真实 deleteMember 的级联范围一致），其余成员保留。
 *
 * 比较范围限定为删除后**仍在谱中**的、有序的「祖先 → 后代」成员对（两人不同）：
 * 以变更前（当前家谱）原本可达为准逐对枚举，在两张图上分别求祖先到后代的
 * **最短代数（BFS 首达步数）与一条最短成员链**，按最短代数判定：
 *   - disconnected：变更前可达、删除后不可达（唯一通路经过被删成员）；
 *     after 为 null（删除后成员链为空）；
 *   - lengthened：删除后仍可达但最短代数变大（最短链经过被删成员，
 *     只能改走更长的替代路径），附 genIncrease（增加的代数）；
 *   - 其余（最短代数不变，含仍有**同代替代路径**的多路径情形）计入 unaffectedCount，
 *     不逐条列出——因此不能把仍有替代路径的成员对误报为断联。
 * 删边与删点只会消除路径，不会产生新路径或更短路径，故不存在「删除后变短 / 新可达」。
 * 端点之一是被删成员的成员对随其离谱，不参与比较。
 *
 * 返回 { error } 或 {
 *   memberId, removedEdgeCount, remainingMemberCount,
 *   comparedCount,       // 变更前原本可达、且两端删除后仍在谱的成员对总数
 *   disconnectedCount, lengthenedCount, unaffectedCount,
 *   disconnected: [{ ancestorId, descendantId, before: { minGen, shortestPath }, after: null }],
 *   lengthened:   [{ ancestorId, descendantId, genIncrease,
 *                    before: { minGen, shortestPath }, after: { minGen, shortestPath } }],
 * }  // shortestPath 方向为 [祖先, ..., 后代]；before 的链允许经过被删成员（删除前其仍在谱）
 */
function previewMemberDeletion(state, rawMemberId) {
  const memberId = typeof rawMemberId === 'string' ? rawMemberId.trim() : '';
  if (!memberId || !hasMember(state, memberId)) return { error: '成员不存在' };

  // 构造删除后的只读假设图（深拷贝父母邻接表），当前家谱保持不变
  const remainingMembers = state.members.filter((m) => m.id !== memberId);
  const parentsOf = {};
  let removedEdgeCount = 0;
  for (const [childId, parents] of Object.entries(state.parentsOf || {})) {
    if (childId === memberId) {
      removedEdgeCount += parents.length; // 以被删成员为子女的关系
      continue;
    }
    const kept = parents.filter((p) => p !== memberId);
    removedEdgeCount += parents.length - kept.length; // 以被删成员为父母的关系
    parentsOf[childId] = kept;
  }
  const hypoState = { ...state, members: remainingMembers, parentsOf };

  // 按后代缓存两张图的祖先档案，避免重复 BFS
  const beforeCache = new Map();
  const afterCache = new Map();
  const profilesOf = (cache, targetState, descendantId) => {
    if (!cache.has(descendantId)) cache.set(descendantId, ancestorProfiles(targetState, descendantId));
    return cache.get(descendantId);
  };

  const pickShortest = (p) => ({ minGen: p.minGen, shortestPath: p.shortestPath });

  const disconnected = [];
  const lengthened = [];
  let unaffectedCount = 0;
  let comparedCount = 0;

  // 仅枚举删除后仍在谱中的成员对；以变更前（当前家谱）原本可达为准
  for (const descendant of remainingMembers) {
    const beforeMap = profilesOf(beforeCache, state, descendant.id);
    const afterMap = profilesOf(afterCache, hypoState, descendant.id);
    for (const [ancestorId, beforeProfile] of beforeMap) {
      if (ancestorId === memberId) continue; // 祖先随删除离谱，不参与比较
      comparedCount += 1;
      const afterProfile = afterMap.get(ancestorId) || null;
      if (!afterProfile) {
        disconnected.push({
          ancestorId,
          descendantId: descendant.id,
          before: pickShortest(beforeProfile),
          after: null,
        });
      } else if (afterProfile.minGen > beforeProfile.minGen) {
        lengthened.push({
          ancestorId,
          descendantId: descendant.id,
          genIncrease: afterProfile.minGen - beforeProfile.minGen,
          before: pickShortest(beforeProfile),
          after: pickShortest(afterProfile),
        });
      } else {
        unaffectedCount += 1;
      }
    }
  }

  // 排序：影响严重者优先，同档按成员 ID 保证确定性
  const byIds = (x, y) => {
    if (x.ancestorId !== y.ancestorId) return x.ancestorId.localeCompare(y.ancestorId);
    return x.descendantId.localeCompare(y.descendantId);
  };
  disconnected.sort((x, y) => y.before.minGen - x.before.minGen || byIds(x, y));
  lengthened.sort(
    (x, y) =>
      y.genIncrease - x.genIncrease || y.before.minGen - x.before.minGen || byIds(x, y),
  );

  return {
    memberId,
    removedEdgeCount,
    remainingMemberCount: remainingMembers.length,
    comparedCount,
    disconnectedCount: disconnected.length,
    lengthenedCount: lengthened.length,
    unaffectedCount,
    disconnected,
    lengthened,
  };
}

/**
 * 备份文件整份校验（纯函数，不修改任何状态）。
 *
 * 备份格式（与下载接口一致，仅含成员 ID、姓名、纪念日与关系）：
 *   { "members": [{ "id", "name", "birthday", "deathday" }], "edges": [{ "parentId", "childId" }] }
 * 成员的 birthday / deathday 为公历月日 { "month", "day" } 或 null（未登记）；
 * 旧备份缺少这两个字段时视为未登记，字段存在但非法（如 2 月 30 日）逐项报错。
 *
 * 按与正常录入完全相同的规则严格校验整份文件，发现的问题**逐项列入 errors，
 * 绝不静默丢弃任何条目**：
 *   - 文件级：顶层不是对象、缺少 members/edges 数组、成员超过 maxMembers 上限；
 *   - 成员级（逐项）：不是对象、缺少有效 id / 姓名、姓名超过 50 字、ID 重复
 *     （每个重复副本都报错并指出与第几项重复）；
 *   - 关系级（逐条）：不是对象、parentId/childId 缺失或类型非法、自指、
 *     端点不在成员列表中（缺失端点）、与前面某条完全重复（每个副本都报错）、
 *     去重后某子女超过两位父母（按子女逐项）、祖先环路（在去重后的整张图上
 *     对每条边做可达性判定，成环的每条边都报错）。
 *
 * 返回 {
 *   valid, error,            // valid 为 false 时 error 为问题总数概要
 *   errors: [{ where: 'file'|'member'|'edge', index: number|null, message }],
 *   memberCount, edgeCount,  // 净化后（合法时即最终）的成员与关系数量
 *   members: [{ id, name, birthday, deathday }], // 净化后的成员（姓名已 trim，
 *                                                // 纪念日缺失/未登记为 null；仅 valid 时可安全恢复）
 *   edges: [{ parentId, childId }],
 * }
 */
function validateBackup(raw, maxMembers = MAX_MEMBERS) {
  const errors = [];
  const fileError = (message) => errors.push({ where: 'file', index: null, message });
  const memberError = (index, message) => errors.push({ where: 'member', index, message });
  const edgeError = (index, message) => errors.push({ where: 'edge', index, message });

  const done = (members, edges) => {
    const valid = errors.length === 0;
    return {
      valid,
      error: valid ? null : `备份文件未通过校验：共 ${errors.length} 项问题`,
      errors,
      memberCount: members.length,
      edgeCount: edges.length,
      members,
      edges,
    };
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fileError('备份文件顶层必须是 JSON 对象：{ "members": [...], "edges": [...] }');
    return done([], []);
  }
  const rawMembers = raw.members;
  const rawEdges = raw.edges;
  if (!Array.isArray(rawMembers)) {
    fileError('缺少 members 数组（成员列表，每项含 id 与 name）');
  }
  if (!Array.isArray(rawEdges)) {
    fileError('缺少 edges 数组（父母→子女关系列表，每项含 parentId 与 childId）');
  }
  if (errors.length > 0) return done([], []);

  // ---- 成员：结构、姓名规则、ID 重复 ----
  if (rawMembers.length > maxMembers) {
    fileError(`成员共 ${rawMembers.length} 人，超过 ${maxMembers} 人上限`);
  }
  const members = [];
  const idFirstIndex = new Map(); // id -> 首次出现的下标（含姓名非法的条目，供端点存在性判定）
  const nameOfId = new Map();
  rawMembers.forEach((entry, index) => {
    const nth = `第 ${index + 1} 项成员`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      memberError(index, `${nth}不是对象（应含 id 与 name）`);
      return;
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    let ok = true;
    if (!id) {
      memberError(index, `${nth}缺少有效的 id（应为非空字符串）`);
      ok = false;
    }
    if (!name) {
      memberError(index, `${nth}${id ? `（ID "${id}"）` : ''}缺少有效的姓名（应为非空字符串）`);
      ok = false;
    } else if (name.length > MAX_BACKUP_NAME_LENGTH) {
      memberError(
        index,
        `${nth}「${name.slice(0, 12)}…」姓名 ${name.length} 字，超过 ${MAX_BACKUP_NAME_LENGTH} 字上限`,
      );
      ok = false;
    }
    // 纪念日：旧备份缺少字段视为未登记（null）；字段存在但非法逐项报错
    const anniversaries = { birthday: null, deathday: null };
    for (const type of ANNIVERSARY_TYPES) {
      const rawValue = entry[type];
      if (rawValue === undefined || rawValue === null) continue;
      const check = validateMonthDay(rawValue);
      if (check.error) {
        memberError(index, `${nth}的${TYPE_LABEL[type]}无效：${check.error}`);
        ok = false;
      } else {
        anniversaries[type] = check.value;
      }
    }
    if (!id) return;
    if (idFirstIndex.has(id)) {
      memberError(index, `${nth}的 ID "${id}" 与第 ${idFirstIndex.get(id) + 1} 项重复`);
      return; // 重复 ID 不进入净化列表（保留首次出现）
    }
    idFirstIndex.set(id, index);
    if (name) nameOfId.set(id, name);
    if (ok) members.push({ id, name, birthday: anniversaries.birthday, deathday: anniversaries.deathday });
  });

  const label = (id) => (nameOfId.has(id) ? `「${nameOfId.get(id)}」` : `ID "${id}"`);

  // ---- 关系：结构、自指、缺失端点 ----
  const structEdges = []; // { index, parentId, childId }
  rawEdges.forEach((entry, index) => {
    const nth = `第 ${index + 1} 条关系`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      edgeError(index, `${nth}不是对象（应含 parentId 与 childId）`);
      return;
    }
    const parentId = typeof entry.parentId === 'string' ? entry.parentId.trim() : '';
    const childId = typeof entry.childId === 'string' ? entry.childId.trim() : '';
    if (!parentId || !childId) {
      const missing = [!parentId && 'parentId', !childId && 'childId'].filter(Boolean).join(' 与 ');
      edgeError(index, `${nth}缺少有效的 ${missing}（应为非空字符串）`);
      return;
    }
    if (parentId === childId) {
      edgeError(index, `${nth}为自指关系：${label(parentId)} 不能成为自己的父母`);
      return;
    }
    const missing = [];
    if (!idFirstIndex.has(parentId)) missing.push(`父母端 ${label(parentId)}`);
    if (!idFirstIndex.has(childId)) missing.push(`子女端 ${label(childId)}`);
    if (missing.length > 0) {
      edgeError(
        index,
        `${nth}（${label(parentId)} → ${label(childId)}）的端点不在成员列表中：${missing.join('、')}`,
      );
      return;
    }
    structEdges.push({ index, parentId, childId });
  });

  // ---- 重复关系：同一父母→子女出现多次，每个副本都报错 ----
  // 键按有序端点编码（pairKeyOf）：ID 含 "|"、空格的不同关系不会被误判为重复
  const firstEdgeByKey = new Map(); // 有序端点键（pairKeyOf）-> 首次出现的下标
  const deduped = [];
  for (const e of structEdges) {
    const key = pairKeyOf(e.parentId, e.childId);
    const first = firstEdgeByKey.get(key);
    if (first !== undefined) {
      edgeError(
        e.index,
        `第 ${e.index + 1} 条关系与第 ${first + 1} 条重复：${label(e.parentId)} → ${label(e.childId)}`,
      );
    } else {
      firstEdgeByKey.set(key, e.index);
      deduped.push(e);
    }
  }

  // ---- 每名子女至多两位父母（按去重后的关系统计，逐名子女报错） ----
  const parentsByChild = new Map();
  for (const e of deduped) {
    if (!parentsByChild.has(e.childId)) parentsByChild.set(e.childId, []);
    parentsByChild.get(e.childId).push(e);
  }
  for (const [childId, list] of parentsByChild) {
    if (list.length > MAX_PARENTS_PER_CHILD) {
      const at = list.map((e) => `第 ${e.index + 1} 条`).join('、');
      const names = list.map((e) => label(e.parentId)).join('、');
      edgeError(
        list[0].index,
        `${label(childId)} 共有 ${list.length} 位父母（${names}，见${at}），` +
          `超过每名子女至多 ${MAX_PARENTS_PER_CHILD} 位父母的上限`,
      );
    }
  }

  // ---- 祖先环路：在去重后的整张图上对每条边做可达性判定，成环的每条边都报错 ----
  const cycleState = { maxMembers, members, parentsOf: {} };
  for (const e of deduped) {
    (cycleState.parentsOf[e.childId] ||= []).push(e.parentId);
  }
  for (const e of deduped) {
    if (isReachableUp(cycleState, e.parentId, e.childId)) {
      edgeError(
        e.index,
        `第 ${e.index + 1} 条关系形成祖先环路：${label(e.parentId)} 沿父母链向上可到达 ` +
          `${label(e.childId)}，恢复后将出现循环祖先关系`,
      );
    }
  }

  return done(members, deduped.map((e) => ({ parentId: e.parentId, childId: e.childId })));
}

module.exports = {
  MAX_PARENTS_PER_CHILD,
  MAX_MEMBERS,
  MAX_BATCH_EDGES,
  MAX_BACKUP_NAME_LENGTH,
  MAX_DESCENDANT_GENERATIONS,
  createState,
  getMember,
  pairKeyOf,
  isReachableUp,
  validateEdge,
  validateEdgeBatch,
  validateBackup,
  previewMergeMembers,
  allShortestPathsUp,
  findCommonAncestors,
  descendantBranches,
  ancestorProfiles,
  findGenerationConflicts,
  previewEdgeImpact,
  previewMemberDeletion,
};
