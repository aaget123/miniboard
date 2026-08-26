import type { Board } from "../board/canvas";
import { TEXT_FONT_SIZE } from "../board/canvas";
import type { ToolRegistry } from "../board/registry";
import type { Toolbar } from "../ui/toolbar";
import type { CustomToolDef, CustomToolInput, ElementData } from "../types";
import { describeFreehandShape } from "../board/beautify";
import { canvasToLocal, localToCanvas, round1 } from "../board/coords";
import { elementBounds } from "../board/bounds";
import type { ArrangeAction } from "../board/arrange";
import type { AiMode, AiTool, AiToolExecution } from "./types";
import {
  diffElementSnapshots,
  getPerceptionSnapshot,
  setPerceptionSnapshot,
  type ElementDiff,
} from "./perception";

// ================= 画布感知（非多模态：把画布转成 JSON 给模型看） =================

const MAX_DESCRIBE = 300;

/** 元素类型的中文标签（画布摘要用） */
const TYPE_LABELS: Record<string, string> = {
  rect: "矩形",
  ellipse: "椭圆",
  line: "直线",
  arrow: "箭头",
  path: "路径",
  freehand: "手绘笔迹",
  text: "文字",
  image: "图片",
  frame: "框架",
};

/** rough 手绘元素的原几何类型中文映射 */
const ROUGH_ORIGINALS: Record<string, string> = {
  rect: "矩形",
  ellipse: "椭圆",
  line: "直线",
  arrow: "箭头",
  path: "路径",
};

/**
 * 解析 SVG path 的命令结构，输出形状描述（代替原始路径字符串，token 开销小）。
 * 模型据此可判断三角形/多边形/曲线类形状；手绘笔迹开放且首尾接近时提示间距辅助推断。
 */
function describePath(path: string, w: number, h: number): string {
  const letters = path.match(/[MLHVQCSTAZ]/gi) ?? [];
  const counts: Record<string, number> = {};
  for (const ch of letters) {
    const c = ch.toLowerCase();
    counts[c] = (counts[c] ?? 0) + 1;
  }
  const lines = (counts.l ?? 0) + (counts.h ?? 0) + (counts.v ?? 0);
  const curves =
    (counts.q ?? 0) + (counts.c ?? 0) + (counts.s ?? 0) + (counts.t ?? 0) + (counts.a ?? 0);
  // 无 Z 时按首尾距离判断近似闭合（容差 = 尺寸 5%，最小 6px）；H/V 结尾无法取终点则跳过
  let gap = -1;
  const lastCmd = letters[letters.length - 1]?.toLowerCase() ?? "";
  if (/[lqctsa]/.test(lastCmd)) {
    const nums = (path.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
    if (nums.length >= 4) {
      gap = Math.hypot(nums[nums.length - 2] - nums[0], nums[nums.length - 1] - nums[1]);
    }
  }
  const closed = (counts.z ?? 0) > 0 || (gap >= 0 && gap < Math.max(6, Math.max(w, h) * 0.05));

  if (closed) {
    if (curves === 0) {
      // 边数 = 顶点数 = M 起点 + L/H/V 命令数；Z 从终点闭合回起点构成最后一条边
      const edges = lines + 1;
      if (edges === 3) return "闭合三角形（3 条直线边）";
      if (edges === 4) return "闭合四边形（4 条直线边）";
      if (edges === 5) return "闭合五边形（5 条直线边，可能是星形）";
      return `闭合多边形（${edges} 条直线边）`;
    }
    if (lines === 0) {
      return `曲线闭合形状（${curves} 段曲线，疑似圆形/椭圆类）`;
    }
    return `闭合路径（直线 ${lines} 段 + 曲线 ${curves} 段，如圆角矩形类）`;
  }
  if (curves === 0) {
    return `开放折线（${lines} 段直线）`;
  }
  if (lines === 0) {
    return gap >= 0
      ? `开放曲线路径（${curves} 段曲线，首尾相距约 ${Math.round(gap)}px）`
      : `开放曲线路径（${curves} 段曲线）`;
  }
  return `开放路径（直线 ${lines} 段 + 曲线 ${curves} 段）`;
}

/** 世界坐标矩形区域（与元素 x/y 同基准；get_canvas 的 bounds/viewport 过滤用） */
export type CanvasRegion = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** 元素 AABB 是否与区域相交 */
function inRegion(
  b: { minX: number; minY: number; maxX: number; maxY: number },
  r: CanvasRegion,
): boolean {
  return b.minX <= r.maxX && b.maxX >= r.minX && b.minY <= r.maxY && b.maxY >= r.minY;
}

/** 九宫格区域名（固定展示顺序：行优先，左上 → 右下） */
const REGION_ORDER = [
  "左上",
  "上中",
  "右上",
  "左中",
  "中心",
  "右中",
  "左下",
  "下中",
  "右下",
] as const;

/**
 * 元素中心 → 3×3 语义区域（左/中/右 × 上/中/下，按内容包围盒均分）：
 * 把原始坐标抽象成“左上/中心/右下”等人类可读空间词汇，降低模型心算坐标差的负担；
 * 包围盒退化为点（单元素/单行）时自动归入“中心”。
 */
function regionOf(
  el: ElementData,
  box: { minX: number; minY: number; maxX: number; maxY: number },
): string {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const cx = el.x + (el.width ?? 0) / 2;
  const cy = el.y + (el.height ?? 0) / 2;
  const col = cx < box.minX + w / 3 ? 0 : cx > box.maxX - w / 3 ? 2 : 1;
  const row = cy < box.minY + h / 3 ? 0 : cy > box.maxY - h / 3 ? 2 : 1;
  return REGION_ORDER[row * 3 + col];
}

/**
 * 被省略元素的空间分布（400px 网格，每格统计类型数量）：
 * 全画布超过 MAX_DESCRIBE 截断时追加，让模型知道被省略的部分"在哪、是什么"，
 * 从而用 ids/region 参数定向补齐。网格超过 24 格时放弃（摘要过长无意义）。
 */
function gridIndex(elements: ElementData[]): string {
  const CELL = 400;
  const bounds = elements.map(elementBounds);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bounds) {
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  if (!Number.isFinite(minX)) {
    return "";
  }
  const cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
  const rows = Math.max(1, Math.ceil((maxY - minY) / CELL));
  if (cols * rows > 24) {
    return "";
  }
  const grid = new Map<number, Map<string, number>>();
  for (let i = 0; i < elements.length; i++) {
    const b = bounds[i];
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const col = Math.min(cols - 1, Math.floor((cx - minX) / CELL));
    const row = Math.min(rows - 1, Math.floor((cy - minY) / CELL));
    const cell = grid.get(row * cols + col) ?? new Map<string, number>();
    cell.set(elements[i].type, (cell.get(elements[i].type) ?? 0) + 1);
    grid.set(row * cols + col, cell);
  }
  const parts: string[] = [];
  for (const [key, cell] of [...grid.entries()].sort((a, b) => a[0] - b[0])) {
    const col = key % cols;
    const row = Math.floor(key / cols);
    const x0 = Math.round(minX + col * CELL);
    const y0 = Math.round(minY + row * CELL);
    const desc = [...cell.entries()].map(([t, n]) => `${TYPE_LABELS[t] ?? t}${n}`).join("、");
    parts.push(`[x${x0},y${y0}]区：${desc}`);
  }
  return `被省略元素的分布（每格 ${CELL}px，格角坐标为区域最小值）：${parts.join("；")}。`;
}

/**
 * 把元素列表压缩为紧凑条目（describeCanvas 与增量感知的变更集输出共用）：
 * - 按 (y, x) 排序，让模型按空间顺序读取元素而非 z 序；
 * - 内容包围盒（与摘要「内容范围」同基准）驱动 region 标签；
 * - 数量 ≤120 时为 text 元素附最近图形元素的方位距离（near 字段）。
 * 返回排序后的元素数组、内容包围盒与一一对应的紧凑条目。
 */
function buildCompactEntries(input: ElementData[]): {
  els: ElementData[];
  box: { minX: number; minY: number; maxX: number; maxY: number } | null;
  entries: Record<string, unknown>[];
} {
  // 按 (y, x) 排序，让模型按空间顺序读取元素而非 z 序
  const els = [...input].sort((a, b) => a.y - b.y || a.x - b.x);
  // 内容包围盒（与摘要“内容范围”同基准）：region 标签与空间分布摘要共用
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  if (els.length) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const e of els) {
      minX = Math.min(minX, e.x);
      maxX = Math.max(maxX, e.x + (e.width ?? 0));
      minY = Math.min(minY, e.y);
      maxY = Math.max(maxY, e.y + (e.height ?? 0));
    }
    box = { minX, minY, maxX, maxY };
  }
  // 相对位置摘要（text 找最近图形元素）：数量适中时才生成，避免文本过长与 O(n²) 开销
  const withNear = els.length <= 120;
  const centers = new Map(
    els.map((e) => [e, { x: e.x + (e.width ?? 0) / 2, y: e.y + (e.height ?? 0) / 2 }]),
  );
  const nearestAnchor = (el: ElementData): string | null => {
    if (!withNear) {
      return null;
    }
    const c = centers.get(el);
    if (!c) {
      return null;
    }
    let best: { d: number; dir: string; label: string } | null = null;
    for (const other of els) {
      if (other === el || other.type === "text") {
        continue;
      }
      const o = centers.get(other);
      if (!o) {
        continue;
      }
      const dx = o.x - c.x;
      const dy = o.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d > 500 || (best && d >= best.d)) {
        continue;
      }
      const dir =
        Math.abs(dx) > Math.abs(dy) * 1.5
          ? dx > 0
            ? "右侧"
            : "左侧"
          : Math.abs(dy) > Math.abs(dx) * 1.5
            ? dy > 0
              ? "下方"
              : "上方"
            : dx > 0
              ? dy > 0
                ? "右下方"
                : "右上方"
              : dy > 0
                ? "左下方"
                : "左上方";
      best = {
        d,
        dir,
        label: `${TYPE_LABELS[other.type] ?? other.type}(${other.id ?? "?"})`,
      };
    }
    return best ? `${best.label} ${best.dir} ${Math.round(best.d)}px` : null;
  };
  const entries = els.map((el) => {
    const d: Record<string, unknown> = {
      id: el.id,
      type: el.type,
      x: round1(el.x),
      y: round1(el.y),
    };
    if (typeof el.width === "number") d.w = round1(el.width);
    if (typeof el.height === "number") d.h = round1(el.height);
    if (typeof el.rotation === "number") d.rotation = round1(el.rotation);
    if (el.stroke) d.stroke = el.stroke;
    if (typeof el.strokeWidth === "number") d.strokeWidth = el.strokeWidth;
    if (el.fill && el.fill !== "none") d.fill = el.fill;
    if (el.text != null) d.text = el.text;
    if (typeof el.fontSize === "number") d.fontSize = el.fontSize;
    // 框架名称：模型可按名引用框架（导入内容框带标题名）
    if (el.type === "frame" && typeof el.name === "string" && el.name.trim()) {
      d.name = el.name;
    }
    if (el.type === "path" && el.path) {
      // rough 手绘风格元素：直接用原几何类型描述（C 命令密集，路径段数无意义）
      d.path = el.rough?.original
        ? `手绘风格的${ROUGH_ORIGINALS[el.rough.original] ?? el.rough.original}（rough seed=${el.rough.seed}）`
        : describePath(el.path, el.width ?? 0, el.height ?? 0);
    }
    if (el.type === "freehand") {
      const shape = describeFreehandShape(el);
      d.path = shape
        ? `${shape}（${(el.penPoints ?? []).length} 个采样点）`
        : `手绘笔迹（${(el.penPoints ?? []).length} 个采样点）`;
    }
    if ((el.type === "line" || el.type === "arrow") && el.points) {
      // 输出画布绝对坐标（含 rotation 换算），模型写回时按同一基准自动换算
      d.points = el.points.map((p) => {
        const abs = localToCanvas(el, p);
        return { x: round1(abs.x), y: round1(abs.y) };
      });
    }
    if (el.type === "image") {
      d.image = `图片 ${round1(el.width ?? 0)}x${round1(el.height ?? 0)}`;
    }
    if (el.type === "text") {
      // 空间关系速查：最近图形元素的方位与距离，省去模型心算坐标差
      const near = nearestAnchor(el);
      if (near) d.near = near;
    }
    if (el.bindStart || el.bindEnd) {
      d.boundTo = [el.bindStart, el.bindEnd].filter(Boolean).join("、");
    }
    if (el.locked) d.locked = true;
    // P3 样式扩展字段：不透明度/虚线/圆角（与 update_elements 白名单一致）
    if (typeof el.opacity === "number") d.opacity = el.opacity;
    if (el.strokeDash) d.strokeDash = el.strokeDash;
    if (typeof el.cornerRadius === "number") d.cornerRadius = el.cornerRadius;
    // 组标注：同组成员在排列/层序/删除操作中整组联动（AI 不可写 groupId）
    if (el.groupId) d.groupId = el.groupId;
    // 意图：AI 创建时自报（为何创建此元素）；历史/用户元素无此字段
    if (el.intent) d.intent = el.intent;
    // 区域标签：元素中心在内容包围盒 3×3 均分中的位置，省去模型心算坐标差
    if (box) d.region = regionOf(el, box);
    return d;
  });
  return { els, box, entries };
}

