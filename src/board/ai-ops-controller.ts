import { Line, Path, Text } from "leafer-ui";
import type { UI } from "leafer-ui";
import type { ElementData } from "../types";
import type { CoordBox } from "./coords";
import { canvasToLocal } from "./coords";
import {
  alignElements,
  distributeElements,
  expandGroupMembers,
  flipElements,
  reorderElements,
} from "./arrange";
import type { ArrangeAction, ReorderMode } from "./arrange";
import { beautifyScene } from "./beautify";
import type { BeautifyStats } from "./beautify";
import { expandFrameContents } from "./frame";
import { unionBounds } from "./bounds";
import { isSketchable, redrawRough, sketchifyData } from "./rough";
import { isFreehandEl, toLeaferArrow } from "./element-utils";

/** AI 编排控制器的依赖：序列化/重建/快照与选中状态均经 Board 门面方法注入 */
export type AiOpsDeps = {
  /** 场景元素遍历（按 id 查找、组联动扫描） */
  treeChildren: () => UI[];
  editorCancel: () => void;
  editorTarget: (el: UI) => void;
  editorSelect: (list: UI[]) => void;
  /** 当前编辑器选中列表（AI 面板 @ 选区、层序重排的取数基准） */
  selectedList: () => UI[];
  isEditorInternal: (el: UI) => boolean;
  /** 序列化 → 重建 → 历史快照编排（Board 门面方法注入） */
  serialize: () => ElementData[];
  loadElements: (data: ElementData[], opts?: { worldCoords?: boolean }) => void;
  pushSnapshot: (snapshot: ElementData[]) => void;
  elementToData: (el: UI) => ElementData | null;
  dataToElement: (d: ElementData) => UI | null;
  addToTree: (el: UI) => void;
  /** 框架体系：新增元素归属/夹紧入框 */
  adoptAndClamp: (el: UI) => void;
  /** 删除前退出点编辑/裁剪模式 */
  exitPointEdit: () => void;
  cancelCrop: () => void;
  commitHistory: () => void;
  onMutated: () => void;
};

/**
 * AI 编排控制器：稳定 id 注册与 AI 工具的批量场景操作。
 *
 * 三类职责：
 * 1. 稳定 id（el-N/grp-N）：元素 → id 的注册与查找（AI 工具、序列化、连接绑定共用）；
 * 2. 按 id 批量操作（排列/整理/手绘化/粗糙度/删除/属性更新）：
 *    「序列化 → 组/框架展开 → 纯函数变换 → worldCoords 重建 → 前后快照」管线，
 *    同组成员整组参与、锁定元素跳过计入手数，整轮合并一步撤销；
 * 3. 层序重排管线（用户 toFront/toBack 与 AI 层序动作共用）。
 */
export class AiOpsController {
  /** 元素/分组 id 分配计数器（el-N 与 grp-N 共用一条流水线防撞号） */
  private nextId = 1;

  constructor(private readonly deps: AiOpsDeps) {}

  // ================= 稳定 id 注册 =================

  /** 元素的稳定 id（无则分配 el-N 并缓存；AI 工具/序列化/绑定按 id 引用元素） */
  idOf(el: UI): string {
    const cached = (el as unknown as { __aiId?: string }).__aiId;
    if (cached) {
      return cached;
    }
    let id: string;
    do {
      id = `el-${this.nextId++}`;
    } while (this.isUsed(id));
    (el as unknown as { __aiId?: string }).__aiId = id;
    return id;
  }

  /** 分配分组 id（grp-N） */
  nextGroupId(): string {
    return `grp-${this.nextId++}`;
  }

  /** 判断 id 是否已被画布中其他元素占用（防止恢复/导入后重复分配冲突） */
  private isUsed(id: string): boolean {
    return this.deps
      .treeChildren()
      .some((el) => (el as unknown as { __aiId?: string }).__aiId === id);
  }

  /** 按稳定 id 查找画布元素；不存在返回 null */
  find(id: string): UI | null {
    const list = this.deps.treeChildren();
    return list.find((el) => (el as unknown as { __aiId?: string }).__aiId === id) ?? null;
  }

  // ================= AI 按 id 删除（delete_elements 工具） =================

