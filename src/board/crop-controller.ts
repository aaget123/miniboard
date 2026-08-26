import { Image, Rect } from "leafer-ui";
import type { App, UI } from "leafer-ui";

/**
 * 图片裁剪控制器：从 Board 拆出的独立交互模块。
 * 选中单张未旋转图片时进入裁剪——sky 层裁剪框 + 8 方向手柄，
 * 拖动手柄调整裁剪区域，松手即应用（leafer 无 clip 能力，
 * 用 canvas 2D 按裁剪区域裁出新图替换 url）。
 */

// 裁剪框的最小尺寸（元素局部坐标）
const CROP_MIN = 8;
// 裁剪框/手柄描边颜色（画在 sky 层，不随缩放变化，与框选草稿同色系）
const CROP_STROKE = "#4f8cff";

export type CropDeps = {
  /** leafer App（裁剪 UI 画在 sky 层） */
  app: App;
  /** 取消编辑器选择 */
  editorCancel: () => void;
  /** 应用裁剪后重新选中被裁图片 */
  setEditorTarget: (el: UI) => void;
  /** 当前选中元素列表 */
  selectedList: () => UI[];
  /** 进入裁剪前先退出点编辑 */
  exitPointEdit: () => void;
  /** 读取图片自然尺寸（显示尺寸 → 像素坐标换算用） */
  imageSize: (url: string) => Promise<{ width: number; height: number } | null>;
  /** 裁剪应用后提交撤销历史 */
  commitHistory: () => void;
  /** 元素变更回调（自动保存等） */
  onMutated: () => void;
};

type CropRect = { x: number; y: number; width: number; height: number };

export class CropController {
  private el: Image | null = null;
  private rect: CropRect | null = null;
  private handles: Rect[] = [];
  private dragDir: string | null = null;
  private dragged = false;

  constructor(private readonly deps: CropDeps) {}

  /** 是否处于裁剪模式 */
  get active(): boolean {
    return this.el !== null;
  }

  /** 进入图片裁剪：仅当选中单张未锁定且未旋转的图片 */
  start(): boolean {
    const list = this.deps.selectedList();
    if (list.length !== 1 || !(list[0] instanceof Image)) {
      return false;
    }
    const img = list[0] as Image;
    if (img.locked || (img.rotation ?? 0) !== 0) {
      return false;
    }
    this.deps.exitPointEdit();
    this.deps.editorCancel();
    this.el = img;
    this.rect = { x: 0, y: 0, width: img.width ?? 0, height: img.height ?? 0 };
    this.dragDir = null;
    this.dragged = false;
    this.rebuild();
    return true;
  }

  /** 取消裁剪：清除裁剪 UI，不应用修改 */
  cancel() {
    this.el = null;
    this.rect = null;
    this.dragDir = null;
    this.dragged = false;
    for (const h of this.handles) {
      h.remove();
    }
    this.handles = [];
  }