/**
 * 把画布序列化为紧凑 JSON 描述，供 LLM 理解内容：
 * - path 只保留路径段数（原始 SVG 路径 token 太大），手绘笔迹给出识别形状
 * - image 不包含 dataURL 本体，只保留尺寸
 * - line/arrow 的 points 输出画布绝对坐标（写回时系统自动换算回局部坐标）
 * - 元素过多时截断（最多 MAX_DESCRIBE 个，截断部分附带空间网格索引）；
 *   显式传 ids（@选区）或 region（bounds/viewport 过滤）时不截断
 * - 返回内容前附带整体摘要：元素统计、内容范围、空间分布（九宫格区域计数）、
 *   坐标系说明、region 字段语义、当前视口（位置与缩放）、背景色
 * - 每个元素附 region 字段：中心在内容包围盒 3×3 均分中的位置（如“左上/中心/右下”），
 *   把原始坐标抽象为空间词汇，降低模型心算坐标差的负担（借鉴手绘代理的空间上下文做法）
 */
export function describeCanvas(board: Board, ids?: string[], region?: CanvasRegion | null): string {
  // 世界坐标序列化：frame 内元素展开为画布绝对坐标，保证坐标/region 计算基准一致
  const full = board.serializeWorld();
  const all = ids?.length
    ? full.filter((e) => e.id && ids.includes(e.id))
    : region
      ? full.filter((e) => inRegion(elementBounds(e), region))
      : full;
  const limited = ids?.length || region ? all : all.slice(0, MAX_DESCRIBE);
  const { els, box, entries: compact } = buildCompactEntries(limited);
  const over = ids?.length || region ? 0 : full.length - MAX_DESCRIBE;
  // 摘要：全画布统计 + 返回集合的内容范围 + 坐标系/视口说明 + 背景色
  const counts = new Map<string, number>();
  for (const e of full) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
  const typeDesc = [...counts.entries()].map(([t, n]) => `${TYPE_LABELS[t] ?? t} ${n}`).join("、");
  let summary = `画布共 ${full.length} 个元素：${typeDesc}。`;
  // 分组信息：列出每组 id 列表（arrange_elements 会按组联动，模型无需自己推算）
  const groups = new Map<string, string[]>();
  for (const e of full) {
    if (e.groupId) {
      const list = groups.get(e.groupId) ?? [];
      list.push(e.id ?? "?");
      groups.set(e.groupId, list);
    }
  }
  if (groups.size) {
    summary += ` 分组：${[...groups.entries()]
      .map(([g, list]) => `组 ${g}（${list.length} 个成员：${list.join("、")}）`)
      .join(
        "；",
      )}。同组元素在排列/层序/删除操作中整组联动，元素数据里的 groupId 仅供识别、不可写入。`;
  }
  if (ids?.length) {
    summary += `（本次返回其中 ${all.length} 个）`;
  } else if (region) {
    summary += `（本次返回区域内 ${all.length} 个）`;
  }
  if (box) {
    summary += ` 内容范围 x ${Math.round(box.minX)}~${Math.round(box.maxX)}，y ${Math.round(box.minY)}~${Math.round(box.maxY)}。`;
    // 空间分布：按区域统计元素数量，让模型一眼看到内容集中在哪、哪里空旷
    const dist = new Map<string, number>();
    for (const e of els) {
      const r = regionOf(e, box);
      dist.set(r, (dist.get(r) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const name of REGION_ORDER) {
      const n = dist.get(name);
      if (n) {
        parts.push(`${name} ${n} 个`);
      }
    }
    if (parts.length) {
      summary += ` 空间分布：${parts.join("、")}。`;
    }
  }
  summary += ` 背景色 ${board.backgroundColor}。`;
  // 坐标系说明：防止模型把 y 轴方向理解反，导致布局建议上下颠倒
  summary += ` 坐标系：左上角为原点 (0,0)，y 轴向下，单位 px。`;
  // region 语义说明：元素数据里的 region 字段基于内容包围盒九宫格划分
  if (box) {
    summary += ` 每个元素的 region 字段表示其中心在内容包围盒 3×3 均分中的位置（左上/上中/右上/左中/中心/右中/左下/下中/右下）。`;
  }
  // intent 语义说明：仅当本次返回里有 AI 自报意图的元素时给出，防止模型把意图当推断
  if (els.some((e) => e.intent)) {
    summary += ` 部分元素带 intent 字段：AI 创建时自报的创建意图（为何创建此元素），可据此理解其用途；不带 intent 的元素没有该信息，不要猜测其用途。`;
  }
  // 视口信息：模型据此知道使用者当前看到哪里（含缩放），回答"屏幕/眼前/视口"相关内容时以此为准
  const vp = board.viewport;
  summary += ` 当前视口：中心 (${Math.round(vp.center.x)}, ${Math.round(vp.center.y)})，可见范围 x ${Math.round(vp.minX)}~${Math.round(vp.maxX)}，y ${Math.round(vp.minY)}~${Math.round(vp.maxY)}，缩放 ${Math.round(vp.scale * 100)}%。`;
  if (els.length === 0) {
    return ids?.length
      ? `${summary}（未找到这些 id 的元素）`
      : region
        ? `${summary}（该区域内没有元素）`
        : `${summary}（画布是空的）`;
  }
  let tail = `\n${JSON.stringify(compact)}`;
  if (over > 0) {
    tail += `\n（另有 ${over} 个元素已省略：${gridIndex(full.slice(MAX_DESCRIBE))}）`;
  }
  return summary + tail;
}

// ================= 增量感知输出（ai/perception.ts 的缓存与 diff 之上） =================

/** 类型统计文案（全量摘要与无变化/增量回执共用） */
function typeCountsText(data: ElementData[]): string {
  const counts = new Map<string, number>();
  for (const e of data) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([t, n]) => `${TYPE_LABELS[t] ?? t} ${n}`).join("、");
}

/**
 * 「无变化」简短回执：内容版本未推进时替代全量 JSON。
 * 视口实时读取——用户平移/缩放不计入内容版本，但模型需要最新视口。
 */
function describeNoChange(board: Board, snapshot: ElementData[]): string {
  const vp = board.viewport;
  return `画布自上次获取以来没有任何变化（仍为 ${snapshot.length} 个元素：${typeCountsText(snapshot)}），此前返回的元素数据继续有效，请勿重复请求。当前视口：中心 (${Math.round(vp.center.x)}, ${Math.round(vp.center.y)})，缩放 ${Math.round(vp.scale * 100)}%。`;
}

/**
 * 版本推进时的增量变更集输出；变更面超过 MAX_DESCRIBE 时返回 null，
 * 由调用方退回完整快照（此时逐条列出反而更长且信息密度更低）。
 */
function describePerceptionDiff(board: Board, next: ElementData[], diff: ElementDiff): string | null {
  const total = diff.added.length + diff.updated.length;
  if (total > MAX_DESCRIBE) {
    return null;
  }
  let summary = `画布现共 ${next.length} 个元素：${typeCountsText(next)}。`;
  const parts: string[] = [];
  if (diff.added.length) {
    parts.push(`新增 ${diff.added.length} 个`);
  }
  if (diff.updated.length) {
    parts.push(`更新 ${diff.updated.length} 个`);
  }
  if (diff.removedIds.length) {
    parts.push(`删除 ${diff.removedIds.length} 个`);
  }
  summary += ` 相对上次获取：${parts.join("、")}。`;
  const vp = board.viewport;
  summary += ` 当前视口：中心 (${Math.round(vp.center.x)}, ${Math.round(vp.center.y)})，缩放 ${Math.round(vp.scale * 100)}%。`;
  summary += ` 坐标系：左上角为原点 (0,0)，y 轴向下，单位 px。`;

  const sections: string[] = [];
  // 新增条目带 change 标记（新增 / 更新），数据字段与完整快照一致
  if (diff.added.length) {
    const entries = buildCompactEntries(diff.added).entries;
    sections.push(
      `【新增 ${diff.added.length} 个】\n${JSON.stringify(entries.map((e) => ({ ...e, change: "added" })))}`,
    );
  }
  if (diff.updated.length) {
    const entries = buildCompactEntries(diff.updated).entries;
    sections.push(
      `【更新 ${diff.updated.length} 个】\n${JSON.stringify(entries.map((e) => ({ ...e, change: "updated" })))}`,
    );
  }
  if (diff.removedIds.length) {
    sections.push(`【删除 ${diff.removedIds.length} 个】\n${diff.removedIds.join("、")}`);
  }
  summary += `\n${sections.join("\n")}`;
  summary += `\n（未变更元素不再重复返回，此前返回的数据继续有效；如需完整快照传 full:true，或用 ids/bounds/viewport 定向获取）`;
  return summary;
}

// ================= 官方 leafer JSON 解析（create_elements 用） =================
// 对应数据契约格式 A（D:\CanvasCompanion\data-contract.md），将来随内核迁移至 core/leafer-adapter.ts。
// 规则：白名单字段、无 id（系统分配）、禁止 fill:"none"（leafer 渲染黑色实心）、
// points 传画布绝对坐标（自动换算回局部坐标）。

const LEAFFER_TYPES = ["rect", "ellipse", "line", "arrow", "path", "text", "image"] as const;

function numOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** 解析单个官方格式元素为 ElementData（非法返回错误原因，不抛异常） */
function parseLeaferElement(obj: Record<string, unknown>): { data?: ElementData; error?: string } {
  const type = strOf(obj.type);
  if (!type || !(LEAFFER_TYPES as readonly string[]).includes(type)) {
    return { error: `type 必须是 ${LEAFFER_TYPES.join("/")} 之一` };
  }
  const x = numOf(obj.x);
  const y = numOf(obj.y);
  if (x === undefined || y === undefined) {
    return { error: "缺少 x/y 坐标" };
  }
  const rotation = numOf(obj.rotation);
  const stroke = strOf(obj.stroke);
  const strokeWidth = numOf(obj.strokeWidth);
  // leafer 中 "none" 会渲染成黑色实心：无填充时省略字段
  const fill = obj.fill === "none" ? undefined : strOf(obj.fill);
  // AI 自报的创建意图：可选，透传到 ElementData 持久化（describeCanvas 输出供后续轮次理解）
  const intent = strOf(obj.intent);

  if (type === "line" || type === "arrow") {
    const raw = Array.isArray(obj.points) ? obj.points : [];
    const pts = raw
      .filter(
        (p): p is { x: number; y: number } =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as { x?: unknown }).x === "number" &&
          typeof (p as { y?: unknown }).y === "number",
      )
      .map((p) => ({ x: p.x, y: p.y }));
    if (pts.length < 2) {
      return { error: "line/arrow 需要至少 2 个 points 点" };
    }
    // points 为画布绝对坐标：元素定位到包围盒左上角，再换算回局部坐标
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const box = {
      x: minX,
      y: minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY,
      rotation,
    };
    const endArrow = strOf(obj.endArrow);
    const data: ElementData = {
      type: type === "arrow" || (endArrow !== undefined && endArrow !== "none") ? "arrow" : "line",
      x: minX,
      y: minY,
      width: box.width,
      height: box.height,
      points: pts.map((p) => canvasToLocal(box, p)),
    };
    if (rotation !== undefined) {
      data.rotation = rotation;
    }
    if (stroke !== undefined) {
      data.stroke = stroke;
    }
    if (strokeWidth !== undefined) {
      data.strokeWidth = strokeWidth;
    }
    if (intent !== undefined) {
      data.intent = intent;
    }
    return { data };
  }

  const data: ElementData = { type: type as ElementData["type"], x, y, width: 0, height: 0 };
  if (rotation !== undefined) {
    data.rotation = rotation;
  }
  if (stroke !== undefined) {
    data.stroke = stroke;
  }
  if (strokeWidth !== undefined) {
    data.strokeWidth = strokeWidth;
  }
  if (fill !== undefined) {
    data.fill = fill;
  }
  if (intent !== undefined) {
    data.intent = intent;
  }
  switch (type) {
    case "rect":
    case "ellipse":
      data.width = numOf(obj.width) ?? 100;
      data.height = numOf(obj.height) ?? 100;
      break;
    case "path": {
      const path = strOf(obj.path);
      if (path === undefined) {
        return { error: "path 元素需要 path 字符串（相对元素左上角的局部坐标）" };
      }
      data.path = path;
      data.width = numOf(obj.width) ?? 100;
      data.height = numOf(obj.height) ?? 100;
      break;
    }
    case "text": {
      const text = strOf(obj.text);
      if (text === undefined) {
        return { error: "text 元素需要 text 字符串" };
      }
      data.text = text;
      data.fontSize = numOf(obj.fontSize) ?? TEXT_FONT_SIZE;
      break;
    }
    case "image": {
      const url = strOf(obj.url);
      if (url === undefined) {
        return { error: "image 元素需要 url" };
      }
      data.url = url;
      data.width = numOf(obj.width) ?? 200;
      data.height = numOf(obj.height) ?? 150;
      break;
    }
  }
  return { data };
}

