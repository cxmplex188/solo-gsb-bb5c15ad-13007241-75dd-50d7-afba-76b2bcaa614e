'use strict';

/**
 * 关键连接（桥梁关系）分析（纯函数，不修改 state、不写入任何数据）。
 *
 * 把当前全部成员与「父母 → 子女」关系视为**无向连接**：忽略方向后，
 * 成员被划分为若干互不相连的「家族」（连通分量），分析在各家族内部分别进行。
 * 一条关系是**关键连接（桥）**，当且仅当在它所属的家族内部不存在其他连接路径——
 * 移除这一条关系就会把原来连通的家族拆成互不相连的两部分；
 * 两端之间仍有其他通路（如环形、钻石结构中任意一条边）的关系**不会**被误报。
 *
 * 算法：对每个连通分量做 Tarjan 桥查找（迭代式 DFS，维护发现时间 disc 与
 * 可回溯到的最早发现时间 low；树边 (u→v) 满足 low[v] > disc[u] 即为桥——
 * v 的子树无法绕过这条边回到 u 及其祖先）。对每条桥，移除它后从父母端
 * 做一次 BFS 得到「父母一侧」成员集合，分量内其余成员即「子女一侧」。
 *
 * 返回 {
 *   empty,                          // 是否空谱（没有任何成员）
 *   memberCount, edgeCount, componentCount,
 *   components: [{ index, memberIds: [id], bridgeCount }],  // memberIds 按姓名、ID 排序
 *   bridgeCount,
 *   bridges: [{
 *     parentId, childId,            // 关系的父母端 / 子女端（按原方向）
 *     componentIndex,               // 所属家族（连通分量）序号
 *     componentMemberCount,         // 该家族原有成员数
 *     parentSide: [id],             // 断开后与父母端同侧的成员（含父母端，按姓名、ID 排序）
 *     childSide: [id],              // 断开后与子女端同侧的成员（含子女端，按姓名、ID 排序）
 *   }],
 * }
 */

const { pairKeyOf } = require('./familyGraph');