  /**
   * 按 id 删除元素：同组成员整组参与（与 arrange/beautify 的组联动语义一致）、
   * 锁定元素跳过计入手数；删除后清理点编辑/裁剪/编辑器选中状态。
   */
  deleteByIds(ids: string[]): { removed: number; skipped: number } {
    const found: UI[] = [];
    const seen = new Set<UI>();
    let locked = 0;
    for (const raw of ids) {
      const el = this.find(raw);
      if (!el || seen.has(el)) {
        continue;
      }
      if (el.locked) {
        locked++;
        continue;
      }
      seen.add(el);
      found.push(el);
    }
    if (!found.length) {
      return { removed: 0, skipped: locked };
    }
    const gids = new Set<string>();
    for (const el of found) {
      const g = (el as unknown as { __groupId?: string }).__groupId;
      if (g) {
        gids.add(g);
      }
    }
    if (gids.size) {
      for (const el of this.deps.treeChildren()) {
        const g = (el as unknown as { __groupId?: string }).__groupId;
        if (g && gids.has(g) && !seen.has(el)) {
          if (el.locked) {
            locked++;
            continue;
          }
          seen.add(el);
          found.push(el);
        }
      }
    }
    for (const el of found) {
      el.destroy();
    }
    this.deps.editorCancel();
    this.deps.exitPointEdit();
    this.deps.cancelCrop();
    this.deps.commitHistory();
    this.deps.onMutated();
    return { removed: found.length, skipped: locked };
  }

  // ================= AI 排列（对齐/分布/翻转/层序，供 arrange_elements 工具） =================
  arrangeByIds(ids: string[], action: ArrangeAction): { done: number; skipped: number } {
    // before 为相对坐标（历史快照基准）；计算在世界坐标下进行（frame 内元素
    // 相对坐标会让对齐/分布失真），loadElements 用 worldCoords 模式重建
    const before = this.deps.serialize();
    const world = expandFrameContents(before);
    const byId = new Map(world.map((d) => [d.id, d]));
    const found = ids.filter((id) => byId.has(id));
    const skipped = found.filter((id) => byId.get(id)?.locked).length;
    const selIds = found.filter((id) => !byId.get(id)?.locked);
    if (!selIds.length) {
      return { done: 0, skipped };
    }
    const members = expandGroupMembers(world, selIds);
    const targets = world.filter((d) => members.has(d.id ?? ""));
    let next: ElementData[];
    if (action === "front" || action === "back" || action === "forward" || action === "backward") {
      // 层序作用于全列表（组内成员必须保持相对顺序），其余动作只作用于目标元素
      next = reorderElements(world, [...members], (d) => d.id ?? "", action);
    } else {
      const changed = this.arrangeFn(action)(targets);
      const changedById = new Map(changed.map((d) => [d.id, d]));
      next = world.map((d) => changedById.get(d.id) ?? d);
    }
    if (next.every((d, i) => d === world[i])) {
      return { done: 0, skipped };
    }
    this.deps.loadElements(next, { worldCoords: true });
    // 历史快照保持相对坐标（undo/redo 走默认换算路径）
    this.deps.pushSnapshot(before);
    this.deps.pushSnapshot(this.deps.serialize());
    return { done: members.size, skipped };
  }

  // ================= AI 整理/手绘/粗糙度（beautify_elements 等工具，按 id 操作） =================

  /**
   * AI 整理（beautify_elements 工具）：按 id 把手绘笔迹识别为标准图形/拉直，
   * 未指名的元素原样保留；同组成员整组参与、锁定元素跳过；整轮改动一步撤销。
   */
  beautifyByIds(ids: string[]): { changed: number; stats: BeautifyStats; skipped: number } {
    const before = this.deps.serialize();
    const byId = new Map(before.map((d) => [d.id, d]));
    const found = ids.filter((id) => byId.has(id));
    const skipped = found.filter((id) => byId.get(id)?.locked).length;
    const selIds = found.filter((id) => !byId.get(id)?.locked);
    if (!selIds.length) {
      return { changed: 0, stats: [], skipped };
    }
    const members = expandGroupMembers(before, selIds);
    const { elements, stats } = beautifyScene(expandFrameContents(before), [...members]);
    if (!stats.length) {
      return { changed: 0, stats: [], skipped };
    }
    this.deps.loadElements(elements, { worldCoords: true });
    this.deps.pushSnapshot(before);
    this.deps.pushSnapshot(this.deps.serialize());
    return { changed: stats.length, stats, skipped };
  }

  /**
   * AI 手绘化（sketchify_elements 工具）：按 id 把标准图形转为 rough 手绘风格，
   * 已手绘/不可手绘的元素自动跳过；同组成员整组参与、锁定元素跳过。
   */
  sketchifyByIds(ids: string[]): { changed: number; skipped: number } {
    const before = this.deps.serialize();
    const byId = new Map(before.map((d) => [d.id, d]));
    const found = ids.filter((id) => byId.has(id));
    const skipped = found.filter((id) => byId.get(id)?.locked).length;
    const selIds = found.filter((id) => !byId.get(id)?.locked);
    if (!selIds.length) {
      return { changed: 0, skipped };
    }
    const members = expandGroupMembers(before, selIds);
    let changed = 0;
    const next = expandFrameContents(before).map((d) => {
      if (!d.id || !members.has(d.id) || !isSketchable(d)) {
        return d;
      }
      const sketched = sketchifyData(d);
      if (!sketched) {
        return d;
      }
      changed++;
      return {
        ...d,
        type: "path" as const,
        path: sketched.path,
        rough: {
          seed: sketched.seed,
          original: d.type,
          roughness: 1,
          originalPath: d.type === "path" ? d.path : undefined,
          originalWidth: sketched.originalWidth,
          originalHeight: sketched.originalHeight,
          originalPoints: sketched.originalPoints,
        },
      };
    });
    if (!changed) {
      return { changed: 0, skipped };
    }
    this.deps.loadElements(next, { worldCoords: true });
    this.deps.pushSnapshot(before);
    this.deps.pushSnapshot(this.deps.serialize());
    return { changed, skipped };
  }