/** 解析官方 leafer JSON 数组（create_elements 入参），逐元素报告成败 */
export function parseLeaferJSON(raw: unknown): { data?: ElementData; error?: string }[] {
  if (!Array.isArray(raw)) {
    return [{ error: "elements 必须是数组" }];
  }
  return raw.map((item) => {
    if (typeof item !== "object" || item === null) {
      return { error: "元素必须是对象" };
    }
    return parseLeaferElement(item as Record<string, unknown>);
  });
}

// ================= 工具定义 =================

/** 画布感知工具：交流/编辑模式共用（只读，不修改画布） */
function getCanvasTool(): AiTool {
  return {
    name: "get_canvas",
    description:
      "获取画布元素的结构化 JSON 数据（坐标、颜色、文字内容、形状描述等），用于理解画布上有什么；可传 ids 只看指定元素（如用户 @ 的选区），或传 viewport/bounds 只看某个世界坐标区域（如当前视口）内的元素。返回内容附带整体摘要：元素数量与类型统计、内容范围、空间分布（元素集中在哪个区域、哪里空旷）、当前视口范围与缩放、坐标系说明、背景色；每个元素带 region 字段（中心在内容包围盒九宫格中的位置）与形状描述，AI 创建的元素带 intent 字段（创建时自报的意图）；line/arrow 的 points 为画布绝对坐标。增量感知：全量调用时若画布自上次获取后没有变化，只返回简短的「无变化」摘要；有变化时默认只返回增量变更集（新增 / 更新元素的完整数据 + 删除元素的 id 清单），未变更元素不再重复返回，需要完整快照时传 full:true。请勿在画布未修改时反复调用（浪费轮次与 token），需要细化时用 ids/bounds/viewport 参数定向获取",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "可选：元素 id 列表，只返回这些元素的数据；不传则返回全部",
        },
        full: {
          type: "boolean",
          description:
            "可选：true 时跳过增量感知，强制返回完整快照（默认有变化时只返回增量变更集）",
        },
        viewport: {
          type: "boolean",
          description:
            "可选：true 时只返回当前视口（使用者当前看到的区域）内的元素；与 bounds 同时传时以 viewport 为准",
        },
        bounds: {
          type: "object",
          description:
            "可选：只返回位于该世界坐标矩形区域内的元素（元素与区域相交即返回；坐标系与元素坐标、摘要中的视口范围同基准：左上角原点、y 轴向下、单位 px）",
          properties: {
            minX: { type: "number", description: "区域左边界（世界坐标）" },
            minY: { type: "number", description: "区域上边界（世界坐标）" },
            maxX: { type: "number", description: "区域右边界（世界坐标）" },
            maxY: { type: "number", description: "区域下边界（世界坐标）" },
          },
        },
      },
    },
  };
}

