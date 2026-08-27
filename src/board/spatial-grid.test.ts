import { describe, expect, it } from "vitest";
import { SpatialGrid, type SpatialBounds } from "./spatial-grid";

/** 可复现伪随机（mulberry32） */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Item = { id: number; label: string };

const randBox = (r: () => number, span = 400): SpatialBounds => {
  const w = 8 + r() * 120;
  const h = 8 + r() * 120;
  const x = -span + r() * span * 2;
  const y = -span + r() * span * 2;
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
};

const intersects = (a: SpatialBounds, b: SpatialBounds): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

/** 暴力参照：过滤全部条目求交 */
function bruteForce(ref: Map<Item, SpatialBounds>, q: SpatialBounds): Set<number> {
  const out = new Set<number>();
  for (const [item, b] of ref) {
    if (intersects(q, b)) {
      out.add(item.id);
    }
  }
  return out;
}

describe("SpatialGrid", () => {
  it("点/矩形查询与暴力扫描一致（含半径扩展、去重）", () => {
    const grid = new SpatialGrid<Item>();
    const ref = new Map<Item, SpatialBounds>();
    for (let id = 0; id < 200; id++) {
      const item: Item = { id, label: `el${id}` };
      const b = randBox(prng(id + 1));
      ref.set(item, b);
      grid.insert(item, b);
    }
    const r = prng(42);
    // 大量探测盒与点：集合必须逐一相等
    for (let k = 0; k < 500; k++) {
      if (k % 3 === 0) {
        const px = -400 + r() * 800;
        const py = -400 + r() * 800;
        const radius = r() * 60;
        const want = bruteForce(ref, {
          minX: px - radius,
          minY: py - radius,
          maxX: px + radius,
          maxY: py + radius,
        });
        const got = new Set(grid.queryPoint(px, py, radius).map((it) => it.id));
        expect(got).toEqual(want);
      } else {
        const q = randBox(r, 500);
        const got = new Set(grid.queryBox(q).map((it) => it.id));
        expect(got).toEqual(bruteForce(ref, q));
      }
    }
  });

  it("update 跨桶移动后查询仍正确（增量重插路径）", () => {
    const grid = new SpatialGrid<Item>();
    const item: Item = { id: 1, label: "mover" };
    const start = { minX: 10, minY: 10, maxX: 60, maxY: 60 };
    grid.insert(item, start);
    expect(grid.queryPoint(30, 30)).toEqual([item]);
    // 移动跨越多个桶：索引随 update 迁移
    const moved = { minX: 900, minY: 900, maxX: 950, maxY: 950 };
    grid.update(item, moved);
    expect(grid.queryPoint(30, 30)).toEqual([]);
    expect(grid.queryPoint(920, 920)).toEqual([item]);
    // 原地小改尺寸不迁移桶
    const grown = { minX: 900, minY: 900, maxX: 990, maxY: 990 };
    grid.update(item, grown);
    expect(grid.boundsOf(item)).toEqual(grown);
    expect(grid.queryPoint(985, 985)).toEqual([item]);
  });

  it("remove 后不再命中；超大元素跨多桶无双计", () => {
    const grid = new SpatialGrid<Item>();
    const giant: Item = { id: 100, label: "giant" };
    grid.insert(giant, { minX: 0, minY: 0, maxX: 1500, maxY: 800 });
    // 期望自适应桶宽远小于该元素 → 必然跨桶；单次命中即去重
    const hits = grid.queryPoint(700, 400);
    expect(hits.length).toBe(1);
    expect(hits[0]).toBe(giant);
    grid.remove(giant);
    expect(grid.has(giant)).toBe(false);
    expect(grid.isEmpty()).toBe(true);
    expect(grid.queryPoint(700, 400)).toEqual([]);
  });

  it("rebuild 后语义等价于逐个 insert", () => {
    const items: { item: Item; bounds: SpatialBounds }[] = [];
    const r = prng(7);
    for (let id = 0; id < 300; id++) {
      items.push({ item: { id, label: `x${id}` }, bounds: randBox(r) });
    }
    const a = new SpatialGrid<Item>();
    const b = new SpatialGrid<Item>();
    for (const it of items) {
      a.insert(it.item, it.bounds);
    }
    b.rebuild(items);
    const probeBoxes = Array.from({ length: 200 }, () => randBox(r, 600));
    for (const q of probeBoxes.concat(randBox(r, 600))) {
      const sa = new Set(a.queryBox(q).map((x) => x.id));
      const sb = new Set(b.queryBox(q).map((x) => x.id));
      expect(sa).toEqual(sb);
    }
  });

  it("模糊测试：混合操作序列与暴力参照全程一致", () => {
    const r = prng(20260826);
    const grid = new SpatialGrid<Item>();
    const ref = new Map<Item, SpatialBounds>();
    let nextId = 0;
    const live: Item[] = [];

    const randomExisting = (): Item | null =>
      live.length ? live[Math.floor(r() * live.length)] : null;

    for (let step = 0; step < 3000; step++) {
      const roll = r();
      if (roll < 0.4 || !live.length) {
        // 插入
        const item: Item = { id: nextId++, label: "fuzz" };
        const b = randBox(r);
        grid.insert(item, b);
        ref.set(item, b);
        live.push(item);
      } else if (roll < 0.6) {
        // 随机移动现有元素
        const item = randomExisting() as Item;
        const oldB = ref.get(item) as SpatialBounds;
        const dx = (r() - 0.5) * 300;
        const dy = (r() - 0.5) * 300;
        const nb: SpatialBounds = {
          minX: oldB.minX + dx,
          minY: oldB.minY + dy,
          maxX: oldB.maxX + dx,
          maxY: oldB.maxY + dy,
        };
        grid.update(item, nb);
        ref.set(item, nb);
      } else if (roll < 0.75) {
        // 删除
        const idx = Math.floor(r() * live.length);
        const item = live[idx] as Item;
        grid.remove(item);
        ref.delete(item);
        live.splice(idx, 1);
      } else if (roll < 0.78) {
        // 全量重建
        grid.rebuild(Array.from(ref, ([item, bounds]) => ({ item, bounds })));
      } else {
        // 查询对照（点/盒混合）
        if (r() < 0.5) {
          const px = -420 + r() * 840;
          const py = -420 + r() * 840;
          const rad = r() * 80;
          const q: SpatialBounds = {
            minX: px - rad,
            minY: py - rad,
            maxX: px + rad,
            maxY: py + rad,
          };
          expect(new Set(grid.queryPoint(px, py, rad).map((x) => x.id))).toEqual(
            bruteForce(ref, q),
          );
        } else {
          const q = randBox(r, 520);
          expect(new Set(grid.queryBox(q).map((x) => x.id))).toEqual(bruteForce(ref, q));
        }
      }
    }
    // 终态整体校验
    expect(grid.size).toBe(ref.size);
    const finalQ = randBox(prng(99), 800);
    expect(new Set(grid.queryBox(finalQ).map((x) => x.id))).toEqual(bruteForce(ref, finalQ));
  });

  it("重复 insert 幂等（转入 update），clear 清空", () => {
    const grid = new SpatialGrid<Item>();
    const item: Item = { id: 5, label: "dup" };
    const b1 = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
    const b2 = { minX: 200, minY: 200, maxX: 240, maxY: 240 };
    grid.insert(item, b1);
    grid.insert(item, b2); // 应走 update 分支而非双登记
    expect(grid.size).toBe(1);
    expect(grid.queryPoint(20, 20)).toEqual([]);
    expect(grid.queryPoint(220, 220)).toEqual([item]);
    grid.clear();
    expect(grid.isEmpty()).toBe(true);
    expect(grid.queryBox({ minX: -999, minY: -999, maxX: 999, maxY: 999 })).toEqual([]);
  });
});
