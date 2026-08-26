import { SWATCHES, renderToolIcon } from "./toolbar";
import { iconHTML } from "./icons";
import type { IconName } from "./icons";
import type { SelectionInfo } from "../board/canvas";
import type { ArrowHead } from "../types";

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
  /** 橡皮半径变化（橡皮模式滑条拖动） */
  onEraserRadiusChange: (radiusPx: number) => void;
  /** 字号变化（仅选中文字时） */
  onFontSizeChange: (size: number) => void;
  // ---- 文本排版扩展：对齐/字重/字体（仅选中文字时生效） ----
  /** 水平对齐变化 */
  onTextAlignChange: (align: "left" | "center" | "right") => void;
  /** 字重变化（100-900） */
  onFontWeightChange: (weight: number) => void;
  /** 字体族变化（空串 = 默认字体） */
  onFontFamilyChange: (family: string) => void;
  // ---- 箭头端点：起点/终点样式（仅单选 line/arrow 时生效） ----
  /** 端点样式变化（end 为 "start" 起点 / "end" 终点） */
  onArrowHeadChange: (end: "start" | "end", head: ArrowHead) => void;
  // ---- P3 样式扩展：线型/透明度/圆角（仅作用于选中，不进默认样式） ----
  /** 线型变化（undefined = 实线；虚线/点线为 leafer dashPattern 参数） */
  onStrokeDashChange: (dash: number[] | undefined) => void;
  /** 透明度变化（0-1） */
  onOpacityChange: (opacity: number) => void;
  /** 圆角变化（0-100，仅单选 rect） */
  onCornerRadiusChange: (radius: number) => void;
  /** 粗糙度变化（0-2，仅作用于已手绘元素，同一 seed 重绘） */
  onRoughnessChange: (roughness: number) => void;
};