/** 读图工具：按 id 读取画布图片的实际内容（压缩 dataURL，视觉模型可看图） */
function readImageTool(): AiTool {
  return {
    name: "read_image",
    description:
      "读取画布中一张图片的实际内容（返回压缩后的图片数据，视觉模型可直接看到图里的内容，如照片、截图、标志等）。get_canvas 对图片只返回尺寸、看不到内容；当你需要评价、识别或针对图片内容给出建议时调用。参数 id 为图片元素的稳定 id（来自 get_canvas 或 @选区）；一次只读一张，多张请多次调用；返回的图片已压缩，分辨率可能低于原图",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "图片元素的稳定 id" },
      },
      required: ["id"],
    },
  };
}

/** 交流模式：理解画布 + 可视化流程 */
function chatTools(): AiTool[] {
  return [
    getCanvasTool(),
    readImageTool(),
    {
      name: "draw_flowchart",
      description:
        "把用户的想法、计划或流程表达成流程图并写入主画布：给出节点（含文字）与节点间的连线关系，前端自动排版为从上到下的流程图",
      parameters: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "节点短标识，如 n1、n2" },
                label: {
                  type: "string",
                  description: "节点上显示的文字，尽量简短（10 字内）",
                },
              },
              required: ["id", "label"],
            },
            description: "流程图节点列表",
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string", description: "起点节点 id" },
                to: { type: "string", description: "终点节点 id" },
              },
              required: ["from", "to"],
            },
            description: "节点连线关系",
          },
        },
        required: ["nodes"],
      },
      mutating: true,
    },
    {
      name: "update_elements",
      description:
        "优化/修改画布元素：按 id 更新元素属性（stroke 描边色、fill 填充色、strokeWidth 粗细、x/y/width/height 位置尺寸、rotation 旋转、text 文字内容、fontSize 字号，line/arrow 可改 points 端点，path 可改 path）。points 请传画布绝对坐标（与 get_canvas/@选区数据一致，系统自动换算回元素坐标）；path 使用相对元素左上角 (x,y) 的局部坐标，否则会错位。只应修改用户 @ 选中或明确指定的元素；整轮改动会合并为一步撤销",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "元素 id（来自 get_canvas 或 @ 选区数据）" },
                patch: {
                  type: "object",
                  description: "要更新的属性；fill 不要传字符串 none（会渲染成黑色实心）",
                  additionalProperties: true,
                },
              },
              required: ["id", "patch"],
            },
            description: "要更新的元素及其属性",
          },
        },
        required: ["updates"],
      },
      mutating: true,
    },
    {
      name: "arrange_elements",
      description:
        "批量排列画布元素（对齐/分布/翻转/层序）：一次调用对多个元素做几何整理，坐标计算由前端完成，不要自己心算坐标。动作：align-left/align-centerX/align-right/align-top/align-centerY/align-bottom 为对齐（以目标集合整体包围盒为基准，对齐需至少 2 个元素）；distribute-h/distribute-v 为均匀分布（需至少 3 个元素）；flip-h/flip-v 为翻转（绕集合中心镜像，单元素也可）；front/back/forward/backward 为层序（置顶/置底/上移/下移一层）。ids 为元素 id 列表（来自 get_canvas 或 @选区）；锁定元素自动跳过；同组成员整组参与（只传组内一个 id 即可）；目标不足或已在目标位置时自动跳过（无效果）。与 update_elements 的分工：改属性（颜色/文字/坐标等）用 update_elements，批量几何整理用 arrange_elements",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要操作的元素 id 列表（对齐需 ≥2、分布需 ≥3 才有实际效果）",
          },
          action: {
            type: "string",
            enum: [
              "align-left",
              "align-centerX",
              "align-right",
              "align-top",
              "align-centerY",
              "align-bottom",
              "distribute-h",
              "distribute-v",
              "flip-h",
              "flip-v",
              "front",
              "back",
              "forward",
              "backward",
            ],
            description: "要执行的动作",
          },
        },
        required: ["ids", "action"],
      },
      mutating: true,
    },
    {
      name: "delete_elements",
      description:
        "按 id 删除画布元素：ids 为元素 id 列表（来自 get_canvas 或 @选区）；仅在使用者明确要求删除时调用；锁定元素自动跳过；同组成员整组参与（只传组内一个 id 即可）。适合「删掉/去掉/移除这些元素」类请求",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要删除的元素 id 列表",
          },
        },
        required: ["ids"],
      },
      mutating: true,
    },
    {
      name: "beautify_elements",
      description:
        "把手绘笔迹整理为标准图形（beautify）：闭合笔迹识别为圆/椭圆/矩形/三角形/多边形等标准元素，近似直线转为标准线段，其余弯曲线条拉直简化；保留颜色与粗细。只整理 ids 指定的元素，其他元素原样不动；ids 为元素 id 列表（来自 get_canvas 或 @选区）；锁定元素自动跳过；同组成员整组参与（只传组内一个 id 即可）；没有手绘笔迹的目标会自动跳过（返回未执行时不要重复提交相同调用）。适合“整理/识别/清理这些手绘图形”类请求",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要整理的元素 id 列表（手绘笔迹 freehand 才有效果）",
          },
        },
        required: ["ids"],
      },
      mutating: true,
    },
    {
      name: "sketchify_elements",
      description:
        "把标准图形转为 rough 手绘风格（矩形/椭圆/直线/箭头/标准多边形）：双线+抖动描边，抖动 seed 随元素保存（撤销/重载后形态可复现）；已手绘元素自动跳过。ids 为元素 id 列表（来自 get_canvas 或 @选区）；锁定元素自动跳过；同组成员整组参与；无可转换目标时自动跳过（返回未执行时不要重复提交相同调用）。适合“把这些图形变成手绘风格”类请求",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要手绘化的元素 id 列表（标准图形才有有效果）",
          },
        },
        required: ["ids"],
      },
      mutating: true,
    },
    {
      name: "set_roughness",
      description:
        "调整已手绘元素的粗糙度（0~2，步进 0.1；0 = 接近规整，2 = 抖动最强）：以同一抖动 seed 即时重绘，抖动态不变仅幅度变化。ids 为元素 id 列表；无手绘元数据的元素自动跳过；锁定元素自动跳过；同组成员整组参与。适合“更粗糙一点/更规整一点”类请求",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要调整粗糙度的元素 id 列表（已手绘元素才有效果）",
          },
          value: {
            type: "number",
            description: "粗糙度 0~2（0.1 步进）",
          },
        },
        required: ["ids", "value"],
      },
      mutating: true,
    },
    {
      name: "create_elements",
      description:
        '用 leafer 官方 JSON 格式在画布上创建元素（rect/ellipse/line/arrow/path/text/image），返回创建的 id。字段规则：x/y 必填；rect/ellipse 可省略 width/height（默认 100）；text 需要 text 字符串（可选 fontSize）；path 需要 path 字符串（相对元素左上角的局部坐标）；image 需要 url；可选 stroke/strokeWidth/fill/rotation；可选 intent（简短中文自报创建意图，如"流程起点"、"标题"——系统会保存并在 get_canvas 返回，供后续轮次理解你的设计意图）。禁止 fill 传字符串 "none"（会渲染成黑色实心），无填充时省略 fill。line/arrow 的 points 传画布绝对坐标（至少 2 个点，系统自动换算）。不需要传 id（系统分配）。一次创建多个元素时请自行规划好坐标避免重叠',
      parameters: {
        type: "object",
        properties: {
          elements: {
            type: "array",
            items: {
              type: "object",
              description: "一个 leafer 官方格式元素（type/x/y 必填）",
              additionalProperties: true,
            },
            description: "要创建的元素数组",
          },
        },
        required: ["elements"],
      },
      mutating: true,
    },
  ];
}

