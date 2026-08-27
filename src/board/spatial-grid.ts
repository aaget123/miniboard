/**
 * 空间网格索引（性能优化）：把「遍历全部元素」的命中类查询降为 O(候选数)。
 *
 * 数据结构：均匀网格哈希——大元素跨多桶（每桶存引用），小元素一桶。
 * 相比 R 树无重平衡复杂度、增删改均摊 O(1)，对白板这种"大部分元素中小尺寸 +
 * 少数超大框架"的分布足够高效；正确性由模糊测试保证（与暴力扫描全量对照）。
 *
 * 坐标系：由调用方约定（本项目为视口基准的 worldBoxBounds）；本模块只做
 * AABB 空间划分，不感知 leafer。
 */

export type SpatialBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** 插入条目：业务对象 + 覆盖包围盒 */
export type SpatialItem<T> = {
  item: T;
  bounds: SpatialBounds;
};

type Entry = {
  /** 最近一次插入/更新时的覆盖盒 */
  bounds: SpatialBounds;
  /** 物件当前占用的桶键（remove/update 快速定位） */
  cells: string[];
};

const MIN_CELL = 96;
const MAX_CELL = 1024;

/** 元素跨越的桶区间（含端点） */
function cellSpan(
  b: SpatialBounds,
  cell: number,
): {
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
} {
  return {
    cx0: Math.floor(b.minX / cell),
    cy0: Math.floor(b.minY / cell),
    cx1: Math.floor(b.maxX / cell),
    cy1: Math.floor(b.maxY / cell),
  };
}

export class SpatialGrid<T extends object> {
  private cellSize = 256;
  private buckets = new Map<string, Set<T>>();
  private entries = new Map<T, Entry>();
  /** 查询去重戳（实例自增；entry 无戳字段时用 WeakMap 存） */
  private stamp = 0;
  private stamps = new Map<T, number>();

  /** 当前物件数量 */
  get size(): number {
    return this.entries.size;
  }

  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  has(item: T): boolean {
    return this.entries.has(item);
  }

  /** 某物件最近一次登记的包围盒（不存在返回 undefined） */
  boundsOf(item: T): SpatialBounds | undefined {
    return this.entries.get(item)?.bounds;
  }

  /**
   * 全量重建：一次性灌入所有元素。同时按元素典型尺寸自适应桶宽
   * （取 max(w,h) 的中位数，夹在 [MIN_CELL, MAX_CELL] 并归整到 2 的幂）。
   */
  rebuild(items: Iterable<SpatialItem<T>>) {
    this.buckets.clear();
    this.entries.clear();
    this.stamps.clear();
    const sizes: number[] = [];
    const batch: SpatialItem<T>[] = [];
    let i = 0;
    for (const it of items) {
      // 中位数采样步长：≤4096 个时全采，更大按比例抽样控制排序成本
      const stride = i > 4096 ? Math.ceil(i / 4096) : 1;
      if (i % stride === 0) {
        const s = Math.max(it.bounds.maxX - it.bounds.minX, it.bounds.maxY - it.bounds.minY, 8);
        sizes.push(s);
      }
      batch.push(it);
      i++;
    }
    sizes.sort((a, b) => a - b);
    const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 256;
    const pow = 2 ** Math.round(Math.log2(Math.min(MAX_CELL, Math.max(MIN_CELL, med))));
    this.cellSize = pow;
    for (const it of batch) {
      this.insert(it.item, it.bounds);
    }
  }

  insert(item: T, bounds: SpatialBounds) {
    if (this.entries.has(item)) {
      this.update(item, bounds);
      return;
    }
    const cells: string[] = [];
    const { cx0, cy0, cx1, cy1 } = cellSpan(bounds, this.cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = `${cx},${cy}`;
        let set = this.buckets.get(key);
        if (!set) {
          set = new Set();
          this.buckets.set(key, set);
        }
        set.add(item);
        cells.push(key);
      }
    }
    this.entries.set(item, { bounds, cells });
  }

  /** 位置/尺寸变更：桶跨度未变只更新盒值，变了走重插 */
  update(item: T, bounds: SpatialBounds) {
    const e = this.entries.get(item);
    if (!e) {
      this.insert(item, bounds);
      return;
    }
    const next: string[] = [];
    const { cx0, cy0, cx1, cy1 } = cellSpan(bounds, this.cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        next.push(`${cx},${cy}`);
      }
    }
    const old = e.cells;
    let same = old.length === next.length;
    if (same) {
      for (let k = 0; k < old.length; k++) {
        if (old[k] !== next[k]) {
          same = false;
          break;
        }
      }
    }
    if (same) {
      e.bounds = bounds;
      return;
    }
    this.remove(item);
    this.insert(item, bounds);
  }

  remove(item: T) {
    const e = this.entries.get(item);
    if (!e) {
      return;
    }
    for (const key of e.cells) {
      const set = this.buckets.get(key);
      if (set) {
        set.delete(item);
        if (!set.size) {
          this.buckets.delete(key);
        }
      }
    }
    this.entries.delete(item);
    this.stamps.delete(item);
  }

  /** 命中点查询（半径扩展；结果唯一，无重复） */
  queryPoint(x: number, y: number, radius = 0): T[] {
    return this.queryBox({
      minX: x - radius,
      minY: y - radius,
      maxX: x + radius,
      maxY: y + radius,
    });
  }

  /** 命中盒查询（交叠即中；结果唯一，顺序不保证） */
  queryBox(box: SpatialBounds): T[] {
    const out: T[] = [];
    if (!this.entries.size) {
      return out;
    }
    const qStamp = ++this.stamp;
    const { cx0, cy0, cx1, cy1 } = cellSpan(box, this.cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const set = this.buckets.get(`${cx},${cy}`);
        if (!set) {
          continue;
        }
        for (const item of set) {
          const b = this.entries.get(item)?.bounds;
          if (!b || this.stamps.get(item) === qStamp) {
            continue;
          }
          if (
            box.minX <= b.maxX &&
            box.maxX >= b.minX &&
            box.minY <= b.maxY &&
            box.maxY >= b.minY
          ) {
            this.stamps.set(item, qStamp);
            out.push(item);
          }
        }
      }
    }
    return out;
  }

  clear() {
    this.buckets.clear();
    this.entries.clear();
    this.stamps.clear();
  }
}
