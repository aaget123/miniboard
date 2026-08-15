import { SWATCHES, renderToolIcon } from "./toolbar";
import type { IconName } from "./icons";
import type { SelectionInfo } from "../board/canvas";

/** 最近使用颜色（本地记忆，最多 4 个，追加在色板尾部） */
const RECENT_KEY = "miniboard:recent-colors";
const MAX_RECENT = 4;

export type SelectionBarHandlers = {
  /** 局部整理：识别选中手绘笔迹并完善为标准图形/拉直 */
  onBeautify: () => void;
  /** 手绘风格：选中标准图形转 rough.js 手绘外观 */
  onSketchify: () => void;
  /** 图片裁剪：选中单张图片时进入裁剪模式 */
  onCrop: () => void;
  onStrokeChange: (color: string) => void;
  onFillColorChange: (color: string) => void;
  onWidthChange: (width: number) => void;
  /** 字号变化（仅选中文字时） */
  onFontSizeChange: (size: number) => void;
};

function makeButton(
  icon: IconName,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "tool-btn sel-btn";
  btn.title = title;
  renderToolIcon(btn, icon);
  btn.addEventListener("click", onClick);
  return btn;
}

/** 显隐过渡时长（与 style.css 中 transition 时长一致，隐藏时延迟置 hidden） */
const FADE_MS = 180;

/**
 * 左侧悬浮工具栏：选中元素时出现（Excalidraw 同款）。
 * 类型感知差异化显示（对齐 Excalidraw showSelectedShapeActions）：
 * - ✨ 整理：仅选中含手绘笔迹时显示
 * - ✎ 手绘：仅选中含可手绘化标准图形时显示
 * - ✂ 裁剪：仅单选一张图片时显示
 * - 🎨 样式：选中含可编辑元素（非纯图片）时显示
 * 非 select 工具 / 文本内联编辑中整体隐藏；全锁定选中同样隐藏。
 */
export class SelectionBar {
  private bar: HTMLElement;
  private popover: HTMLElement;
  // 描边/填充双通道：色板与取色器作用于激活通道
  private activeChannel: "stroke" | "fill" = "stroke";
  private strokeChannelBtn!: HTMLButtonElement;
  private fillChannelBtn!: HTMLButtonElement;
  private strokeChannelColor = "#4f8cff";
  private fillChannelColor = "#4f8cff";
  private swatches = new Map<string, HTMLDivElement>();
  // 最近使用颜色（追加在基础色板之后）
  private recentSwatches = new Map<string, HTMLDivElement>();
  private recentRow!: HTMLElement;
  private colorInput!: HTMLInputElement;
  private widthInput!: HTMLInputElement;
  private widthValue!: HTMLSpanElement;
  // 差异化显隐的按钮引用
  private beautifyBtn!: HTMLButtonElement;
  private sketchifyBtn!: HTMLButtonElement;
  private cropBtn!: HTMLButtonElement;
  private styleBtn!: HTMLButtonElement;
  private sep!: HTMLElement;
  // 字号行（仅选中文字时显示）
  private fontRow!: HTMLElement;
  private fontSizeInput!: HTMLInputElement;
  private fontSizeLabel!: HTMLSpanElement;
  // 两段式显隐：先切 hidden 保证 transition 播放，延时后再真正隐藏
  private hideTimer = 0;
  private popoverHideTimer = 0;

