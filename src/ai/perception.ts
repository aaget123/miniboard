import type { ElementData } from "../types";

// ================= AI 增量画布感知 =================
//
// get_canvas 全量调用的成本随元素数线性增长，长对话里反复获取同一画布
// 浪费大量 token。本模块提供：
// - 快照缓存：按 board 实例隔离（WeakMap，不阻止回收），记录取用时的
//   perceptionVersion 与全量序列化数据；
// - 指纹 diff：版本不一致时对比前后两次序列化，只输出 新增 / 更新 / 删除，
//   未变更元素不再重复返回。

export interface PerceptionSnapshot {
  /** 取用时的 board.perceptionVersion */
  version: number;
  /** serializeWorld() 全量快照 */
  data: ElementData[];
}

const snapshots = new WeakMap<object, PerceptionSnapshot>();

export function getPerceptionSnapshot(board: object): PerceptionSnapshot | null {
  return snapshots.get(board) ?? null;
}

export function setPerceptionSnapshot(board: object, snapshot: PerceptionSnapshot): void {
  snapshots.set(board, snapshot);
}

/** 数字归一到 1 位小数：规避拖拽/换算的浮点抖动被误判为「更新」 */
function normalize(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // 键排序保证稳定序列化（两侧来源相同管线，此处双保险）
    for (const key of Object.keys(src).sort()) {
      out[key] = normalize(src[key]);
    }
    return out;
  }
  return value;
}

/** 元素指纹：归一化后的稳定 JSON（字段全量参与，样式/文字变更同样能检出） */
export function fingerprintElement(el: ElementData): string {
  return JSON.stringify(normalize(el));
}

export interface ElementDiff {
  /** 上次不存在的新元素 */
  added: ElementData[];
  /** 已存在但指纹变化的元素（完整新数据） */
  updated: ElementData[];
  /** 已不存在的元素 id */
  removedIds: string[];
}

/**
 * 对比两次全量序列化快照，输出增量变更集。
 * 按 id 对齐（无 id 的元素防御性跳过——正常序列化必带 id）。
 */
export function diffElementSnapshots(prev: ElementData[], next: ElementData[]): ElementDiff {
  const prevMap = new Map<string, ElementData>();
  for (const el of prev) {
    if (el.id) {
      prevMap.set(el.id, el);
    }
  }
  const nextMap = new Map<string, ElementData>();
  for (const el of next) {
    if (el.id) {
      nextMap.set(el.id, el);
    }
  }
  const added: ElementData[] = [];
  const updated: ElementData[] = [];
  for (const [id, el] of nextMap) {
    const before = prevMap.get(id);
    if (!before) {
      added.push(el);
    } else if (fingerprintElement(before) !== fingerprintElement(el)) {
      updated.push(el);
    }
  }
  const removedIds = [...prevMap.keys()].filter((id) => !nextMap.has(id));
  return { added, updated, removedIds };
}

/** 变更集是否为空（配合缓存版本号兜底判定） */
export function hasChanges(diff: ElementDiff): boolean {
  return diff.added.length > 0 || diff.updated.length > 0 || diff.removedIds.length > 0;
}