/** 编辑模式：画布感知（只读）+ 按统一功能规则管理功能区（自定义工具增删改查） */
function editTools(): AiTool[] {
  return [
    getCanvasTool(),
    readImageTool(),
    {
      name: "list_tools",
      description:
        "查看功能区绘制工具（内置 + AI 生成的）的 id、名称、图标、快捷键、类型。可选 id 过滤单个工具；includeSource=true 或按 id 过滤时附带自定义工具的 generator 源码——修改工具前必须先取源码做增量修改，不要凭记忆重写",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "可选：只查这一个工具（自动附带其 generator 源码）" },
          includeSource: {
            type: "boolean",
            description: "可选：true 时为所有自定义工具附带 generator 源码",
          },
        },
      },
    },
    {
      name: "add_tool",
      description:
        "按统一功能规则添加一个新绘制工具：提供名称、图标、可选快捷键、行为类别与生成器代码（生成器接收拖拽上下文 ctx 返回元素数据或元素数据数组，详见系统提示中的规则与示例）。添加前系统会验证生成器（危险代码/超时/返回值格式），未通过会返回具体原因，请修正后重试；通过后会自动在画布右侧试画示例供查看。id 由系统自动分配",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "工具名称，如 五角星" },
          icon: { type: "string", description: "按钮图标，一个字符或短符号，如 ★" },
          shortcut: {
            type: "string",
            description: "可选单字母快捷键（不能与现有工具冲突）",
          },
          kind: {
            type: "string",
            enum: ["drag", "click"],
            description:
              "行为类别：drag 拖拽生成（默认，根据拖拽范围动态计算形状）；click 点击即生成固定大小元素（如印章、便利贴）",
          },
          group: {
            type: "string",
            enum: ["shape"],
            description:
              '可选：工具分组。与已有同类型工具归入同一分组：形状类工具（拖拽生成闭合形状，如三角形/五角星/多边形/圆角矩形等）必须传 "shape" 归入“形状▾”下拉；其他类型省略',
          },
          generator: {
            type: "string",
            description:
              "生成器函数体源码：(ctx) => ElementData 或 ElementData[]（组合工具），ctx={x0,y0,x1,y1,style}",
          },
          description: { type: "string", description: "工具用途说明" },
        },
        required: ["name", "icon", "generator"],
      },
      mutating: true,
    },
    {
      name: "update_tool",
      description:
        "修改已存在的自定义工具（名称/图标/快捷键/生成器/说明/分组/行为类别）；内置工具只读不可修改。修改生成器时同样会验证（危险代码/超时/返回值格式），未通过不会生效",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "要修改的工具 id" },
          patch: {
            type: "object",
            properties: {
              name: { type: "string" },
              icon: { type: "string" },
              shortcut: { type: "string" },
              kind: { type: "string", enum: ["drag", "click"] },
              group: { type: "string", enum: ["shape"] },
              generator: { type: "string" },
              description: { type: "string" },
            },
            description: "要修改的字段",
          },
        },
        required: ["id", "patch"],
      },
      mutating: true,
    },
    {
      name: "remove_tool",
      description: "删除一个 AI 生成的自定义工具；内置工具不可删除",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "要删除的工具 id" },
        },
        required: ["id"],
      },
      mutating: true,
    },
  ];
}

export function toolsForMode(mode: AiMode): AiTool[] {
  return mode === "edit" ? editTools() : chatTools();
}

/** OpenAI 兼容 tools 请求体格式 */
export function toOpenAiTools(tools: AiTool[]) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ================= 工具执行器 =================

/** arrange_elements 合法动作（与 arrange.ts 的 ArrangeAction 保持一致，供校验与错误提示） */
const ARRANGE_ACTIONS: ArrangeAction[] = [
  "align-left",
  "align-centerX",
  "align-right",
  "align-top",
  "align-centerY",
  "align-bottom",
  "distribute-h",
  "distribute-v",
  "flip-h",
  "flip-v",
  "front",
  "back",
  "forward",
  "backward",
];

/** arrange_elements 动作的中文标签（结果汇报用） */
const ACTION_LABELS: Record<string, string> = {
  "align-left": "左对齐",
  "align-centerX": "水平居中",
  "align-right": "右对齐",
  "align-top": "顶对齐",
  "align-centerY": "垂直居中",
  "align-bottom": "底对齐",
  "distribute-h": "水平均匀分布",
  "distribute-v": "垂直均匀分布",
  "flip-h": "水平翻转",
  "flip-v": "垂直翻转",
  front: "置于顶层",
  back: "置于底层",
  forward: "上移一层",
  backward: "下移一层",
};

/** read_image 工具返回图片的最长边（px）：压缩控制 token 与网络流量 */
const IMAGE_READ_MAX_SIDE = 1024;

/**
 * 把图片 url（dataURL 或允许跨域的远程 url）等比压缩为 JPEG dataURL，
 * 供视觉模型读图：原图 dataURL 体积大，直接发送浪费 token/流量；失败返回 null。
 */
export async function compressImageDataURL(url: string, maxSide: number): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export type AiToolContext = {
  board: Board;
  registry: ToolRegistry;
  /** 注册表变化后刷新工具栏按钮 */
  toolbar?: Toolbar;
  mode: AiMode;
};

const NODE_W = 180;
const NODE_H = 60;
const H_GAP = 60;
const V_GAP = 90;

