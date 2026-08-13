import type { ElementData } from "../types";

/**
 * 本地智能美化引擎：对画布元素数据做排版整理。
 * 纯数据变换（不动 leafer），按序执行：
 *   容器包裹 → 连线吸附 → 间距均分 → 尺寸统一 → 配色统一 → 文本居中 → 网格微调
 */

export type BeautifyStats = { label: string; count: number }[];

const PADDING = 16; // 容器包裹内边距
const GAP_DEFAULT = 24; // 默认间距
const SNAP_DIST = 60; // 端点吸附距离
const GRID = 5; // 网格步长
const COLOR_THRESHOLD = 45; // 配色聚类阈值

type Box = { x: number; y: number; width: number; height: number };

const boxOf = (e: ElementData): Box => ({
  x: e.x,
  y: e.y,
  width: e.width,
  height: e.height,
});

const centerOf = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

const unionBox = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.width));
  const y2 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: x2 - x, height: y2 - y };
};

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) {
    return null;
  }
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function colorDist(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function isContainer(e: ElementData) {
  return e.type === "rect" || e.type === "ellipse";
}

function isLineLike(e: ElementData) {
  return e.type === "line" || e.type === "arrow";
}

const isRotated = (e: ElementData) => !!e.rotation && e.rotation % 360 !== 0;

/** 1. 容器包裹：矩形/椭圆自动包裹内部元素 */
function wrapContainers(
  els: ElementData[],
  stats: BeautifyStats,
): ElementData[] {
  let count = 0;
  const containers = els.filter(isContainer);
  const others = els.filter((e) => !isContainer(e));
  for (const box of containers) {
    const inner = others.filter((e) => {
      const c = centerOf(boxOf(e));
      return (
        c.x >= box.x && c.x <= box.x + box.width &&
        c.y >= box.y && c.y <= box.y + box.height
      );
    });
    if (inner.length === 0) {
      continue;
    }
    const u = unionBox(inner.map(boxOf));
    const nx = u.x - PADDING;
    const ny = u.y - PADDING;
    const nw = u.width + PADDING * 2;
    const nh = u.height + PADDING * 2;
    const changed =
      Math.abs(nx - box.x) > 1 ||
      Math.abs(ny - box.y) > 1 ||
      Math.abs(nw - box.width) > 1 ||
      Math.abs(nh - box.height) > 1;
    if (changed) {
      box.x = nx;
      box.y = ny;
      box.width = nw;
      box.height = nh;
      count++;
    }
  }
  if (count) {
    stats.push({ label: "容器包裹", count });
  }
  return els;
}

/** 2. 连线吸附：线/箭头端点吸附到最近容器边缘中心 */
function snapLineEndpoints(
  els: ElementData[],
  stats: BeautifyStats,
): ElementData[] {
  let count = 0;
  const anchors: { x: number; y: number }[] = [];
  for (const c of els) {
    if (!isContainer(c) || isRotated(c)) {
      continue;
    }
    const box = boxOf(c);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    anchors.push({ x: cx, y: box.y }, { x: cx, y: box.y + box.height });
    anchors.push({ x: box.x, y: cy }, { x: box.x + box.width, y: cy });
  }
  if (!anchors.length) {
    return els;
  }
  for (const line of els) {
    if (!isLineLike(line) || !line.points || line.points.length < 2) {
      continue;
    }
    const abs = line.points.map((p) => ({ x: p.x + line.x, y: p.y + line.y }));
    let moved = false;
    const snapped = abs.map((p) => {
      let best = { x: p.x, y: p.y };
      let bestDist = SNAP_DIST;
      for (const a of anchors) {
        const d = Math.hypot(a.x - p.x, a.y - p.y);
        if (d < bestDist) {
          bestDist = d;
          best = a;
        }
      }
      if (best.x !== p.x || best.y !== p.y) {
        moved = true;
      }
      return best;
    });
    if (moved) {
      const nx = Math.min(snapped[0].x, snapped[1].x);
      const ny = Math.min(snapped[0].y, snapped[1].y);
      line.x = nx;
      line.y = ny;
      line.points = snapped.map((p) => ({ x: p.x - nx, y: p.y - ny }));
      count++;
    }
  }
  if (count) {
    stats.push({ label: "连线吸附", count });
  }
  return els;
}

/** 3. 间距均分：同一行/列的元素统一间距 */
function distribute(els: ElementData[], stats: BeautifyStats): ElementData[] {
  let count = 0;
  const rows: ElementData[][] = [];
  const cols: ElementData[][] = [];

  const byCenterY = [...els].sort(
    (a, b) => centerOf(boxOf(a)).y - centerOf(boxOf(b)).y,
  );
  for (const e of byCenterY) {
    const cy = centerOf(boxOf(e)).y;
    const row = rows.find((r) => {
      const last = centerOf(boxOf(r[r.length - 1])).y;
      return Math.abs(last - cy) < 24;
    });
    (row ?? rows[rows.push([]) - 1]).push(e);
  }
  const realRows = rows.filter((r) => r.length >= 3);
  for (const row of realRows) {
    row.sort((a, b) => centerOf(boxOf(a)).x - centerOf(boxOf(b)).x);
    const gaps: number[] = [];
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1];
      const cur = row[i];
      gaps.push(cur.x - (prev.x + prev.width));
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const gap = median >= 8 && median <= 100 ? median : GAP_DEFAULT;
    let cursor = row[0].x;
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1];
      cursor = prev.x + prev.width + gap;
      if (Math.abs(row[i].x - cursor) > 0.5) {
        row[i].x = cursor;
        count++;
      }
    }
  }

  const byCenterX = [...els].sort(
    (a, b) => centerOf(boxOf(a)).x - centerOf(boxOf(b)).x,
  );
  for (const e of byCenterX) {
    const cx = centerOf(boxOf(e)).x;
    const col = cols.find((c) => {
      const last = centerOf(boxOf(c[c.length - 1])).x;
      return Math.abs(last - cx) < 24;
    });
    (col ?? cols[cols.push([]) - 1]).push(e);
  }
  const realCols = cols.filter((c) => c.length >= 3);
  for (const col of realCols) {
    col.sort((a, b) => centerOf(boxOf(a)).y - centerOf(boxOf(b)).y);
    const gaps: number[] = [];
    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1];
      const cur = col[i];
      gaps.push(cur.y - (prev.y + prev.height));
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const gap = median >= 8 && median <= 100 ? median : GAP_DEFAULT;
    let cursor = col[0].y;
    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1];
      cursor = prev.y + prev.height + gap;
      if (Math.abs(col[i].y - cursor) > 0.5) {
        col[i].y = cursor;
        count++;
      }
    }
  }

  if (count) {
    stats.push({ label: "间距均分", count });
  }
  return els;
}