function makeButton(icon: IconName, title: string, onClick: () => void): HTMLButtonElement {
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
  // 描边粗细行（纯文字选中时隐藏：文字粗细走字重，描边粗细对文字无效）
  private widthRow!: HTMLElement;
  private colorInput!: HTMLInputElement;
  private widthInput!: HTMLInputElement;
  private widthValue!: HTMLSpanElement;
  // 差异化显隐的按钮引用
  private beautifyBtn!: HTMLButtonElement;
  private sketchifyBtn!: HTMLButtonElement;
  private cropBtn!: HTMLButtonElement;
  private styleBtn!: HTMLButtonElement;
  // 橡皮模式行（半径滑条）
  private eraserRow!: HTMLDivElement;
  private eraserInput!: HTMLInputElement;
  private eraserValue!: HTMLSpanElement;
  private sep!: HTMLElement;
  // 字号行（仅选中文字时显示）
  private fontRow!: HTMLElement;
  private fontSizeInput!: HTMLInputElement;
  private fontSizeLabel!: HTMLSpanElement;
  // 文本排版扩展行：对齐（左/中/右）、字重滑条、字体下拉
  private alignRow!: HTMLElement;
  private alignBtns: HTMLButtonElement[] = [];
  private weightRow!: HTMLElement;
  private weightInput!: HTMLInputElement;
  private weightValue!: HTMLSpanElement;
  private fontFamilyRow!: HTMLElement;
  private fontFamilySelect!: HTMLSelectElement;
  // 箭头端点行：起点/终点两组按钮（仅单选 line/arrow 时显示）
  private arrowRow!: HTMLElement;
  private startArrowBtns: HTMLButtonElement[] = [];
  private endArrowBtns: HTMLButtonElement[] = [];
  // P3 样式扩展行：线型（实线/虚线/点线）与透明度/圆角滑条
  private dashRow!: HTMLElement;
  private dashBtns: HTMLButtonElement[] = [];
  private opacityRow!: HTMLElement;
  private opacityInput!: HTMLInputElement;
  private opacityValue!: HTMLSpanElement;
  private cornerRow!: HTMLElement;
  private cornerInput!: HTMLInputElement;
  private cornerValue!: HTMLSpanElement;
  // 粗糙度行（选中含已手绘元素时显示，0-2 滑条）
  private roughRow!: HTMLElement;
  private roughInput!: HTMLInputElement;
  private roughValue!: HTMLSpanElement;
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

    this.beautifyBtn = makeButton("sparkle", "整理选中：识别手绘笔迹并完善为标准图形/拉直", () =>
      handlers.onBeautify(),
    );
    this.sketchifyBtn = makeButton("scribble", "手绘风格：选中图形转手绘外观（rough.js）", () =>
      handlers.onSketchify(),
    );
    this.cropBtn = makeButton("crop", "裁剪图片：拖动手柄调整区域，松手即应用", () =>
      handlers.onCrop(),
    );
    this.sep = document.createElement("div");
    this.sep.className = "tool-sep";
    this.styleBtn = makeButton("sliders", "样式：描边/填充颜色与粗细", () =>
      this.toggleStyle(this.bar.getBoundingClientRect()),
    );
    this.bar.append(this.beautifyBtn, this.sketchifyBtn, this.cropBtn, this.sep, this.styleBtn);
    container.appendChild(this.bar);

    // ---- 橡皮模式行：半径滑条（直接挂在栏上，非样式浮层内）----
    this.eraserRow = document.createElement("div");
    this.eraserRow.className = "style-row sb-eraser-row";
    this.eraserRow.hidden = true;
    const eraserLabel = document.createElement("span");
    eraserLabel.className = "panel-label";
    eraserLabel.textContent = "半径";
    this.eraserInput = document.createElement("input");
    this.eraserInput.type = "range";
    this.eraserInput.min = "2";
    this.eraserInput.max = "80";
    this.eraserInput.step = "1";
    this.eraserInput.value = "10";
    this.eraserInput.addEventListener("input", () => {
      this.eraserValue.textContent = this.eraserInput.value;
      handlers.onEraserRadiusChange(Number(this.eraserInput.value));
    });
    this.eraserValue = document.createElement("span");
    this.eraserValue.className = "width-value";
    this.eraserValue.textContent = this.eraserInput.value;
    this.eraserRow.append(eraserLabel, this.eraserInput, this.eraserValue);
    this.bar.appendChild(this.eraserRow);

    // ---- 样式浮层（色板 + 取色器 + 粗细）----
    this.popover = document.createElement("div");
    this.popover.id = "style-popover";
    this.popover.hidden = true;

    const channelGroup = document.createElement("div");
    channelGroup.className = "channel-group";
    this.strokeChannelBtn = this.makeChannelBtn("描边", () => this.setChannel("stroke"));
    this.fillChannelBtn = this.makeChannelBtn("填充", () => this.setChannel("fill"));
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
    this.widthRow = row;
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

    // 文本排版扩展：对齐（左/中/右）
    this.alignRow = document.createElement("div");
    this.alignRow.className = "style-row";
    this.alignRow.hidden = true;
    const alignLabel = document.createElement("span");
    alignLabel.className = "panel-label";
    alignLabel.textContent = "对齐";
    const alignGroup = document.createElement("div");
    alignGroup.className = "dash-group";
    const alignOptions: [IconName, string, "left" | "center" | "right"][] = [
      ["textAlignLeft", "左对齐", "left"],
      ["textAlignCenter", "居中", "center"],
      ["textAlignRight", "右对齐", "right"],
    ];
    for (const [icon, tip, align] of alignOptions) {
      const b = this.makeIconBtn(icon, tip, () => handlers.onTextAlignChange(align));
      b.classList.add("align-btn");
      this.alignBtns.push(b);
      alignGroup.appendChild(b);
    }
    this.alignRow.append(alignLabel, alignGroup);
    this.popover.appendChild(this.alignRow);

    // 字重行：滑条 100-900（step 100），拖动即改选中文字字重；Ctrl+B 快捷切换 400↔700
    this.weightRow = document.createElement("div");
    this.weightRow.className = "style-row";
    this.weightRow.hidden = true;
    const weightLabel = document.createElement("span");
    weightLabel.className = "panel-label";
    weightLabel.textContent = "字重";
    this.weightInput = document.createElement("input");
    this.weightInput.type = "range";
    this.weightInput.min = "100";
    this.weightInput.max = "900";
    this.weightInput.step = "100";
    this.weightInput.value = "400";
    this.weightInput.addEventListener("input", () => {
      const v = Number(this.weightInput.value);
      this.weightValue.textContent = String(v);
      handlers.onFontWeightChange(v);
    });
    this.weightValue = document.createElement("span");
    this.weightValue.className = "font-size-value";
    this.weightValue.textContent = "400";
    this.weightRow.append(weightLabel, this.weightInput, this.weightValue);
    this.popover.appendChild(this.weightRow);

    // 字体行：下拉（默认/常用中文字体/西文字体）
    this.fontFamilyRow = document.createElement("div");
    this.fontFamilyRow.className = "style-row";
    this.fontFamilyRow.hidden = true;
    const fontFamilyLabel = document.createElement("span");
    fontFamilyLabel.className = "panel-label";
    fontFamilyLabel.textContent = "字体";
    this.fontFamilySelect = document.createElement("select");
    this.fontFamilySelect.className = "font-family-select";
    const fontOptions: [string, string][] = [
      ["", "默认"],
      ["SimSun", "宋体"],
      ["SimHei", "黑体"],
      ["Microsoft YaHei", "微软雅黑"],
      ["KaiTi", "楷体"],
      ["FangSong", "仿宋"],
      ["Arial", "Arial"],
      ["Times New Roman", "Times New Roman"],
      ["Courier New", "Courier New"],
    ];
    for (const [value, label] of fontOptions) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      this.fontFamilySelect.appendChild(opt);
    }
    this.fontFamilySelect.addEventListener("change", () => {
      handlers.onFontFamilyChange(this.fontFamilySelect.value);
    });
    this.fontFamilyRow.append(fontFamilyLabel, this.fontFamilySelect);
    this.popover.appendChild(this.fontFamilyRow);

    // 箭头端点行：起点/终点各 5 档（无/箭头/三角/圆/点），仅单选 line/arrow 时显示
    this.arrowRow = document.createElement("div");
    this.arrowRow.className = "arrow-head-row";
    this.arrowRow.hidden = true;
    const headOptions: [IconName, string, ArrowHead][] = [
      ["arrowHeadNone", "无", "none"],
      ["arrowHeadArrow", "箭头", "arrow"],
      ["arrowHeadTriangle", "三角", "triangle"],
      ["arrowHeadCircle", "圆", "circle"],
      ["arrowHeadDot", "点", "dot"],
    ];
    const makeEndRow = (end: "start" | "end", labelText: string, btns: HTMLButtonElement[]) => {
      const row = document.createElement("div");
      row.className = "style-row";
      const label = document.createElement("span");
      label.className = "arrow-end-label";
      label.textContent = labelText;
      const group = document.createElement("div");
      group.className = "arrow-head-group";
      for (const [icon, tip, head] of headOptions) {
        const b = this.makeIconBtn(icon, `${labelText}点：${tip}`, () =>
          handlers.onArrowHeadChange(end, head),
        );
        b.classList.add("align-btn");
        btns.push(b);
        group.appendChild(b);
      }
      row.append(label, group);
      return row;
    };
    this.arrowRow.append(
      makeEndRow("start", "起", this.startArrowBtns),
      makeEndRow("end", "终", this.endArrowBtns),
    );
    this.popover.appendChild(this.arrowRow);

    // P3 线型行：实线/虚线/点线（选中含可描边形状时显示）
    this.dashRow = document.createElement("div");
    this.dashRow.className = "style-row";
    this.dashRow.hidden = true;
    const dashLabel = document.createElement("span");
    dashLabel.className = "panel-label";
    dashLabel.textContent = "线型";
    const dashGroup = document.createElement("div");
    dashGroup.className = "dash-group";
    // [图标, 提示, dashPattern]：undefined 为实线；与 leafer 虚线参数语义一致
    const dashOptions: [IconName, string, number[] | undefined][] = [
      ["solidLine", "实线", undefined],
      ["dash", "虚线", [8, 4]],
      ["dottedLine", "点线", [2, 4]],
    ];
    for (const [icon, tip, dash] of dashOptions) {
      const b = this.makeIconBtn(icon, tip, () => handlers.onStrokeDashChange(dash));
      b.classList.add("dash-btn");
      this.dashBtns.push(b);
      dashGroup.appendChild(b);
    }
    this.dashRow.append(dashLabel, dashGroup);
    this.popover.appendChild(this.dashRow);

    // P3 透明度行：滑条 0-100（映射 0-1，选中可编辑元素时显示）
    this.opacityRow = document.createElement("div");
    this.opacityRow.className = "style-row";
    this.opacityRow.hidden = true;
    const opacityLabel = document.createElement("span");
    opacityLabel.className = "panel-label";
    opacityLabel.textContent = "透明";
    this.opacityInput = document.createElement("input");
    this.opacityInput.type = "range";
    this.opacityInput.min = "0";
    this.opacityInput.max = "100";
    this.opacityInput.step = "1";
    this.opacityInput.value = "100";
    this.opacityInput.addEventListener("input", () => {
      const v = Number(this.opacityInput.value);
      this.opacityValue.textContent = `${v}%`;
      handlers.onOpacityChange(v / 100);
    });
    this.opacityValue = document.createElement("span");
    this.opacityValue.className = "font-size-value";
    this.opacityValue.textContent = "100%";
    this.opacityRow.append(opacityLabel, this.opacityInput, this.opacityValue);
    this.popover.appendChild(this.opacityRow);

    // P3 圆角行：滑条 0-100（仅单选 rect 时显示）
    this.cornerRow = document.createElement("div");
    this.cornerRow.className = "style-row";
    this.cornerRow.hidden = true;
    const cornerLabel = document.createElement("span");
    cornerLabel.className = "panel-label";
    cornerLabel.textContent = "圆角";
    this.cornerInput = document.createElement("input");
    this.cornerInput.type = "range";
    this.cornerInput.min = "0";
    this.cornerInput.max = "100";
    this.cornerInput.step = "1";
    this.cornerInput.value = "0";
    this.cornerInput.addEventListener("input", () => {
      const v = Number(this.cornerInput.value);
      this.cornerValue.textContent = String(v);
      handlers.onCornerRadiusChange(v);
    });
    this.cornerValue = document.createElement("span");
    this.cornerValue.className = "font-size-value";
    this.cornerValue.textContent = "0";
    this.cornerRow.append(cornerLabel, this.cornerInput, this.cornerValue);
    this.popover.appendChild(this.cornerRow);

    // 粗糙度行：滑条 0-2（rough.js roughness，0 平滑 / 2 重度抖动），
    // 选中含已手绘元素时显示；同一 seed 重绘，仅幅度变化不改变抖动形态
    this.roughRow = document.createElement("div");
    this.roughRow.className = "style-row";
    this.roughRow.hidden = true;
    const roughLabel = document.createElement("span");
    roughLabel.className = "panel-label";
    roughLabel.textContent = "粗糙";
    this.roughInput = document.createElement("input");
    this.roughInput.type = "range";
    this.roughInput.min = "0";
    this.roughInput.max = "2";
    this.roughInput.step = "0.1";
    this.roughInput.value = "1";
    this.roughInput.addEventListener("input", () => {
      const v = Number(this.roughInput.value);
      this.roughValue.textContent = v.toFixed(1);
      handlers.onRoughnessChange(v);
    });
    this.roughValue = document.createElement("span");
    this.roughValue.className = "font-size-value";
    this.roughValue.textContent = "1.0";
    this.roughRow.append(roughLabel, this.roughInput, this.roughValue);
    this.popover.appendChild(this.roughRow);
    document.body.appendChild(this.popover);

    // 点击浮层外部关闭（ESC/失焦由 main.ts 互斥管理统一兜底，此处补充失焦）
    document.addEventListener("pointerdown", (e) => {
      if (this.popover.hidden) {
        return;
      }
      const t = e.target as Node;
      if (!this.popover.contains(t) && t !== this.styleBtn) {
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
  show(info: SelectionInfo | null, toolActive: boolean, penMode = false, eraserMode = false) {
    const hasSelection = !!info && info.ids.length > 0;
    const visible = (penMode || eraserMode || hasSelection) && toolActive && !info?.allLocked;
    this.setBarVisible(visible);
    if (!visible) {
      this.hidePopover();
      return;
    }
    if (eraserMode && !hasSelection) {
      // 橡皮模式：只显示半径滑条
      this.beautifyBtn.style.display = "none";
      this.sketchifyBtn.style.display = "none";
      this.cropBtn.style.display = "none";
      this.styleBtn.style.display = "none";
      this.sep.style.display = "none";
      this.eraserRow.hidden = false;
      this.fontRow.hidden = true;
      this.alignRow.hidden = true;
      this.weightRow.hidden = true;
      this.fontFamilyRow.hidden = true;
      this.widthRow.hidden = true;
      this.dashRow.hidden = true;
      this.opacityRow.hidden = true;
      this.cornerRow.hidden = true;
      this.roughRow.hidden = true;
      this.arrowRow.hidden = true;
      this.hidePopover(false);
      return;
    }
    if (penMode && !hasSelection) {
      // 画笔预设置：只显示样式按钮（颜色/粗细作用于新笔迹）
      this.beautifyBtn.style.display = "none";
      this.sketchifyBtn.style.display = "none";
      this.cropBtn.style.display = "none";
      this.sep.style.display = "";
      this.styleBtn.style.display = "";
      this.eraserRow.hidden = true;
      this.fontRow.hidden = true;
      this.alignRow.hidden = true;
      this.weightRow.hidden = true;
      this.fontFamilyRow.hidden = true;
      this.widthRow.hidden = false;
      this.dashRow.hidden = true;
      this.opacityRow.hidden = true;
      this.cornerRow.hidden = true;
      this.roughRow.hidden = true;
      this.arrowRow.hidden = true;
      return;
    }
    const info2 = info!;
    // 按钮差异化：✨ 仅手绘笔迹、✎ 仅可手绘图形、✂ 仅单选图片、🎨 有可编辑元素
    const singleImage = info2.types.length === 1 && info2.types[0] === "image";
    const hasEditable = info2.types.some((t) => t !== "image");
    this.beautifyBtn.style.display = info2.hasFreehand ? "" : "none";
    this.sketchifyBtn.style.display = info2.hasSketchable ? "" : "none";
    this.cropBtn.style.display = singleImage ? "" : "none";
    this.styleBtn.style.display = hasEditable ? "" : "none";
    this.sep.style.display = hasEditable ? "" : "none";
    this.eraserRow.hidden = true;
    this.fontRow.hidden = !info2.hasText;
    this.alignRow.hidden = !info2.hasText;
    this.weightRow.hidden = !info2.hasText;
    this.fontFamilyRow.hidden = !info2.hasText;
    // 纯文字选中：描边“粗细”对文字无效（文字渲染走 fill），隐藏避免误操作；字重行已提供文字粗细
    const pureText = info2.hasText && info2.types.every((t) => t === "text");
    this.widthRow.hidden = pureText;
    if (info2.hasText) {
      if (info2.fontSize !== undefined) {
        this.setFontSize(info2.fontSize);
      }
      // 文本排版回显（单选未锁定文字时）：对齐高亮/字重滑条/字体下拉
      if (info2.textAlign !== undefined) {
        this.setTextAlign(info2.textAlign);
      }
      if (info2.fontWeight !== undefined) {
        this.setWeight(info2.fontWeight);
      }
      if (info2.fontFamily !== undefined) {
        this.setFontFamily(info2.fontFamily);
      }
    }
    // P3 样式扩展行：线型（含可描边形状）、透明度（可编辑元素）、圆角（仅单选 rect）；
    // 单选未锁定元素时滑条跟随当前值（多选/锁定值混杂不跟随）
    const hasStrokeShape = info2.types.some(
      (t) => t === "rect" || t === "ellipse" || t === "line" || t === "arrow" || t === "path",
    );
    this.dashRow.hidden = !hasStrokeShape;
    this.opacityRow.hidden = !hasEditable;
    const singleRect = info2.ids.length === 1 && info2.types[0] === "rect";
    this.cornerRow.hidden = !singleRect;
    // 粗糙度：选中含已手绘元素时显示；单选未锁定时滑条跟随当前值
    this.roughRow.hidden = !info2.hasRough;
    if (info2.roughness !== undefined) {
      this.setRoughness(info2.roughness);
    }
    // 箭头端点：仅单选 line/arrow 时显示，端点按钮高亮跟随当前值
    const singleLine =
      info2.ids.length === 1 && (info2.types[0] === "line" || info2.types[0] === "arrow");
    this.arrowRow.hidden = !singleLine;
    if (info2.startArrow !== undefined) {
      this.setArrowHead("start", info2.startArrow);
    }
    if (info2.endArrow !== undefined) {
      this.setArrowHead("end", info2.endArrow);
    }
    if (info2.opacity !== undefined) {
      this.setOpacity(info2.opacity);
    }
    if (info2.cornerRadius !== undefined) {
      this.setCornerRadius(info2.cornerRadius);
    }
  }

  /** 两段式显隐：先切 hidden 保证 transition 播放，延时后再真正隐藏 */
  private setBarVisible(visible: boolean) {
    clearTimeout(this.hideTimer);
    if (visible) {
      this.bar.hidden = false;
      // 双帧延迟：hidden 移除后下一帧再加 visible，确保 transition 从初始态播放
      requestAnimationFrame(() => requestAnimationFrame(() => this.bar.classList.add("visible")));
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
    // 互斥收起另一面板但不调度隐藏定时器（否则 180ms 后会把刚打开的面板隐藏）
    this.hidePopover(false);
    this.popover.hidden = false;
    this.positionPopover(this.popover, anchor);
    requestAnimationFrame(() => requestAnimationFrame(() => this.popover.classList.add("visible")));
  }

  /** 浮层定位：锚点在上半屏时显示在下方居中，否则显示在右侧（底部越界上移） */
  private positionPopover(popover: HTMLElement, anchor: DOMRect) {
    const pw = popover.offsetWidth || 200;
    const ph = popover.offsetHeight || 140;
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
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  /** 收起样式浮层（main.ts 互斥管理 closeAllFloating 调用；
   * scheduleHide=false 供面板互斥切换复用：只收起不调度隐藏定时器，避免误伤刚打开的面板） */
  hidePopover(scheduleHide = true) {
    this.popover.classList.remove("visible");
    clearTimeout(this.popoverHideTimer);
    if (scheduleHide) {
      this.popoverHideTimer = window.setTimeout(() => {
        this.popover.hidden = true;
      }, FADE_MS);
    }
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

  /** 橡皮半径滑条跟随（滚轮 / [ ] 键调节时反向同步） */
  setEraserRadius(radiusPx: number) {
    this.eraserInput.value = String(radiusPx);
    this.eraserValue.textContent = String(radiusPx);
  }

  setFontSize(size: number) {
    this.fontSizeInput.value = String(size);
    this.fontSizeLabel.textContent = String(size);
  }

  /** 对齐按钮高亮跟随（单选未锁定文字时） */
  setTextAlign(align: "left" | "center" | "right") {
    const idx = align === "left" ? 0 : align === "center" ? 1 : 2;
    this.alignBtns.forEach((b, i) => {
      b.classList.toggle("active", i === idx);
    });
  }

  /** 字重滑条跟随（单选未锁定文字时；100 取整到档位） */
  setWeight(weight: number) {
    const v = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
    this.weightInput.value = String(v);
    this.weightValue.textContent = String(v);
  }

  /** 字体下拉跟随（当前字体不在选项列表时回退默认项） */
  setFontFamily(family: string) {
    this.fontFamilySelect.value = family;
    if (this.fontFamilySelect.value !== family) {
      this.fontFamilySelect.value = "";
    }
  }

  /** 端点按钮高亮跟随（单选 line/arrow 时） */
  setArrowHead(end: "start" | "end", head: ArrowHead) {
    const btns = end === "start" ? this.startArrowBtns : this.endArrowBtns;
    const order = ["none", "arrow", "triangle", "circle", "dot"];
    const idx = order.indexOf(head);
    btns.forEach((b, i) => {
      b.classList.toggle("active", i === idx);
    });
  }

  /** 透明度滑条跟随（单选未锁定元素时由 SelectionInfo 驱动） */
  setOpacity(opacity: number) {
    const v = Math.round(opacity * 100);
    this.opacityInput.value = String(v);
    this.opacityValue.textContent = `${v}%`;
  }

  /** 圆角滑条跟随（单选 rect 时） */
  setCornerRadius(radius: number) {
    this.cornerInput.value = String(radius);
    this.cornerValue.textContent = String(radius);
  }

  /** 粗糙度滑条跟随（单选已手绘元素时） */
  setRoughness(roughness: number) {
    const v = Math.min(2, Math.max(0, roughness));
    this.roughInput.value = String(v);
    this.roughValue.textContent = v.toFixed(1);
  }

  private setChannel(channel: "stroke" | "fill") {
    this.activeChannel = channel;
    this.strokeChannelBtn.classList.toggle("active", channel === "stroke");
    this.fillChannelBtn.classList.toggle("active", channel === "fill");
    // 切换后色板高亮与取色器跟随当前通道颜色
    this.setActiveColor(channel === "stroke" ? this.strokeChannelColor : this.fillChannelColor);
  }

  // ---------- 最近使用颜色 ----------

  /** 读取最近颜色（localStorage，损坏时返回空） */
  private loadRecent(): string[] {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list)
        ? list
            .filter((c): c is string => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c))
            .slice(0, MAX_RECENT)
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

  /** 通用图标小按钮（样式浮层内各选项按钮组共用） */
  private makeIconBtn(icon: IconName, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "arrange-btn";
    btn.title = title;
    btn.innerHTML = iconHTML(icon, 14);
    btn.addEventListener("click", onClick);
    return btn;
  }
}
