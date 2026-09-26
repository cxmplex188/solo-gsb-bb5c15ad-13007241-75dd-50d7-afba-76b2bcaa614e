'use strict';

/**
 * 整谱关系图布局（纯函数，不修改 state、不写入任何数据）。
 *
 * 把当前全部成员与「父母 → 子女」关系排布成分层平面图，供前端绘制可缩放的 SVG：
 *   - 先按「忽略方向」的关系把成员划分成若干连通分量（没有任何关系的成员各自成为
 *     单成员分量），分量自上而下堆叠、之间留白 GAP_COMPONENT；
 *   - 每个分量内部按「最长父母链」分层：没有父母的成员在第 0 层，其余成员的层号
 *     = 其直接父母的最大层号 + 1（父母必与自己同分量；家谱是 DAG，记忆化 DFS 收敛）；
 *   - 层内排序：第 0 层（没有父母的层）按姓名、成员 ID 稳定排序；其余层自上而下
 *     处理，按各成员「直接父母节点横坐标的重心（平均值）」升序，平局按姓名、成员 ID
 *     稳定排序——处理到某层时其父母所在层的坐标已经确定；
 *   - 同一成员无论被几位父母指向都只布局一个节点，每条父母→子女关系各保留一条连线；
 *   - 节点宽度按姓名估计（全角字符按 CHAR_W_WIDE、其余按 CHAR_W_NARROW），同层节点
 *     从左到右依次排开并保留最小间距 GAP_X，各层在分量宽度内水平居中，
 *     节点与姓名互不重叠。
 *
 * 坐标系：x 向右、y 向下，节点的 (x, y) 为中心点；画布顶部保留 HEADER_H 高度，
 * 由 caption 给出「生成时的家谱版本」标注位置与文本（version 仅用于组成标注文本
 * 并为其预留画布宽度，不影响任何节点坐标）。
 *
 * 返回 {
 *   empty,                        // 是否空谱（没有任何成员）
 *   memberCount, edgeCount, componentCount,
 *   width, height,                // 画布尺寸（含四周留白与顶部版本标注区）
 *   caption: { x, y, text }|null, // 图上的版本标注（空谱为 null）
 *   components: [{ index, x, y, width, height, memberCount }],  // 分量背景带
 *   nodes: [{ id, name, x, y, w, h, layer, component }],
 *   edges: [{ parentId, childId }],
 * }
 */

const NODE_H = 40; // 节点高度
const NODE_MIN_W = 76; // 节点最小宽度
const NODE_PAD_X = 12; // 节点内姓名两侧留白
const CHAR_W_WIDE = 14; // 全角字符（中文等）估计宽度
const CHAR_W_NARROW = 8; // 半角字符（ASCII 等）估计宽度
const GAP_X = 28; // 同层相邻节点的最小水平间距
const GAP_Y = 56; // 相邻层之间的垂直间距
const GAP_COMPONENT = 72; // 连通分量之间的垂直留白
const BAND_PAD = 12; // 分量背景带相对节点区域的内边距
const MARGIN = 24; // 画布四周留白
const HEADER_H = 40; // 画布顶部版本标注区高度

/** 文本估计宽度：全角字符按 CHAR_W_WIDE、其余按 CHAR_W_NARROW 累加 */
function measureName(name) {
  let w = 0;
  for (const ch of String(name)) {
    w += /[^\x00-\xff]/.test(ch) ? CHAR_W_WIDE : CHAR_W_NARROW;
  }
  return w;
}

/** 节点宽度：姓名估计宽度 + 两侧留白，不小于最小宽度 */
function nodeWidth(name) {
  return Math.max(NODE_MIN_W, Math.ceil(measureName(name)) + 2 * NODE_PAD_X);
}