  /**
   * AI 粗糙度（set_roughness 工具）：按 id 调整已手绘元素的抖动强度（0~2），
   * 同一 seed 重绘（抖动态不变仅幅度变化）；无 rough 元数据的元素跳过。
   */
  setRoughnessByIds(ids: string[], value: number): { changed: number; skipped: number } {
    const before = this.deps.serialize();
    const byId = new Map(before.map((d) => [d.id, d]));
    const found = ids.filter((id) => byId.has(id));
    const skipped = found.filter((id) => byId.get(id)?.locked).length;
    const selIds = found.filter((id) => !byId.get(id)?.locked);
    if (!selIds.length) {
      return { changed: 0, skipped };
    }
    const members = expandGroupMembers(before, selIds);
    let changed = 0;
    const next = expandFrameContents(before).map((d) => {
      if (!d.id || !members.has(d.id) || !d.rough) {
        return d;
      }
      const redrawn = redrawRough(d, d.rough, value);
      if (!redrawn) {
        return d;
      }
      changed++;
      return { ...d, path: redrawn.path, rough: { ...d.rough, roughness: value } };
    });
    if (!changed) {
      return { changed: 0, skipped };
    }
    this.deps.loadElements(next, { worldCoords: true });
    this.deps.pushSnapshot(before);
    this.deps.pushSnapshot(this.deps.serialize());
    return { changed, skipped };
  }