  constructor(
    container: HTMLElement,
    private handlers: SelectionBarHandlers,
  ) {
    this.bar = document.createElement("div");
    this.bar.id = "selection-bar";
    this.bar.hidden = true;

    this.beautifyBtn = makeButton(
      "sparkle",
      "整理选中：识别手绘笔迹并完善为标准图形/拉直",
      () => handlers.onBeautify(),
    );
    this.sketchifyBtn = makeButton(
      "scribble",
      "手绘风格：选中图形转手绘外观（rough.js）",
      () => handlers.onSketchify(),
    );
    this.cropBtn = makeButton(
      "crop",
      "裁剪图片：拖动手柄调整区域，松手即应用",
      () => handlers.onCrop(),
    );
    this.sep = document.createElement("div");
    this.sep.className = "tool-sep";
    this.styleBtn = makeButton("sliders", "样式：描边/填充颜色与粗细", () =>
      this.toggleStyle(this.bar.getBoundingClientRect()),
    );
    this.bar.append(
      this.beautifyBtn,
      this.sketchifyBtn,
      this.cropBtn,
      this.sep,
      this.styleBtn,
    );
    container.appendChild(this.bar);

    // ---- 样式浮层（色板 + 取色器 + 粗细）----
    this.popover = document.createElement("div");
    this.popover.id = "style-popover";
    this.popover.hidden = true;

    const channelGroup = document.createElement("div");
    channelGroup.className = "channel-group";
    this.strokeChannelBtn = this.makeChannelBtn("描边", () =>
      this.setChannel("stroke"),
    );
    this.fillChannelBtn = this.makeChannelBtn("填充", () =>
      this.setChannel("fill"),
    );
    channelGroup.append(this.strokeChannelBtn, this.fillChannelBtn);
    this.popover.appendChild(channelGroup);

    const swatches = document.createElement("div");
    swatches.className = "swatches";
    for (const c of SWATCHES) {
      const s = document.createElement("div");
      s.className = "swatch";
      s.style.background = c;
      s.title = c;
      s.addEventListener("click", () => {
        if (this.activeChannel === "fill") {
          handlers.onFillColorChange(c);
        } else {
          handlers.onStrokeChange(c);
        }
      });
      swatches.appendChild(s);
      this.swatches.set(c, s);
    }
    this.popover.appendChild(swatches);

    // 最近使用颜色行（取色器选中的非基础色，本地记忆）
    this.recentRow = document.createElement("div");
    this.recentRow.className = "recent-row";
    this.recentRow.hidden = true;
    const recentLabel = document.createElement("span");
    recentLabel.className = "panel-label";
    recentLabel.textContent = "最近";
    const recentSwatches = document.createElement("div");
    recentSwatches.className = "swatches";
    this.recentRow.append(recentLabel, recentSwatches);
    this.popover.appendChild(this.recentRow);
    this.refreshRecent();

    const row = document.createElement("div");
    row.className = "style-row";
    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.value = "#4f8cff";
    this.colorInput.title = "自定义颜色";
    this.colorInput.addEventListener("input", () => {
      const c = this.colorInput.value.toLowerCase();
      if (this.activeChannel === "fill") {
        handlers.onFillColorChange(c);
      } else {
        handlers.onStrokeChange(c);
      }
      // 非基础色板颜色记入“最近”（跳过纯黑/纯白等基础色，避免重复）
      if (!SWATCHES.some((s) => s.toLowerCase() === c)) {
        this.recordRecent(c);
      }
    });
    const widthLabel = document.createElement("span");
    widthLabel.className = "panel-label";
    widthLabel.textContent = "粗细";
    this.widthInput = document.createElement("input");
    this.widthInput.type = "range";
    this.widthInput.min = "1";
    this.widthInput.max = "40";
    this.widthInput.step = "1";
    this.widthInput.value = "2";
    this.widthInput.addEventListener("input", () => {
      this.widthValue.textContent = this.widthInput.value;
      handlers.onWidthChange(Number(this.widthInput.value));
    });
    this.widthValue = document.createElement("span");
    this.widthValue.className = "width-value";
    this.widthValue.textContent = this.widthInput.value;
    row.append(this.colorInput, widthLabel, this.widthInput, this.widthValue);
    this.popover.appendChild(row);

    // 字号行：选中单个/多个文字时显示，拖动即改选中文字大小
    this.fontRow = document.createElement("div");
    this.fontRow.className = "style-row font-row";
    this.fontRow.hidden = true;
    const fontLabel = document.createElement("span");
    fontLabel.className = "panel-label";
    fontLabel.textContent = "字号";
    this.fontSizeInput = document.createElement("input");
    this.fontSizeInput.type = "range";
    this.fontSizeInput.min = "10";
    this.fontSizeInput.max = "72";
    this.fontSizeInput.step = "1";
    this.fontSizeInput.value = "18";
    this.fontSizeInput.addEventListener("input", () => {
      const v = Number(this.fontSizeInput.value);
      this.fontSizeLabel.textContent = String(v);
      handlers.onFontSizeChange(v);
    });
    this.fontSizeLabel = document.createElement("span");
    this.fontSizeLabel.className = "font-size-value";
    this.fontSizeLabel.textContent = this.fontSizeInput.value;
    this.fontRow.append(fontLabel, this.fontSizeInput, this.fontSizeLabel);
    this.popover.appendChild(this.fontRow);
    document.body.appendChild(this.popover);

    // 点击浮层外部关闭（ESC/失焦由 main.ts 互斥管理统一兜底，此处补充失焦）
    document.addEventListener("pointerdown", (e) => {
      if (this.popover.hidden) {
        return;
      }
      if (
        !this.popover.contains(e.target as Node) &&
        e.target !== this.styleBtn
      ) {
        this.hidePopover();
      }
    });
    window.addEventListener("blur", () => this.hidePopover());

    this.setChannel("stroke");
  }