  /** 重建裁剪框与 8 方向手柄（sky 层，图片局部坐标 → 世界坐标摆放；缩放/平移后调用） */
  rebuild() {
    const img = this.el;
    const r = this.rect;
    if (!img || !r) {
      return;
    }
    for (const h of this.handles) {
      h.remove();
    }
    this.handles = [];
    const tl = img.getWorldPoint({ x: r.x, y: r.y });
    const tr = img.getWorldPoint({ x: r.x + r.width, y: r.y });
    const bl = img.getWorldPoint({ x: r.x, y: r.y + r.height });
    const br = img.getWorldPoint({ x: r.x + r.width, y: r.y + r.height });
    const box = {
      x: Math.min(tl.x, tr.x, bl.x, br.x),
      y: Math.min(tl.y, tr.y, bl.y, br.y),
      width: Math.max(tl.x, tr.x, bl.x, br.x) - Math.min(tl.x, tr.x, bl.x, br.x),
      height:
        Math.max(tl.y, tr.y, bl.y, br.y) - Math.min(tl.y, tr.y, bl.y, br.y),
    };
    // 裁剪框（index 0 为框体，非手柄）
    const frame = new Rect({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      stroke: CROP_STROKE,
      strokeWidth: 1.5,
      fill: "rgba(79, 140, 255, 0.06)",
      dashPattern: [4, 4],
    });
    this.handles.push(frame);
    this.deps.app.sky.add(frame);
    const SIZE = 9;
    for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const pos = cropHandlePos(dir, box);
      const h = new Rect({
        x: pos.x - SIZE / 2,
        y: pos.y - SIZE / 2,
        width: SIZE,
        height: SIZE,
        fill: "#ffffff",
        stroke: CROP_STROKE,
        strokeWidth: 1,
      });
      (h as unknown as Record<string, unknown>).__dir = dir;
      this.handles.push(h);
      this.deps.app.sky.add(h);
    }
  }

  /** 裁剪中按下：命中手柄开始调整；未命中（含点击框内空白）取消裁剪 */
  handleDown(ax: number, ay: number) {
    // index 0 是裁剪框体，从 1 开始才是可拖手柄
    for (let i = 1; i < this.handles.length; i++) {
      const b = this.handles[i].worldBoxBounds;
      if (
        b &&
        ax >= b.x - 4 &&
        ax <= b.x + b.width + 4 &&
        ay >= b.y - 4 &&
        ay <= b.y + b.height + 4
      ) {
        this.dragDir =
          (this.handles[i] as unknown as { __dir?: string }).__dir ?? null;
        this.dragged = false;
        return;
      }
    }
    this.cancel();
  }

  /**
   * 拖动中：调整裁剪区域（指针世界坐标 → 图片局部坐标，clamp 在图片内）。
   * 非拖动状态返回 false，调用方据此走其他分支。
   */
  handleMove(ax: number, ay: number): boolean {
    if (!this.el || !this.dragDir) {
      return false;
    }
    this.dragged = true;
    const img = this.el;
    const r = this.rect;
    const dir = this.dragDir;
    if (!r || !dir) {
      return true;
    }
    const p = img.getLocalPoint({ x: ax, y: ay });
    const W = img.width ?? 1;
    const H = img.height ?? 1;
    let { x, y, width, height } = r;
    if (dir.includes("n")) {
      const ny = Math.min(p.y, y + height - CROP_MIN);
      height = y + height - Math.max(0, ny);
      y = Math.max(0, ny);
    }
    if (dir.includes("s")) {
      height = Math.max(CROP_MIN, Math.min(p.y, H) - y);
    }
    if (dir.includes("w")) {
      const nx = Math.min(p.x, x + width - CROP_MIN);
      width = x + width - Math.max(0, nx);
      x = Math.max(0, nx);
    }
    if (dir.includes("e")) {
      width = Math.max(CROP_MIN, Math.min(p.x, W) - x);
    }
    this.rect = { x, y, width, height };
    this.rebuild();
    return true;
  }

  /**
   * 松手：有实际拖动则异步应用裁剪。
   * 返回是否处理了本次抬起（处于拖动中），调用方据此短路后续流程。
   */
  handleUp(): boolean {
    if (!this.el || !this.dragDir) {
      return false;
    }
    this.dragDir = null;
    if (this.dragged) {
      void this.apply();
    }
    return true;
  }

  /**
   * 应用裁剪：canvas 2D 按裁剪区域裁出新图替换 url，
   * 图片元素位置偏移到裁剪框左上角、宽高收窄为裁剪区域。
   */
  private async apply() {
    const img = this.el;
    const r = this.rect;
    if (!img || !r) {
      this.cancel();
      return;
    }
    const url = (img as unknown as { url?: unknown }).url as string | undefined;
    const natural = url ? await this.deps.imageSize(url) : null;
    if (!url || !natural) {
      this.cancel();
      return;
    }
    // 元素局部坐标 → 图片像素坐标（按显示尺寸与自然尺寸的比例换算）
    const iw = img.width ?? 1;
    const ih = img.height ?? 1;
    const sx = Math.max(0, Math.round((r.x / iw) * natural.width));
    const sy = Math.max(0, Math.round((r.y / ih) * natural.height));
    const sw = Math.max(1, Math.round((r.width / iw) * natural.width));
    const sh = Math.max(1, Math.round((r.height / ih) * natural.height));
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this.cancel();
      return;
    }
    const source = new window.Image();
    await new Promise<void>((resolve, reject) => {
      source.onload = () => resolve();
      source.onerror = () => reject(new Error("图片加载失败"));
      source.src = url;
    }).catch(() => undefined);
    if (!source.naturalWidth) {
      this.cancel();
      return;
    }
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    const newUrl = canvas.toDataURL("image/png");
    // 裁剪区域（元素局部坐标）→ 元素位置偏移与尺寸收窄（start 已排除旋转）
    img.x = (img.x ?? 0) + r.x;
    img.y = (img.y ?? 0) + r.y;
    img.width = r.width;
    img.height = r.height;
    (img as unknown as { url?: string }).url = newUrl;
    this.cancel();
    this.deps.setEditorTarget(img);
    this.deps.commitHistory();
    this.deps.onMutated();
  }
}

/** 8 方向手柄在裁剪框上的锚点位置（世界坐标） */
function cropHandlePos(
  dir: string,
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  switch (dir) {
    case "nw":
      return { x: box.x, y: box.y };
    case "n":
      return { x: box.x + box.width / 2, y: box.y };
    case "ne":
      return { x: box.x + box.width, y: box.y };
    case "e":
      return { x: box.x + box.width, y: box.y + box.height / 2 };
    case "se":
      return { x: box.x + box.width, y: box.y + box.height };
    case "s":
      return { x: box.x + box.width / 2, y: box.y + box.height };
    case "sw":
      return { x: box.x, y: box.y + box.height };
    case "w":
      return { x: box.x, y: box.y + box.height / 2 };
  }
  return { x: box.x, y: box.y };
}