/** 把想法画成流程图：分层布局 + 矩形节点 + 文字 + 箭头，写入主画布空白区 */
function drawFlowchart(board: Board, args: Record<string, unknown>): string {
  const nodes = Array.isArray(args.nodes) ? (args.nodes as { id?: string; label?: string }[]) : [];
  if (!nodes.length) {
    return "错误：nodes 不能为空";
  }
  const edges = Array.isArray(args.edges) ? (args.edges as { from?: string; to?: string }[]) : [];
  const validNodes = nodes.filter((n) => typeof n.id === "string" && n.id);
  if (!validNodes.length) {
    return "错误：节点缺少 id";
  }
  const nodeMap = new Map(validNodes.map((n) => [n.id as string, n]));
  // 整张图的组 id 前缀：节点矩形与文字同组（整组联动），与其他流程图互不混淆
  const flowId = Date.now().toString(36);

  // 拓扑分层：level(node) = max(level(from)) + 1
  const level = new Map<string, number>();
  for (const n of validNodes) {
    level.set(n.id as string, 0);
  }
  for (let pass = 0; pass < validNodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      if (!e.from || !e.to || !nodeMap.has(e.from) || !nodeMap.has(e.to)) {
        continue;
      }
      const next = Math.max(level.get(e.to) ?? 0, (level.get(e.from) ?? 0) + 1);
      if (next !== level.get(e.to)) {
        level.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  // 按层分组，每层节点横向排列并水平居中
  const layers = new Map<number, { id: string; label: string }[]>();
  const layerWidths = new Map<number, number>();
  for (const n of validNodes) {
    const l = level.get(n.id as string) ?? 0;
    const list = layers.get(l) ?? [];
    list.push({
      id: n.id as string,
      label: nodeMap.get(n.id as string)?.label ?? "",
    });
    layers.set(l, list);
    layerWidths.set(l, list.length * NODE_W + (list.length - 1) * H_GAP);
  }
  const maxLayerWidth = Math.max(...[...layerWidths.values()]);

  // 放置起点：画布有内容时放在内容包围盒右下方，否则放在视口中心
  const els = board.serialize();
  let originX = 0;
  let originY = 0;
  if (els.length) {
    const maxX = Math.max(...els.map((e) => e.x + (e.width ?? 0)));
    const maxY = Math.max(...els.map((e) => e.y + (e.height ?? 0)));
    originX = maxX + 80;
    originY = maxY + 80;
  } else {
    const view = board.app.canvas.view as HTMLElement;
    const w = board.app.width ?? view.clientWidth;
    const h = board.app.height ?? view.clientHeight;
    const inner = board.app.tree.getInnerPoint({ x: w / 2, y: h / 2 });
    originX = inner.x - maxLayerWidth / 2;
    originY = inner.y - 120;
  }

  // 生成元素
  const idMap = new Map<string, string>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const [l, list] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const layerWidth = layerWidths.get(l) ?? 0;
    const startX = originX + (maxLayerWidth - layerWidth) / 2;
    list.forEach((n, i) => {
      const x = startX + i * (NODE_W + H_GAP);
      const y = originY + l * (NODE_H + V_GAP);
      positions.set(n.id, { x, y });
      // 节点矩形与文字同组：移动/删除/AI 排列时整组联动
      const groupId = `${flowId}-${n.id}`;
      const elId = board.addElement({
        type: "rect",
        x,
        y,
        width: NODE_W,
        height: NODE_H,
        stroke: "#4f8cff",
        strokeWidth: 2,
        fill: "rgba(79, 140, 255, 0.12)",
        groupId,
      });
      if (elId) {
        idMap.set(n.id, elId);
      }
      if (n.label) {
        board.addElement({
          type: "text",
          x: x + 8,
          y: y + (NODE_H - TEXT_FONT_SIZE) / 2 - 2,
          width: n.label.length * TEXT_FONT_SIZE,
          height: TEXT_FONT_SIZE * 1.4,
          text: n.label,
          fontSize: TEXT_FONT_SIZE,
          fill: "#ffffff",
          groupId,
        });
      }
    });
  }
  for (const e of edges) {
    if (!e.from || !e.to) {
      continue;
    }
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) {
      continue;
    }
    const dx = to.x - from.x;
    // 连线：不同层时从起点底部中心指向终点顶部中心；同层时从侧面水平相连
    const horizontal = level.get(e.to) === level.get(e.from) ? 1 : 0;
    const sx = from.x + NODE_W / 2;
    const sy = from.y + (horizontal ? NODE_H / 2 : NODE_H);
    const tx = to.x + NODE_W / 2 + (horizontal ? (dx > 0 ? -NODE_W / 2 : NODE_W / 2) : 0);
    const ty = to.y + (horizontal ? NODE_H / 2 : 0);
    const fromRect = idMap.get(e.from);
    const toRect = idMap.get(e.to);
    if (!fromRect || !toRect) {
      continue;
    }
    board.addElement({
      type: "arrow",
      x: 0,
      y: 0,
      width: Math.abs(tx - sx),
      height: Math.abs(ty - sy),
      points: [
        { x: sx, y: sy },
        { x: tx, y: ty },
      ],
      stroke: "#4f8cff",
      strokeWidth: 1.5,
      // 端点绑定节点矩形：节点移动时连线自动跟随
      bindStart: fromRect,
      bindEnd: toRect,
    });
  }

  const mapping = [...idMap.entries()].map(([nid, eid]) => `${nid}=${eid}`).join("，");
  return `已生成流程图：${validNodes.length} 个节点、${edges.length} 条连线，起点位于画布 (${Math.round(originX)}, ${Math.round(originY)})。节点 id 映射：${mapping}（后续可用这些 id 引用）`;
}

/**
 * 把冒烟测试得到的示例元素整体平移到画布内容区右下角，创建并返回 id 列表。
 * 生成器的 x/y 基于测试基准 (0,0)，平移后避免与已有内容重叠；供用户立即查看工具效果。
 */
/** 试画示例的锚点与元素记忆：同一工具连续迭代时固定位置，便于前后对比 */
const previewAnchors = new Map<string, { x: number; y: number }>();
const previewElementIds = new Map<string, string[]>();

function previewToolElements(
  board: Board,
  elements: ElementData[],
  key?: string,
): { ids: string[]; x: number; y: number } {
  const remembered = key ? previewAnchors.get(key) : undefined;
  let originX = 0;
  let originY = 0;
  if (remembered) {
    originX = remembered.x;
    originY = remembered.y;
  } else {
    const els = board.serialize();
    if (els.length) {
      const maxX = Math.max(...els.map((e) => e.x + (e.width ?? 0)));
      const maxY = Math.max(...els.map((e) => e.y + (e.height ?? 0)));
      originX = maxX + 120;
      originY = maxY + 120;
    } else {
      // 空画布：放在视口中心附近（与 draw_flowchart 同基准）
      const view = board.app.canvas.view as HTMLElement;
      const w = board.app.width ?? view.clientWidth;
      const h = board.app.height ?? view.clientHeight;
      const inner = board.app.tree.getInnerPoint({ x: w / 2, y: h / 2 });
      originX = inner.x - 100;
      originY = inner.y - 60;
    }
  }
  const ids: string[] = [];
  for (const d of elements) {
    const id = board.addElement({ ...d, x: d.x + originX, y: d.y + originY });
    if (id) {
      ids.push(id);
    }
  }
  if (key && ids.length) {
    previewAnchors.set(key, { x: originX, y: originY });
    previewElementIds.set(key, ids);
  }
  return { ids, x: originX, y: originY };
}

/**
 * 更新工具后的试画：先移除上一版示例（与本轮新增合并为一步撤销），
 * 再在记忆锚点处放置新版示例——「再大一点」类迭代可原地对比。
 */
function refreshToolPreview(
  board: Board,
  key: string,
  elements: ElementData[],
): { ids: string[]; x: number; y: number } | null {
  const prev = previewElementIds.get(key);
  if (prev?.length) {
    for (const id of prev) {
      try {
        board.findElementByAiId(id)?.destroy();
      } catch {
        // 示例已被用户删除/场景重建，跳过
      }
    }
  }
  const preview = previewToolElements(board, elements, key);
  return preview.ids.length ? preview : null;
}

