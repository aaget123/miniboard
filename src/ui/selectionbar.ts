import { SWATCHES } from "./toolbar";
import type { SelectionInfo } from "../board/canvas";

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
  icon: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "tool-btn sel-btn";
  btn.title = title;
  btn.textContent = icon;
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
  private colorInput!: HTMLInputElement;
  private widthInput!: HTMLInputElement;
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
    handlers: SelectionBarHandlers,
  ) {
    this.bar = document.createElement("div");
    this.bar.id = "selection-bar";
    this.bar.hidden = true;

    this.beautifyBtn = makeButton(
      "✨",
      "整理选中：识别手绘笔迹并完善为标准图形/拉直",
      () => handlers.onBeautify(),
    );
    this.sketchifyBtn = makeButton(
      "✎",
      "手绘风格：选中图形转手绘外观（rough.js）",
      () => handlers.onSketchify(),
    );
    this.cropBtn = makeButton(
      "✂",
      "裁剪图片：拖动手柄调整区域，松手即应用",
      () => handlers.onCrop(),
    );
    this.sep = document.createElement("div");
    this.sep.className = "tool-sep";
    this.styleBtn = makeButton("🎨", "样式：描边/填充颜色与粗细", () =>
      this.togglePopover(),
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

    const row = document.createElement("div");
    row.className = "style-row";
    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.value = "#4f8cff";
    this.colorInput.title = "自定义颜色";
    this.colorInput.addEventListener("input", () => {
      if (this.activeChannel === "fill") {
        handlers.onFillColorChange(this.colorInput.value);
      } else {
        handlers.onStrokeChange(this.colorInput.value);
      }
    });
    const widthLabel = document.createElement("span");
    widthLabel.className = "panel-label";
    widthLabel.textContent = "粗细";
    this.widthInput = document.createElement("input");
    this.widthInput.type = "range";
    this.widthInput.min = "1";
    this.widthInput.max = "12";
    this.widthInput.step = "1";
    this.widthInput.value = "2";
    this.widthInput.addEventListener("input", () =>
      handlers.onWidthChange(Number(this.widthInput.value)),
    );
    row.append(this.colorInput, widthLabel, this.widthInput);
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
   */
  show(info: SelectionInfo | null, toolActive: boolean) {
    const visible =
      !!info && info.ids.length > 0 && toolActive && !info.allLocked;
    this.setBarVisible(visible);
    if (!visible) {
      this.hidePopover();
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

  private togglePopover() {
    if (this.popover.classList.contains("visible")) {
      this.hidePopover();
      return;
    }
    this.popover.hidden = false;
    const r = this.bar.getBoundingClientRect();
    this.popover.style.left = `${r.left + r.width + 8}px`;
    this.popover.style.top = `${r.top}px`;
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