  /**
   * 选中变化：类型感知的差异化显隐（对齐 Excalidraw showSelectedShapeActions）。
   * toolActive：当前工具为 select 且不在文本内联编辑中（非 select 工具/编辑中整体隐藏）。
   * penMode：画笔（freehand）工具激活时也显示左侧栏——无选中时只保留样式按钮，
   * 用于设置新笔迹的默认颜色/粗细（与选中元素时的“作用于选中”语义一致）。
   */
  show(info: SelectionInfo | null, toolActive: boolean, penMode = false) {
    const hasSelection = !!info && info.ids.length > 0;
    const visible =
      (penMode || hasSelection) && toolActive && !(info && info.allLocked);
    this.setBarVisible(visible);
    if (!visible) {
      this.hidePopover();
      return;
    }
    if (penMode && !hasSelection) {
      // 画笔预设置：只显示样式按钮（颜色/粗细作用于新笔迹）
      this.beautifyBtn.style.display = "none";
      this.sketchifyBtn.style.display = "none";
      this.cropBtn.style.display = "none";
      this.sep.style.display = "";
      this.styleBtn.style.display = "";
      this.fontRow.hidden = true;
      return;
    }
    const info2 = info!;
    // 按钮差异化：✨ 仅手绘笔迹、✎ 仅可手绘图形、✂ 仅单选图片、🎨 有可编辑元素
    const singleImage =
      info2.types.length === 1 && info2.types[0] === "image";
    const hasEditable = info2.types.some((t) => t !== "image");
    this.beautifyBtn.style.display = info2.hasFreehand ? "" : "none";
    this.sketchifyBtn.style.display = info2.hasSketchable ? "" : "none";
    this.cropBtn.style.display = singleImage ? "" : "none";
    this.styleBtn.style.display = hasEditable ? "" : "none";
    this.sep.style.display = hasEditable ? "" : "none";
    this.fontRow.hidden = !info2.hasText;
    if (info2.hasText && info2.fontSize !== undefined) {
      this.setFontSize(info2.fontSize);
    }
  }

  /** 两段式显隐：先切 hidden 保证 transition 播放，延时后再真正隐藏 */
  private setBarVisible(visible: boolean) {
    clearTimeout(this.hideTimer);
    if (visible) {
      this.bar.hidden = false;
      // 双帧延迟：hidden 移除后下一帧再加 visible，确保 transition 从初始态播放
      requestAnimationFrame(() =>
        requestAnimationFrame(() => this.bar.classList.add("visible")),
      );
    } else {
      this.bar.classList.remove("visible");
      this.hideTimer = window.setTimeout(() => {
        this.bar.hidden = true;
      }, FADE_MS);
    }
  }