  /** ArrangeAction → 纯函数变换（对齐/分布/翻转；层序走 reorderElements 分支） */
  private arrangeFn(action: ArrangeAction): (els: ElementData[]) => ElementData[] {
    switch (action) {
      case "align-left":
        return (els) => alignElements(els, "left");
      case "align-centerX":
        return (els) => alignElements(els, "centerX");
      case "align-right":
        return (els) => alignElements(els, "right");
      case "align-top":
        return (els) => alignElements(els, "top");
      case "align-centerY":
        return (els) => alignElements(els, "centerY");
      case "align-bottom":
        return (els) => alignElements(els, "bottom");
      case "distribute-h":
        return (els) => distributeElements(els, "horizontal");
      case "distribute-v":
        return (els) => distributeElements(els, "vertical");
      case "flip-h":
      case "flip-v":
        return (els) => {
          const b = unionBounds(els);
          const axis = action === "flip-h" ? "h" : "v";
          return flipElements(els, axis, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
        };
      default:
        // 层序（front/back/forward/backward）不经过此分支
        return (els) => els;
    }
  }

  // ================= 层序重排（用户 toFront/toBack 与 AI 层序共用管线） =================

  /**
   * 层序重排通用管线：序列化 → 锁定过滤 + 组归一化 → reorderElements →
   * 全量重建 → 恢复选中 → 前后快照合并。顺序无变化时（已在目标层）不重建不写历史。
   */
  reorderSelection(mode: ReorderMode) {
    const before = this.deps.serialize();
    const selIds = this.selectedUnlockedIds();
    if (!selIds.length) {
      return;
    }
    const ids = expandGroupMembers(before, selIds);
    const next = reorderElements(before, [...ids], (d) => d.id ?? "", mode);
    if (next.every((d, i) => d === before[i])) {
      return;
    }
    this.deps.loadElements(next);
    this.restoreSelectionByIds([...ids]);
    this.deps.pushSnapshot(before);
    this.deps.pushSnapshot(next);
  }

  /** 当前选中中可操作（未锁定、非编辑器内部）元素的稳定 id */
  private selectedUnlockedIds(): string[] {
    return this.deps
      .selectedList()
      .filter((el) => !el.locked && !this.deps.isEditorInternal(el))
      .map((el) => this.idOf(el));
  }

  /** 按稳定 id 恢复选中（对齐/分布/翻转/层序后保持连续操作上下文） */
  private restoreSelectionByIds(ids: string[]) {
    const restored = this.deps.treeChildren().filter((el) => {
      const id = (el as unknown as { __aiId?: string }).__aiId;
      return !!id && ids.includes(id);
    });
    if (restored.length === 1) {
      this.deps.editorTarget(restored[0]);
    } else if (restored.length > 1) {
      this.deps.editorSelect(restored);
    }
  }

  // ================= AI 协作（元素增改/选区数据） =================

  /** 新增元素（AI 交流模式画流程图等场景），返回分配后的稳定 id；数据非法返回 null */
  addElement(data: ElementData): string | null {
    const el = this.deps.dataToElement({ ...data, id: undefined });
    if (!el) {
      return null;
    }
    this.deps.addToTree(el);
    // AI 创建同样接入框体系：完全落入框架即归属，落在约束框架内即夹紧入框
    this.deps.adoptAndClamp(el);
    return this.idOf(el);
  }

  /** 当前选中元素的序列化数据（含稳定 id），供 AI 面板 @ 选区使用 */
  getSelectionData(): ElementData[] {
    return this.deps
      .selectedList()
      .map((el) => this.deps.elementToData(el))
      .filter((d): d is ElementData => d !== null);
  }

  /** 选区联合包围盒尺寸（状态栏 W×H 展示用）；无选中返回 null */
  getSelectionSize(): { width: number; height: number } | null {
    let box: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;
    for (const el of this.deps.selectedList()) {
      const b = el.worldBoxBounds;
      if (!b) {
        continue;
      }
      box = box
        ? {
            x: Math.min(box.x, b.x),
            y: Math.min(box.y, b.y),
            width: Math.max(box.x + box.width, b.x + b.width) - Math.min(box.x, b.x),
            height: Math.max(box.y + box.height, b.y + b.height) - Math.min(box.y, b.y),
          }
        : { ...b };
    }
    return box ? { width: box.width, height: box.height } : null;
  }

  /**
   * AI 优化：按稳定 id 更新元素属性（颜色/尺寸/位置/旋转/文字等），返回是否成功。
   * 锁定元素不可修改；fill 为 "none" 时转 undefined（leafer 中 "none" 渲染为黑色实心）。
   * 由调用方（AI 面板）负责合并历史快照。
   */
  updateElement(id: string, patch: Partial<ElementData>): boolean {
    const el = this.find(id);
    if (!el || el.locked) {
      return false;
    }
    if (patch.stroke !== undefined) {
      if (isFreehandEl(el)) {
        el.fill = patch.stroke || undefined;
      } else {
        el.stroke = patch.stroke || undefined;
      }
    }
    if (patch.strokeWidth !== undefined) {
      el.strokeWidth = patch.strokeWidth;
    }
    if (patch.fill !== undefined) {
      el.fill = patch.fill === "none" ? undefined : patch.fill;
    }
    if (patch.rotation !== undefined) {
      el.rotation = patch.rotation;
    }
    if (patch.x !== undefined) {
      el.x = patch.x;
    }
    if (patch.y !== undefined) {
      el.y = patch.y;
    }
    if (patch.width !== undefined) {
      el.width = patch.width;
    }
    if (patch.height !== undefined) {
      el.height = patch.height;
    }
    if (patch.text !== undefined && el instanceof Text) {
      el.text = patch.text;
    }
    if (patch.fontSize !== undefined && el instanceof Text) {
      el.fontSize = patch.fontSize;
    }
    if (patch.textAlign !== undefined && el instanceof Text) {
      el.textAlign = patch.textAlign;
      el.autoSizeAlign = patch.textAlign === "left" ? undefined : true;
    }
    if (patch.fontFamily !== undefined && el instanceof Text) {
      el.fontFamily = patch.fontFamily;
    }
    if (patch.fontWeight !== undefined && el instanceof Text) {
      el.fontWeight = patch.fontWeight;
    }
    if (patch.startArrow !== undefined && el instanceof Line) {
      el.startArrow = toLeaferArrow(patch.startArrow);
    }
    if (patch.endArrow !== undefined && el instanceof Line) {
      el.endArrow = toLeaferArrow(patch.endArrow);
    }
    if (patch.points !== undefined && el instanceof Line) {
      // AI 传入画布绝对坐标（describeCanvas 输出基准），换算回元素局部坐标
      el.points = (patch.points as { x: number; y: number }[]).map((p) =>
        canvasToLocal(el as unknown as CoordBox, p),
      );
    }
    if (patch.path !== undefined && el instanceof Path) {
      el.path = patch.path;
    }
    if ("strokeDash" in patch) {
      (el as unknown as { dashPattern?: number[] }).dashPattern = patch.strokeDash;
    }
    if (patch.opacity !== undefined) {
      el.opacity = patch.opacity;
    }
    if (patch.cornerRadius !== undefined) {
      el.cornerRadius = patch.cornerRadius;
    }
    this.deps.onMutated();
    return true;
  }
}