/** 4. 尺寸统一：同类图形取中位尺寸 */
function unifySize(els: ElementData[], stats: BeautifyStats): ElementData[] {
  let count = 0;
  const groups: Record<string, ElementData[]> = { rect: [], ellipse: [] };
  for (const e of els) {
    if (e.type === "rect" || e.type === "ellipse") {
      groups[e.type].push(e);
    }
  }
  for (const list of Object.values(groups)) {
    if (list.length < 3) {
      continue;
    }
    const ws = list.map((e) => e.width).sort((a, b) => a - b);
    const hs = list.map((e) => e.height).sort((a, b) => a - b);
    const mw = ws[Math.floor(ws.length / 2)];
    const mh = hs[Math.floor(hs.length / 2)];
    for (const e of list) {
      const dw = Math.abs(e.width - mw) / mw;
      const dh = Math.abs(e.height - mh) / mh;
      if (dw > 0.05 && dw < 0.6) {
        e.width = mw;
        count++;
      }
      if (dh > 0.05 && dh < 0.6) {
        e.height = mh;
        count++;
      }
    }
  }
  if (count) {
    stats.push({ label: "尺寸统一", count });
  }
  return els;
}

/** 5. 配色统一：相近颜色聚类归并 */
function unifyColors(els: ElementData[], stats: BeautifyStats): ElementData[] {
  let count = 0;

  const cluster = (colors: string[]): Map<string, string> => {
    const clusters: { center: [number, number, number]; members: string[] }[] =
      [];
    for (const c of colors) {
      const rgb = parseHex(c);
      if (!rgb) {
        continue;
      }
      let best = clusters.find((cl) => colorDist(cl.center, rgb) < COLOR_THRESHOLD);
      if (!best) {
        best = { center: rgb, members: [] };
        clusters.push(best);
      }
      best.members.push(c);
      const n = best.members.length;
      best.center = [
        best.center[0] + (rgb[0] - best.center[0]) / n,
        best.center[1] + (rgb[1] - best.center[1]) / n,
        best.center[2] + (rgb[2] - best.center[2]) / n,
      ];
    }
    const map = new Map<string, string>();
    for (const cl of clusters) {
      if (cl.members.length < 2) {
        continue;
      }
      const target = toHex(cl.center);
      for (const m of cl.members) {
        const mrgb = parseHex(m)!;
        if (colorDist(mrgb, cl.center) > 8 && m !== target) {
          map.set(m, target);
        }
      }
    }
    return map;
  };

  const fillMap = cluster(
    els.filter((e) => isContainer(e) && e.fill && e.fill !== "none").map((e) => e.fill!),
  );
  for (const e of els) {
    if (!isContainer(e) || !e.fill) {
      continue;
    }
    const target = fillMap.get(e.fill);
    if (target) {
      e.fill = target;
      count++;
    }
  }

  const strokeMap = cluster(
    els.filter((e) => e.stroke && isLineLike(e) && !isContainer(e)).map((e) => e.stroke!),
  );
  for (const e of els) {
    if (!e.stroke) {
      continue;
    }
    const target = strokeMap.get(e.stroke);
    if (target) {
      e.stroke = target;
      count++;
    }
  }

  if (count) {
    stats.push({ label: "配色统一", count });
  }
  return els;
}