  /**
   * 开关样式浮层（左侧栏 🎨 与顶栏默认样式入口共用）。
   * 锚点在上半屏（顶栏）时显示在锚点下方居中；否则（左侧栏）显示在锚点右侧。
   */
  toggleStyle(anchor: DOMRect) {
    if (this.popover.classList.contains("visible")) {
      this.hidePopover();
      return;
    }
    this.popover.hidden = false;
    const pw = this.popover.offsetWidth || 200;
    const ph = this.popover.offsetHeight || 140;
    const fromTop = anchor.top < window.innerHeight * 0.45;
    let left: number;
    let top: number;
    if (fromTop) {
      left = Math.min(
        Math.max(8, anchor.left + anchor.width / 2 - pw / 2),
        window.innerWidth - pw - 8,
      );
      top = anchor.bottom + 8;
    } else {
      left = anchor.left + anchor.width + 8;
      top = anchor.top;
    }
    // 底部越界修正（窗口过矮时上移，避免浮层超出视口）
    if (top + ph > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - ph - 8);
    }
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => this.popover.classList.add("visible")),
    );
  }

  /** 收起样式浮层（main.ts 互斥管理 closeAllFloating 调用） */
  hidePopover() {
    this.popover.classList.remove("visible");
    clearTimeout(this.popoverHideTimer);
    this.popoverHideTimer = window.setTimeout(() => {
      this.popover.hidden = true;
    }, FADE_MS);
  }

  setStroke(color: string) {
    this.strokeChannelColor = color;
    this.strokeChannelBtn.querySelector<HTMLElement>(".channel-chip")!.style.background = color;
    if (this.activeChannel === "stroke") {
      this.setActiveColor(color);
    }
  }

  /** 更新填充通道颜色（仅激活填充通道时同步色板高亮） */
  setFillColor(color: string) {
    this.fillChannelColor = color;
    this.fillChannelBtn.querySelector<HTMLElement>(".channel-chip")!.style.background = color;
    if (this.activeChannel === "fill") {
      this.setActiveColor(color);
    }
  }

  setWidth(width: number) {
    this.widthInput.value = String(width);
    this.widthValue.textContent = String(width);
  }

  setFontSize(size: number) {
    this.fontSizeInput.value = String(size);
    this.fontSizeLabel.textContent = String(size);
  }

  private setChannel(channel: "stroke" | "fill") {
    this.activeChannel = channel;
    this.strokeChannelBtn.classList.toggle("active", channel === "stroke");
    this.fillChannelBtn.classList.toggle("active", channel === "fill");
    // 切换后色板高亮与取色器跟随当前通道颜色
    this.setActiveColor(
      channel === "stroke" ? this.strokeChannelColor : this.fillChannelColor,
    );
  }

  // ---------- 最近使用颜色 ----------

  /** 读取最近颜色（localStorage，损坏时返回空） */
  private loadRecent(): string[] {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list)
        ? list.filter((c): c is string => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, MAX_RECENT)
        : [];
    } catch {
      return [];
    }
  }

  /** 记录最近颜色（去重，最新在前）并刷新行 */
  private recordRecent(color: string) {
    const c = color.toLowerCase();
    const list = this.loadRecent().filter((x) => x !== c);
    list.unshift(c);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    } catch {
      // localStorage 不可用时仅本次会话生效
    }
    this.refreshRecent();
  }

  /** 重建最近颜色行（点击行为与基础色板一致，作用于激活通道） */
  private refreshRecent() {
    const list = this.loadRecent();
    const wrap = this.recentRow.querySelector<HTMLDivElement>(".swatches");
    if (!wrap) {
      return;
    }
    wrap.innerHTML = "";
    this.recentSwatches.clear();
    this.recentRow.hidden = list.length === 0;
    for (const c of list) {
      const s = document.createElement("div");
      s.className = "swatch";
      s.style.background = c;
      s.title = c;
      s.addEventListener("click", () => {
        if (this.activeChannel === "fill") {
          this.handlers.onFillColorChange(c);
        } else {
          this.handlers.onStrokeChange(c);
        }
      });
      wrap.appendChild(s);
      this.recentSwatches.set(c, s);
    }
  }

  private setActiveColor(color: string) {
    for (const [c, el] of this.swatches) {
      el.classList.toggle("active", c.toLowerCase() === color.toLowerCase());
    }
    this.colorInput.value = color;
  }

  private makeChannelBtn(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "channel-btn";
    btn.title = `${label}颜色：色板点击作用于${label}色`;
    const chip = document.createElement("span");
    chip.className = "channel-chip";
    chip.style.background = "#4f8cff";
    btn.append(chip, document.createTextNode(label));
    btn.addEventListener("click", onClick);
    return btn;
  }
}