/** 姓名（中文排序）、成员 ID 的稳定排序比较器 */
function compareByNameThenId(nameOf) {
  return (a, b) => {
    const byName = String(nameOf.get(a)).localeCompare(String(nameOf.get(b)), 'zh');
    if (byName !== 0) return byName;
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

function layoutFamilyChart(state, version = 0) {
  const members = Array.isArray(state && state.members) ? state.members : [];
  const nameOf = new Map();
  for (const m of members) {
    if (m && typeof m.id === 'string' && !nameOf.has(m.id)) {
      nameOf.set(m.id, typeof m.name === 'string' ? m.name : '');
    }
  }

  // 边表：仅保留两端都在成员表中的关系（防御性过滤；正常状态必然如此）
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
      width: 0,
      height: 0,
      caption: null,
      components: [],
      nodes: [],
      edges: [],
    };
  }

  // 1) 连通分量：忽略方向，并查集合并每条关系的两端
  const uf = new Map([...nameOf.keys()].map((id) => [id, id]));
  const find = (x) => {
    let root = x;
    while (uf.get(root) !== root) root = uf.get(root);
    let cur = x;
    while (uf.get(cur) !== root) {
      const next = uf.get(cur);
      uf.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const e of edges) {
    const ra = find(e.parentId);
    const rb = find(e.childId);
    if (ra !== rb) uf.set(ra, rb);
  }
  const compIds = new Map(); // 并查集根 -> [memberId]
  for (const id of nameOf.keys()) {
    const root = find(id);
    if (!compIds.has(root)) compIds.set(root, []);
    compIds.get(root).push(id);
  }

  // 每个成员的直接父母（用于分层与重心；父母必在同一分量）
  const parentsOfLocal = new Map([...nameOf.keys()].map((id) => [id, []]));
  for (const e of edges) parentsOfLocal.get(e.childId).push(e.parentId);

  const byNameThenId = compareByNameThenId(nameOf);

  // 2) 逐分量：最长父母链分层 → 层内排序 → 横坐标
  const components = [];
  for (const ids of compIds.values()) {
    // 最长父母链分层：无父母为第 0 层，否则为父母最大层号 + 1（DAG 保证收敛）
    const layerOf = new Map();
    const layerOfId = (id) => {
      if (layerOf.has(id)) return layerOf.get(id);
      let layer = 0;
      for (const p of parentsOfLocal.get(id)) {
        layer = Math.max(layer, layerOfId(p) + 1);
      }
      layerOf.set(id, layer);
      return layer;
    };
    const layers = new Map(); // layer -> [id]（排序后回填为有序数组）
    let maxLayer = 0;
    for (const id of ids) {
      const layer = layerOfId(id);
      maxLayer = Math.max(maxLayer, layer);
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer).push(id);
    }

    // 层内排序与横坐标：第 0 层（没有父母的层）按姓名、ID；其余层自上而下，
    // 按直接父母横坐标重心升序，平局按姓名、ID（父母所在层坐标已确定）
    const xOf = new Map();
    const widthOf = new Map(ids.map((id) => [id, nodeWidth(nameOf.get(id))]));
    const layerWidths = new Map();
    let compWidth = 0;
    for (let layer = 0; layer <= maxLayer; layer += 1) {
      const idsInLayer = layers.get(layer);
      let sorted;
      if (layer === 0) {
        sorted = [...idsInLayer].sort(byNameThenId);
      } else {
        const barycenterOf = new Map(
          idsInLayer.map((id) => {
            const parents = parentsOfLocal.get(id).filter((p) => xOf.has(p));
            const sum = parents.reduce((acc, p) => acc + xOf.get(p), 0);
            return [id, parents.length ? sum / parents.length : 0];
          }),
        );
        sorted = [...idsInLayer].sort((a, b) => {
          const diff = barycenterOf.get(a) - barycenterOf.get(b);
          if (diff !== 0) return diff;
          return byNameThenId(a, b);
        });
      }
      let cursor = 0;
      for (const id of sorted) {
        xOf.set(id, cursor + widthOf.get(id) / 2);
        cursor += widthOf.get(id) + GAP_X;
      }
      const layerWidth = cursor - GAP_X;
      layerWidths.set(layer, layerWidth);
      compWidth = Math.max(compWidth, layerWidth);
      layers.set(layer, sorted);
    }

    // 各层在分量宽度内水平居中（层内相对间距不变）
    for (let layer = 0; layer <= maxLayer; layer += 1) {
      const dx = (compWidth - layerWidths.get(layer)) / 2;
      for (const id of layers.get(layer)) xOf.set(id, xOf.get(id) + dx);
    }

    components.push({
      ids,
      layers,
      maxLayer,
      xOf,
      width: compWidth,
      height: maxLayer * (NODE_H + GAP_Y) + NODE_H,
    });
  }

  // 分量排序：按各自「姓名、ID 最小」的成员稳定排序，自上而下堆叠
  const firstOf = (comp) => [...comp.ids].sort(byNameThenId)[0];
  components.sort((a, b) => byNameThenId(firstOf(a), firstOf(b)));

  // 3) 整体排布：分量水平居中、垂直堆叠，分量之间留白；顶部为版本标注区
  const versionText = Number.isInteger(version) && version >= 0 ? version : 0;
  const captionText =
    `整谱关系图 · 家谱版本 ${versionText} · 成员 ${nameOf.size} · ` +
    `关系 ${edges.length} · 连通分量 ${components.length}`;
  const maxCompWidth = Math.max(...components.map((c) => c.width));
  // 画布内容宽度：最宽分量与版本标注文本取较大者，保证标注不被裁切
  const contentWidth = Math.max(maxCompWidth, measureName(captionText));
  const width = contentWidth + 2 * MARGIN;

  const nodes = [];
  const bands = [];
  let yCursor = MARGIN + HEADER_H;
  components.forEach((comp, index) => {
    const dx = MARGIN + (contentWidth - comp.width) / 2;
    for (let layer = 0; layer <= comp.maxLayer; layer += 1) {
      const y = yCursor + layer * (NODE_H + GAP_Y) + NODE_H / 2;
      for (const id of comp.layers.get(layer)) {
        nodes.push({
          id,
          name: nameOf.get(id),
          x: round2(comp.xOf.get(id) + dx),
          y: round2(y),
          w: nodeWidth(nameOf.get(id)),
          h: NODE_H,
          layer,
          component: index,
        });
      }
    }
    bands.push({
      index,
      x: round2(dx - BAND_PAD),
      y: round2(yCursor - BAND_PAD),
      width: round2(comp.width + 2 * BAND_PAD),
      height: round2(comp.height + 2 * BAND_PAD),
      memberCount: comp.ids.length,
    });
    yCursor += comp.height + GAP_COMPONENT;
  });
  const height = yCursor - GAP_COMPONENT + MARGIN;

  // 连线顺序确定化：按子女、父母 ID 排序（同一子女的多条父母连线全部保留）
  edges.sort((a, b) =>
    a.childId === b.childId
      ? a.parentId < b.parentId
        ? -1
        : a.parentId > b.parentId
          ? 1
          : 0
      : a.childId < b.childId
        ? -1
        : 1,
  );

  return {
    empty: false,
    memberCount: nameOf.size,
    edgeCount: edges.length,
    componentCount: components.length,
    width: round2(width),
    height: round2(height),
    caption: { x: MARGIN, y: MARGIN + 14, text: captionText },
    components: bands,
    nodes,
    edges,
  };
}

module.exports = {
  layoutFamilyChart,
  measureName,
  nodeWidth,
  NODE_H,
  NODE_MIN_W,
  NODE_PAD_X,
  CHAR_W_WIDE,
  CHAR_W_NARROW,
  GAP_X,
  GAP_Y,
  GAP_COMPONENT,
  BAND_PAD,
  MARGIN,
  HEADER_H,
};