/** 执行工具调用，返回给模型的文本结果与是否修改了画布/功能区（add_tool/update_tool 含异步冒烟测试） */
export async function executeTool(
  tool: AiTool,
  rawArgs: string,
  ctx: AiToolContext,
): Promise<AiToolExecution> {
  const { board, registry, mode } = ctx;
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return {
      name: tool.name,
      args: {},
      result: "错误：工具参数不是合法 JSON",
      changed: false,
    };
  }

  switch (tool.name) {
    case "get_canvas": {
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((s): s is string => typeof s === "string")
        : undefined;
      // 区域过滤：viewport 优先于 bounds；与 ids 同时传时以 ids 为准
      let region: CanvasRegion | null = null;
      if (!ids?.length) {
        if (args.viewport === true) {
          const vp = board.viewport;
          region = { minX: vp.minX, minY: vp.minY, maxX: vp.maxX, maxY: vp.maxY };
        } else if (typeof args.bounds === "object" && args.bounds !== null) {
          const b = args.bounds as Record<string, unknown>;
          const minX = typeof b.minX === "number" ? b.minX : NaN;
          const minY = typeof b.minY === "number" ? b.minY : NaN;
          const maxX = typeof b.maxX === "number" ? b.maxX : NaN;
          const maxY = typeof b.maxY === "number" ? b.maxY : NaN;
          if (![minX, minY, maxX, maxY].every(Number.isFinite) || minX >= maxX || minY >= maxY) {
            return {
              name: tool.name,
              args,
              result: "错误：bounds 需要合法的数字区域（minX < maxX、minY < maxY，世界坐标）",
              changed: false,
            };
          }
          region = { minX, minY, maxX, maxY };
        }
      }
      // 增量感知：全量调用（无 ids/region）走缓存判定——版本命中返回「无变化」
      // 摘要；版本推进返回 diff 变更集；full:true 或变更面过大时退回完整快照。
      // 定向查询不读也不写全量缓存（其输出与全量快照语义不同）
      if (!ids?.length && !region) {
        const version = board.perceptionVersion;
        const cached = getPerceptionSnapshot(board);
        if (cached && cached.version === version && args.full !== true) {
          return {
            name: tool.name,
            args,
            result: describeNoChange(board, cached.data),
            changed: false,
          };
        }
        const next = board.serializeWorld();
        if (cached && args.full !== true) {
          const diff = diffElementSnapshots(cached.data, next);
          const incremental = describePerceptionDiff(board, next, diff);
          if (incremental !== null) {
            setPerceptionSnapshot(board, { version, data: next });
            return {
              name: tool.name,
              args,
              result: incremental,
              changed: false,
            };
          }
          // 变更面过大：退回完整快照（缓存随后统一刷新）
        }
        setPerceptionSnapshot(board, { version, data: next });
        return {
          name: tool.name,
          args,
          result: `当前画布元素数据：\n${describeCanvas(board, ids, region)}`,
          changed: false,
        };
      }
      return {
        name: tool.name,
        args,
        result: `当前画布元素数据：\n${describeCanvas(board, ids, region)}`,
        changed: false,
      };
    }

    case "read_image": {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) {
        return {
          name: tool.name,
          args,
          result: "错误：id 不能为空（一次只读一张图片）",
          changed: false,
        };
      }
      const el = board.serialize().find((e) => e.id === id);
      if (el?.type !== "image") {
        return {
          name: tool.name,
          args,
          result: `错误：id=${id} 不是画布中的图片元素（可用 get_canvas 查看元素 id 与类型）`,
          changed: false,
        };
      }
      if (!el.url) {
        return {
          name: tool.name,
          args,
          result: `错误：图片 id=${id} 没有可读取的图像数据（url 为空）`,
          changed: false,
        };
      }
      const shot = await compressImageDataURL(el.url, IMAGE_READ_MAX_SIDE);
      if (!shot) {
        return {
          name: tool.name,
          args,
          result: `错误：图片 id=${id} 读取失败（数据可能损坏或远程图片跨域不可访问）`,
          changed: false,
        };
      }
      const rot = el.rotation ? `（画布上旋转 ${Math.round(el.rotation)}°）` : "";
      return {
        name: tool.name,
        args,
        result: `图片 id=${id}：原 ${Math.round(el.width ?? 0)}x${Math.round(el.height ?? 0)}px，已压缩至最长边 ${IMAGE_READ_MAX_SIDE}px${rot}：\n${shot}`,
        changed: false,
      };
    }

    case "update_elements": {
      const updates = Array.isArray(args.updates)
        ? (args.updates as { id?: string; patch?: Record<string, unknown> }[])
        : [];
      if (!updates.length) {
        return {
          name: tool.name,
          args,
          result: "错误：updates 不能为空",
          changed: false,
        };
      }
      // 字段白名单：只放行外观/几何字段，运行时字段（id/locked/penPoints 等）
      // 与未知字段一律忽略，防止模型写入破坏元素数据一致性
      const ALLOWED_FIELDS = new Set([
        "stroke",
        "strokeWidth",
        "fill",
        "rotation",
        "x",
        "y",
        "width",
        "height",
        "text",
        "fontSize",
        "points",
        "path",
        // P3 样式扩展：线型/透明度/圆角（groupId 不可写——分组是结构操作）
        "strokeDash",
        "opacity",
        "cornerRadius",
      ]);
      let ok = 0;
      let ignored = 0;
      const failed: string[] = [];
      const updatedIds: string[] = [];
      for (const u of updates) {
        if (!u.id || typeof u.patch !== "object" || u.patch === null) {
          failed.push(u.id ?? "(缺 id)");
          continue;
        }
        const patch: Record<string, unknown> = {};
        for (const key of Object.keys(u.patch)) {
          if (ALLOWED_FIELDS.has(key)) {
            patch[key] = u.patch[key];
          } else {
            ignored++;
          }
        }
        const done = board.updateElement(u.id, patch as Partial<ElementData>);
        if (done) {
          ok++;
          updatedIds.push(u.id);
        } else {
          failed.push(u.id);
        }
      }
      // 自检回执：成功时回传实际更新的 id 清单，模型可核对"改的是不是想改的"
      return {
        name: tool.name,
        args,
        result: failed.length
          ? `已更新 ${ok} 个元素${updatedIds.length ? `（id：${updatedIds.join("、")}）` : ""}；失败 ${failed.length} 个：${failed.join("、")}（不存在或已锁定）${ignored ? `；${ignored} 个字段不在白名单，已忽略` : ""}`
          : `已更新 ${ok} 个元素${updatedIds.length ? `（id：${updatedIds.join("、")}）` : ""}${ignored ? `（${ignored} 个字段不在白名单，已忽略）` : ""}`,
        changed: ok > 0,
      };
    }

    case "arrange_elements": {
      if (mode !== "chat") {
        return {
          name: tool.name,
          args,
          result: "错误：arrange_elements 仅交流模式可用",
          changed: false,
        };
      }
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((s): s is string => typeof s === "string")
        : [];
      const action = typeof args.action === "string" ? args.action : "";
      if (!(ARRANGE_ACTIONS as readonly string[]).includes(action)) {
        return {
          name: tool.name,
          args,
          result: `错误：action 必须是 ${ARRANGE_ACTIONS.join("/")} 之一`,
          changed: false,
        };
      }
      if (!ids.length) {
        return {
          name: tool.name,
          args,
          result: "错误：ids 不能为空（至少传 1 个元素 id）",
          changed: false,
        };
      }
      const { done, skipped } = board.arrangeByIds(ids, action as ArrangeAction);
      if (!done) {
        return {
          name: tool.name,
          args,
          result: skipped
            ? `未执行：${ids.length} 个目标元素全部锁定（锁定元素不能排列，请先解锁）`
            : "未执行：动作无实际效果（id 不存在，或数量不足——对齐需至少 2 个、分布需至少 3 个、层序需目标不在目标位置）",
          changed: false,
        };
      }
      return {
        name: tool.name,
        args,
        result: `已完成${ACTION_LABELS[action] ?? action}：${done} 个元素${skipped ? `（跳过 ${skipped} 个锁定元素）` : ""}`,
        changed: true,
      };
    }

    case "delete_elements": {
      if (mode !== "chat") {
        return {
          name: tool.name,
          args,
          result: "错误：delete_elements 仅交流模式可用",
          changed: false,
        };
      }
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((s): s is string => typeof s === "string")
        : [];
      if (!ids.length) {
        return {
          name: tool.name,
          args,
          result: "错误：ids 不能为空（至少传 1 个元素 id）",
          changed: false,
        };
      }
      const { removed, skipped } = board.deleteByIds(ids);
      if (!removed) {
        return {
          name: tool.name,
          args,
          result: skipped
            ? `未执行：${skipped} 个目标元素全部锁定（删除前请先解锁）`
            : "未执行：id 不存在或已被删除",
          changed: false,
        };
      }
      return {
        name: tool.name,
        args,
        result: `已删除 ${removed} 个元素${skipped ? `（跳过 ${skipped} 个锁定元素）` : ""}`,
        changed: true,
      };
    }

    case "beautify_elements": {
      if (mode !== "chat") {
        return {
          name: tool.name,
          args,
          result: "错误：beautify_elements 仅交流模式可用",
          changed: false,
        };
      }
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((s): s is string => typeof s === "string")
        : [];
      if (!ids.length) {
        return {
          name: tool.name,
          args,
          result: "错误：ids 不能为空（至少传 1 个元素 id）",
          changed: false,
        };
      }
      const { changed, stats, skipped } = board.beautifyByIds(ids);
      if (!changed) {
        return {
          name: tool.name,
          args,
          result: skipped
            ? `未执行：${ids.length} 个目标元素全部锁定（锁定元素不能整理，请先解锁）`
            : "未执行：目标中没有可整理的手绘笔迹（id 不存在或已是标准图形）",
          changed: false,
        };
      }
      const detail = stats.map((s) => `${s.label} ${s.count} 处`).join(" · ");
      return {
        name: tool.name,
        args,
        result: `已整理 ${changed} 个元素：${detail}${skipped ? `（跳过 ${skipped} 个锁定元素）` : ""}`,
        changed: true,
      };
    }

    case "sketchify_elements": {
      if (mode !== "chat") {
        return {
          name: tool.name,
          args,
          result: "错误：sketchify_elements 仅交流模式可用",
          changed: false,
        };
      }
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((s): s is string => typeof s === "string")
        : [];
      if (!ids.length) {
        return {
          name: tool.name,
          args,
          result: "错误：ids 不能为空（至少传 1 个元素 id）",
          changed: false,
        };
      }
      const { changed, skipped } = board.sketchifyByIds(ids);
      if (!changed) {
        return {
          name: tool.name,
          args,
          result: skipped
            ? `未执行：${ids.length} 个目标元素全部锁定（锁定元素不能转换，请先解锁）`
            : "未执行：目标中没有可转换的标准图形（id 不存在或已是手绘风格）",
          changed: false,
        };
      }
      return {
        name: tool.name,
        args,
        result: `已将 ${changed} 个元素转为手绘风格${skipped ? `（跳过 ${skipped} 个锁定元素）` : ""}`,
        changed: true,
      };
    }

    case "set_roughness": {
      if (mode !== "chat") {
        return {
          name: tool.name,
          args,
          result: "错误：set_roughness 仅交流模式可用",
          changed: false,
        };
      }
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((s): s is string => typeof s === "string")
        : [];
      if (!ids.length) {
        return {
          name: tool.name,
          args,
          result: "错误：ids 不能为空（至少传 1 个元素 id）",
          changed: false,
        };
      }
      const value = typeof args.value === "number" ? args.value : NaN;
      if (!Number.isFinite(value) || value < 0 || value > 2) {
        return {
          name: tool.name,
          args,
          result: "错误：value 必须是 0~2 之间的数字（0 = 接近规整，2 = 抖动最强）",
          changed: false,
        };
      }
      const { changed, skipped } = board.setRoughnessByIds(ids, value);
      if (!changed) {
        return {
          name: tool.name,
          args,
          result: skipped
            ? `未执行：${ids.length} 个目标元素全部锁定（锁定元素不能调整，请先解锁）`
            : "未执行：目标中没有已手绘元素（id 不存在或没有手绘元数据）",
          changed: false,
        };
      }
      return {
        name: tool.name,
        args,
        result: `已调整 ${changed} 个元素的粗糙度为 ${value}${skipped ? `（跳过 ${skipped} 个锁定元素）` : ""}`,
        changed: true,
      };
    }

    case "create_elements": {
      if (mode !== "chat") {
        return {
          name: tool.name,
          args,
          result: "错误：create_elements 仅交流模式可用",
          changed: false,
        };
      }
      const parsed = parseLeaferJSON(args.elements);
      const created: string[] = [];
      const failed: string[] = [];
      parsed.forEach((r, i) => {
        if (!r.data) {
          failed.push(`第 ${i + 1} 个：${r.error ?? "未知错误"}`);
          return;
        }
        const id = board.addElement(r.data);
        if (id) {
          created.push(id);
        } else {
          failed.push(`第 ${i + 1} 个：创建失败`);
        }
      });
      return {
        name: tool.name,
        args,
        result: failed.length
          ? `已创建 ${created.length} 个元素（id：${created.join("、")}）；失败 ${failed.length} 个：${failed.join("；")}`
          : `已创建 ${created.length} 个元素（id：${created.join("、")}）`,
        changed: created.length > 0,
      };
    }

    case "draw_flowchart":
      if (mode !== "chat") {
        return {
          name: tool.name,
          args,
          result: "错误：draw_flowchart 仅交流模式可用",
          changed: false,
        };
      }
      return {
        name: tool.name,
        args,
        result: drawFlowchart(board, args),
        changed: true,
      };

    case "list_tools": {
      if (mode !== "edit") {
        return {
          name: tool.name,
          args,
          result: "错误：功能区管理工具仅在编辑模式可用",
          changed: false,
        };
      }
      const query = args as { id?: unknown; includeSource?: unknown };
      const filterId = typeof query.id === "string" ? query.id : "";
      const withSource = query.includeSource === true || !!filterId;
      const tools = registry
        .list()
        .filter((t) => !filterId || t.id === filterId)
        .map((t) => ({
          id: t.id,
          name: t.name,
          icon: t.icon,
          shortcut: t.shortcut ?? null,
          kind: t.kind,
          source: t.source,
          group: t.group ?? null,
          // 源码可见是增量修改的前提：凭空重写会造成功能回退
          generator:
            withSource && t.source === "custom"
              ? ((t as CustomToolDef).generator ?? null)
              : undefined,
        }));
      return {
        name: tool.name,
        args,
        result: `功能区当前工具（${tools.length} 个）：\n${JSON.stringify(tools)}`,
        changed: false,
      };
    }

    case "add_tool": {
      if (mode !== "edit") {
        return {
          name: tool.name,
          args,
          result: "错误：功能区管理工具仅在编辑模式可用",
          changed: false,
        };
      }
      const input = args as unknown as CustomToolInput;
      // 冒烟测试：隔离执行 + 返回值强校验；未通过时把具体原因反馈给模型，让其修正后重试
      const smoke = await registry.smokeTest(input.generator, input.kind);
      if (!smoke.ok) {
        return {
          name: tool.name,
          args,
          result: `错误：生成器验证未通过——${smoke.error}（工具未添加，请修正生成器后重试）`,
          changed: false,
        };
      }
      try {
        const toolDef = registry.addCustom(input);
        ctx.toolbar?.refresh();
        // 试画预览：把验证通过的示例元素放到画布内容区右侧，用户可立即看到效果（可撤销）
        let previewText = "";
        try {
          const preview = previewToolElements(board, smoke.elements, toolDef.id);
          if (preview.ids.length) {
            previewText = `，并已在画布 (${Math.round(preview.x)}, ${Math.round(preview.y)}) 处试画 ${preview.ids.length} 个示例元素（id：${preview.ids.join("、")}），可直接查看效果，不需要可按 Delete 删除或 Ctrl+Z 撤销`;
          }
        } catch {
          // 试画失败不影响工具注册
        }
        return {
          name: tool.name,
          args,
          result: `已添加${toolDef.kind === "click" ? "点击" : "拖拽"}工具「${toolDef.name}」，id=${toolDef.id}，图标「${toolDef.icon}」${toolDef.shortcut ? `，快捷键 ${toolDef.shortcut}` : ""}${toolDef.group ? `，已归入「${toolDef.group === "shape" ? "形状" : toolDef.group}▾」下拉` : ""}，已出现在工具栏绘制区并可立即使用${previewText}`,
          changed: true,
          tool: {
            name: toolDef.name,
            icon: toolDef.icon,
            shortcut: toolDef.shortcut,
            group: toolDef.group,
            kind: toolDef.kind,
          },
        };
      } catch (err) {
        return {
          name: tool.name,
          args,
          result: `错误：添加失败——${err instanceof Error ? err.message : String(err)}`,
          changed: false,
        };
      }
    }

    case "update_tool": {
      if (mode !== "edit") {
        return {
          name: tool.name,
          args,
          result: "错误：功能区管理工具仅在编辑模式可用",
          changed: false,
        };
      }
      const id = typeof args.id === "string" ? args.id : "";
      const def = registry.getTool(id);
      if (!def) {
        return {
          name: tool.name,
          args,
          result: `错误：工具 ${id || "(未提供)"} 不存在`,
          changed: false,
        };
      }
      if (def.source !== "custom") {
        return {
          name: tool.name,
          args,
          result: `错误：内置工具「${def.name}」只读，不能修改（只能修改 AI 生成的自定义工具）`,
          changed: false,
        };
      }
      const patch = (args.patch ?? {}) as Partial<CustomToolInput>;
      let smokeElements: ElementData[] | null = null;
      // 生成器变更时同样过冒烟测试（kind 随 patch 或原工具传递），未通过则不改动工具
      if (typeof patch.generator === "string") {
        const smoke = await registry.smokeTest(patch.generator, patch.kind ?? def.kind);
        if (!smoke.ok) {
          return {
            name: tool.name,
            args,
            result: `错误：生成器验证未通过——${smoke.error}（工具未修改，请修正生成器后重试）`,
            changed: false,
          };
        }
        smokeElements = smoke.elements;
      }
      try {
        const updated = registry.updateCustom(id, patch);
        ctx.toolbar?.refresh();
        // 生成器有变更：在记忆锚点处原地更新试画示例（旧示例一并移除，
        // 与本轮其他改动合并为一步撤销），「再大一点」类迭代可原地对比
        let previewText = "";
        if (smokeElements) {
          const preview = refreshToolPreview(board, id, smokeElements);
          if (preview) {
            previewText = `，并已在原试画位置 (${Math.round(preview.x)}, ${Math.round(preview.y)}) 更新 ${preview.ids.length} 个示例元素`;
          }
        }
        return {
          name: tool.name,
          args,
          result: `已更新工具「${updated?.name}」（id=${id}）${previewText}`,
          changed: true,
          tool: updated
            ? {
                name: updated.name,
                icon: updated.icon,
                shortcut: updated.shortcut,
                group: updated.group,
                kind: updated.kind,
              }
            : undefined,
        };
      } catch (err) {
        return {
          name: tool.name,
          args,
          result: `错误：修改失败——${err instanceof Error ? err.message : String(err)}`,
          changed: false,
        };
      }
    }

    case "remove_tool": {
      if (mode !== "edit") {
        return {
          name: tool.name,
          args,
          result: "错误：功能区管理工具仅在编辑模式可用",
          changed: false,
        };
      }
      const id = typeof args.id === "string" ? args.id : "";
      const def = registry.getTool(id);
      if (!def) {
        return {
          name: tool.name,
          args,
          result: `错误：工具 ${id || "(未提供)"} 不存在`,
          changed: false,
        };
      }
      if (def.source !== "custom") {
        return {
          name: tool.name,
          args,
          result: `错误：内置工具「${def.name}」不可删除（只能删除 AI 生成的自定义工具）`,
          changed: false,
        };
      }
      registry.removeCustom(id);
      ctx.toolbar?.refresh();
      return {
        name: tool.name,
        args,
        result: `已删除工具「${def.name}」（id=${id}），工具栏已刷新`,
        changed: true,
        tool: {
          name: def.name,
          icon: def.icon,
          shortcut: def.shortcut,
          group: def.group,
        },
      };
    }

    default:
      return {
        name: tool.name,
        args,
        result: `错误：未知工具 ${tool.name}`,
        changed: false,
      };
  }
}