/** 6. 文本居中：靠近容器的文本自动对齐到容器中心 */
function centerTexts(els: ElementData[], stats: BeautifyStats): ElementData[] {
  let count = 0;
  const texts = els.filter((e) => e.type === "text");
  const containers = els.filter(isContainer);
  for (const t of texts) {
    const tc = centerOf(boxOf(t));
    for (const c of containers) {
      const cc = centerOf(boxOf(c));
      const d = Math.hypot(tc.x - cc.x, tc.y - cc.y);
      if (d < 40) {
        const nx = cc.x - t.width / 2;
        const ny = cc.y - t.height / 2;
        if (Math.abs(nx - t.x) > 1 || Math.abs(ny - t.y) > 1) {
          t.x = nx;
          t.y = ny;
          count++;
        }
        break;
      }
    }
  }
  if (count) {
    stats.push({ label: "文本居中", count });
  }
  return els;
}

/** 7. 网格微调：接近网格线的坐标吸附到网格 */
function snapGrid(els: ElementData[], stats: BeautifyStats): ElementData[] {
  let count = 0;
  const snap = (v: number) => {
    const r = Math.round(v / GRID) * GRID;
    return Math.abs(r - v) <= 3 ? r : v;
  };
  for (const e of els) {
    const nx = snap(e.x);
    const ny = snap(e.y);
    if (nx !== e.x) {
      e.x = nx;
      count++;
    }
    if (ny !== e.y) {
      e.y = ny;
      count++;
    }
  }
  if (count) {
    stats.push({ label: "网格对齐", count });
  }
  return els;
}

export function beautifyScene(elements: ElementData[]): {
  elements: ElementData[];
  stats: BeautifyStats;
} {
  const els = elements.map((e) => ({
    ...e,
    points: e.points?.map((p) => ({ ...p })),
    rotation: e.rotation,
  }));
  const stats: BeautifyStats = [];
  wrapContainers(els, stats);
  snapLineEndpoints(els, stats);
  distribute(els, stats);
  unifySize(els, stats);
  unifyColors(els, stats);
  centerTexts(els, stats);
  snapGrid(els, stats);
  return { elements: els, stats: stats.filter((s) => s.count > 0) };
}