/** 姓名（中文排序）、成员 ID 的稳定排序比较器 */
function compareIdsByNameThenId(nameOf) {
  return (a, b) => {
    const byName = String(nameOf.get(a)).localeCompare(String(nameOf.get(b)), 'zh');
    if (byName !== 0) return byName;
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

function findCriticalLinks(state) {
  const members = Array.isArray(state && state.members) ? state.members : [];
  const nameOf = new Map();
  for (const m of members) {
    if (m && typeof m.id === 'string' && !nameOf.has(m.id)) {
      nameOf.set(m.id, typeof m.name === 'string' ? m.name : '');
    }
  }
  const byNameThenId = compareIdsByNameThenId(nameOf);

  // 边表：仅保留两端都在成员表中的关系（防御性过滤；正常状态必然如此）。
  // 每对成员之间至多一条关系（反向即祖先环路，录入与加载时均已被拦截），
  // 因此无向化后不存在平行边，按边跳过 DFS 来路即可。
  const edges = [];
  const parentsOf = (state && state.parentsOf) || {};
  for (const [childId, parents] of Object.entries(parentsOf)) {
    if (!nameOf.has(childId) || !Array.isArray(parents)) continue;
    for (const p of parents) {
      if (nameOf.has(p)) edges.push({ parentId: p, childId });
    }
  }

  if (nameOf.size === 0) {
    return {
      empty: true,
      memberCount: 0,
      edgeCount: 0,
      componentCount: 0,
      components: [],
      bridgeCount: 0,
      bridges: [],
    };
  }

  // 无向邻接表：edgeKey 唯一定位一条关系；邻接项按邻居姓名、ID 排序保证确定性。
  // 键按有序端点编码（pairKeyOf）：成员 ID 含 "|"、空格等字符时
  // 不同关系也不会碰撞（否则桥查找会按错键跳过来路、张冠李戴）。
  const edgeKeyOf = (e) => pairKeyOf(e.parentId, e.childId);
  const edgeByKey = new Map();
  const adj = new Map([...nameOf.keys()].map((id) => [id, []]));
  for (const e of edges) {
    const key = edgeKeyOf(e);
    edgeByKey.set(key, e);
    adj.get(e.parentId).push({ to: e.childId, edgeKey: key });
    adj.get(e.childId).push({ to: e.parentId, edgeKey: key });
  }
  for (const list of adj.values()) {
    list.sort((a, b) => byNameThenId(a.to, b.to));
  }

  /**
   * Tarjan 桥查找（迭代式 DFS）：从 startId 出发访问整个连通分量，
   * 返回 { componentIds, bridgeKeys }。visited 为跨分量共享的已访问集合，
   * 因此分量划分与桥查找在同一次遍历中完成。
   */
  const visitComponent = (startId, visited) => {
    const disc = new Map();
    const low = new Map();
    const bridgeKeys = [];
    const componentIds = [];
    let time = 0;
    const stack = [{ id: startId, parentEdge: null, nextIndex: 0 }];
    disc.set(startId, time);
    low.set(startId, time);
    time += 1;
    visited.add(startId);
    componentIds.push(startId);

    while (stack.length) {
      const top = stack[stack.length - 1];
      const neighbors = adj.get(top.id);
      if (top.nextIndex < neighbors.length) {
        const { to, edgeKey } = neighbors[top.nextIndex];
        top.nextIndex += 1;
        if (edgeKey === top.parentEdge) continue; // 来时的树边（无平行边，按边跳过即可）
        if (!disc.has(to)) {
          disc.set(to, time);
          low.set(to, time);
          time += 1;
          visited.add(to);
          componentIds.push(to);
          stack.push({ id: to, parentEdge: edgeKey, nextIndex: 0 });
        } else {
          // 回边：子树可经其他路径回到更早的祖先，更新 low
          low.set(top.id, Math.min(low.get(top.id), disc.get(to)));
        }
      } else {
        stack.pop();
        if (stack.length) {
          const parent = stack[stack.length - 1];
          low.set(parent.id, Math.min(low.get(parent.id), low.get(top.id)));
          if (low.get(top.id) > disc.get(parent.id)) {
            // top 子树无法绕过这条树边回到 parent 及其祖先：该边是桥
            bridgeKeys.push(top.parentEdge);
          }
        }
      }
    }
    return { componentIds, bridgeKeys };
  };

  /** 移除指定关系后，从 from 出发在无向图上 BFS，返回可达成员集合 */
  const reachableWithoutEdge = (from, removedKey) => {
    const seen = new Set([from]);
    const queue = [from];
    for (let head = 0; head < queue.length; head += 1) {
      for (const { to, edgeKey } of adj.get(queue[head])) {
        if (edgeKey === removedKey || seen.has(to)) continue;
        seen.add(to);
        queue.push(to);
      }
    }
    return seen;
  };

  // 逐分量（家族）计算：原本互不连通的家族分别分析
  const visited = new Set();
  const components = [];
  const bridges = [];
  for (const id of [...nameOf.keys()].sort(byNameThenId)) {
    if (visited.has(id)) continue;
    const { componentIds, bridgeKeys } = visitComponent(id, visited);
    const componentIndex = components.length;
    const memberIds = [...componentIds].sort(byNameThenId);
    const memberSet = new Set(componentIds);
    components.push({ index: componentIndex, memberIds, bridgeCount: bridgeKeys.length });
    for (const key of bridgeKeys) {
      const e = edgeByKey.get(key);
      const parentSideSet = reachableWithoutEdge(e.parentId, key);
      const parentSide = [...parentSideSet].sort(byNameThenId);
      // 桥把分量恰好拆成两部分：父母侧的补集即子女一侧
      const childSide = [...memberSet].filter((m) => !parentSideSet.has(m)).sort(byNameThenId);
      bridges.push({
        parentId: e.parentId,
        childId: e.childId,
        componentIndex,
        componentMemberCount: componentIds.length,
        parentSide,
        childSide,
      });
    }
  }

  // 结果确定化：桥按（所属家族序号、子女姓名、父母姓名、ID）稳定排序
  bridges.sort((a, b) => {
    if (a.componentIndex !== b.componentIndex) return a.componentIndex - b.componentIndex;
    const byChild = byNameThenId(a.childId, b.childId);
    if (byChild !== 0) return byChild;
    return byNameThenId(a.parentId, b.parentId);
  });

  return {
    empty: false,
    memberCount: nameOf.size,
    edgeCount: edges.length,
    componentCount: components.length,
    components,
    bridgeCount: bridges.length,
    bridges,
  };
}

module.exports = { findCriticalLinks };
