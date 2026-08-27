import { Box, Ellipse, Image, Line, Path, Rect, Text } from "leafer-ui";
import type { UI } from "leafer-ui";
import type { ElementData, FontWeight } from "../types";
import {
  arrowHeadOf,
  bindingsToEl,
  colorOf,
  FRAME_FLAG,
  hasArrowHead,
  numOf,
  toLeaferArrow,
} from "./element-utils";
import { isFrameEl } from "./element-utils";
import {
  FRAME_CODE_FONT,
  FRAME_COLLAPSED_HEIGHT,
  FRAME_CONTENT_COLOR,
  FRAME_CONTENT_SIZE,
  FRAME_LINE_HEIGHT,
  FRAME_PADDING,
  normalizeContent,
  frameContentSize,
} from "./frame";
import {
  FRAME_DEFAULT_FILL,
  FRAME_NAME_LABEL_COLOR,
  FRAME_NAME_LABEL_GAP,
  FRAME_NAME_LABEL_SIZE,
} from "./frame-controller";
import { translatePath } from "./path";

/**
 * 序列化转换层：ElementData ⇄ leafer 元素的双向纯映射。
 * 从 Board 拆出——转换逻辑只依赖元素自身属性与少量回调（稳定 id / 归属 id /
 * editor 内部判定），不持有画布状态；载入编排（loadElements）留在 Board。
 */

/** elementToData 所需上下文（Board 注入，均为无状态回调） */
export type ElementToDataContext = {
  /** 元素稳定 id（首次访问分配并缓存到实例） */
  aiIdOf: (el: UI) => string;
  /** 内容归属框架 id（__frameId 实例标记） */
  frameIdOf: (el: UI) => string | undefined;
  /** editor 内部元素（多选模拟层等）判定 */
  isEditorInternal: (el: UI) => boolean;
};

/**
 * leafer 元素 → 元素数据（serialize 逐元素调用）。
 * 注意：Image 继承自 Rect，必须先于 Rect 判断。
 */
export function elementToData(el: UI, ctx: ElementToDataContext): ElementData | null {
  // editor 内部元素（多选模拟层等）不参与序列化
  if (ctx.isEditorInternal(el)) {
    return null;
  }
  const base = {
    id: ctx.aiIdOf(el),
    x: el.x ?? 0,
    y: el.y ?? 0,
    rotation: el.rotation || undefined,
    // 内容归属框架 id（序列化时由 contractFrameContents 统一把坐标转相对）
    frameId: ctx.frameIdOf(el),
    stroke: colorOf(el.stroke),
    strokeWidth: numOf(el.strokeWidth),
    locked: el.locked || undefined,
    groupId: (el as unknown as { __groupId?: string }).__groupId,
    strokeDash: (el as unknown as { dashPattern?: number[] }).dashPattern,
    opacity: numOf(el.opacity) || undefined,
    intent: (el as unknown as { __intent?: string }).__intent,
  };
  if (el instanceof Image) {
    return {
      ...base,
      type: "image",
      width: el.width ?? 0,
      height: el.height ?? 0,
      url: (el as unknown as { url?: unknown }).url as string | undefined,
    };
  }
  if (isFrameEl(el)) {
    const meta = el as unknown as Record<string, unknown>;
    return {
      ...base,
      type: "frame",
      width: el.width ?? 0,
      height: el.height ?? 0,
      fill: colorOf(el.fill),
      // 虚线为 frame 固定风格，不序列化（恢复时兑底）
      strokeDash: undefined,
      // 内容容器元数据：运行时挂实例，序列化/恢复对称
      name: typeof meta.__frameName === "string" ? meta.__frameName : undefined,
      contentType:
        meta.__frameContentType === "markdown" ||
        meta.__frameContentType === "code" ||
        meta.__frameContentType === "text"
          ? meta.__frameContentType
          : undefined,
      content: typeof meta.__frameContent === "string" ? meta.__frameContent : undefined,
      autoSize: typeof meta.__frameAutoSize === "boolean" ? meta.__frameAutoSize : undefined,
      constrain: typeof meta.__frameConstrain === "boolean" ? meta.__frameConstrain : undefined,
      collapsed: typeof meta.__frameCollapsed === "boolean" ? meta.__frameCollapsed : undefined,
      // 滚动偏移读运行时 scrollY（滚动交互直接改装饰属性，meta 不随动）
      scrollY: numOf(el.scrollY),
    };
  }
  if (el instanceof Rect) {
    return {
      ...base,
      type: "rect",
      width: el.width ?? 0,
      height: el.height ?? 0,
      fill: colorOf(el.fill),
      cornerRadius: numOf(el.cornerRadius) || undefined,
    };
  }
  if (el instanceof Ellipse) {
    return {
      ...base,
      type: "ellipse",
      width: el.width ?? 0,
      height: el.height ?? 0,
      fill: colorOf(el.fill),
    };
  }
  if (el instanceof Line) {
    const t = el as unknown as { __bindStart?: string; __bindEnd?: string; __isRoute?: boolean };
    return {
      ...base,
      // leafer 2.x 的 endArrow 默认值是字符串 "none"（truthy），需排除；
      // 两端都无端点时按 line 序列化，任一端有端点则为 arrow
      type: (hasArrowHead(el) ? "arrow" : "line") as "arrow" | "line",
      width: el.width ?? 0,
      height: el.height ?? 0,
      points: el.points as { x: number; y: number }[] | undefined,
      bindStart: t.__bindStart,
      bindEnd: t.__bindEnd,
      route: t.__isRoute === true ? true : undefined,
      startArrow: arrowHeadOf(el.startArrow),
      endArrow: arrowHeadOf(el.endArrow),
    };
  }
  if (el instanceof Path) {
    const t = el as unknown as {
      __freehandPoints?: number[][];
      __penSize?: number;
      __rough?: {
        seed: number;
        original?: string;
        roughness?: number;
        originalPath?: string;
      };
    };
    // 元素位移（leafer 移动 Path 时改 x/y、path 不变），导出时并入 path
    const dx = el.x ?? 0;
    const dy = el.y ?? 0;
    if (t.__freehandPoints) {
      // freehand 笔迹：颜色走 stroke 通道（渲染通道是 fill），采样点用于整理识别/重绘
      return {
        ...base,
        type: "freehand",
        width: el.width ?? 0,
        height: el.height ?? 0,
        path: el.path as string,
        penPoints: t.__freehandPoints,
        penSize: t.__penSize,
        stroke: colorOf(el.fill),
        fill: undefined,
      };
    }
    return {
      ...base,
      type: "path",
      width: el.width ?? 0,
      height: el.height ?? 0,
      // 归一化：leafer Path 渲染 = (x, y) + path 坐标，数据契约统一为
      // “path 画布绝对坐标 + x/y 置 0”，导出时把元素位移并入 path，避免双重偏移
      x: 0,
      y: 0,
      path: dx || dy ? translatePath(el.path as string, dx, dy) : (el.path as string),
      fill: colorOf(el.fill),
      rough: t.__rough,
    };
  }
  if (el instanceof Text) {
    return {
      ...base,
      type: "text",
      width: el.width ?? 0,
      height: el.height ?? 0,
      text: el.text == null ? undefined : String(el.text),
      fontSize: typeof el.fontSize === "number" ? el.fontSize : undefined,
      fill: colorOf(el.fill),
      // 文本排版扩展：对齐/字重/字体随文件保存（autoSizeAlign 按对齐自动推导，不单独存）
      textAlign: el.textAlign === "center" || el.textAlign === "right" ? el.textAlign : undefined,
      fontFamily: typeof el.fontFamily === "string" ? el.fontFamily : undefined,
      fontWeight:
        typeof el.fontWeight === "number"
          ? (el.fontWeight as FontWeight)
          : el.fontWeight === "bold"
            ? 700
            : undefined,
    };
  }
  return null;
}

/**
 * 元素数据 → leafer 元素（含业务元数据回填：id/组关系/归属/意图）。
 * 归属坐标换算不在本函数（loadElements/paste 的归属解析阶段统一做，
 * 因为框架可能在数据末尾，须等全部入树后再换算）。
 */
export function dataToElement(d: ElementData): UI | null {
  const el = dataToElementInner(d);
  if (el && d.id) {
    // 恢复/导入时把文件里的 id 写回实例缓存，保证 id 稳定
    (el as unknown as { __aiId?: string }).__aiId = d.id;
  }
  if (el && d.groupId) {
    // 分组关系透传到实例（对齐/分布/层序/删除的组感知依赖实例缓存）
    (el as unknown as { __groupId?: string }).__groupId = d.groupId;
  }
  if (el && d.frameId) {
    // 内容归属透传到实例（坐标换算在 loadElements/paste 的归属解析阶段）
    (el as unknown as { __frameId?: string }).__frameId = d.frameId;
  }
  if (el && d.intent) {
    // AI 创建时自报的创建意图：透传到实例，序列化/恢复后不丢
    (el as unknown as { __intent?: string }).__intent = d.intent;
  }
  return el;
}

function dataToElementInner(d: ElementData): UI | null {
  const common = {
    x: d.x,
    y: d.y,
    rotation: d.rotation,
    stroke: d.stroke,
    strokeWidth: d.strokeWidth,
    locked: d.locked || undefined,
    dashPattern: d.strokeDash,
    opacity: d.opacity,
    cornerRadius: d.cornerRadius,
  };
  const fill = d.fill === "none" ? undefined : d.fill;
  switch (d.type) {
    case "rect": {
      return new Rect({
        ...common,
        width: d.width,
        height: d.height,
        fill,
      });
    }
    case "frame": {
      // 框架容器：内容型用 Box（Rect 的自身渲染 + Group 的子级渲染，是 leafer 2.x
      // 中唯一兼具“绘制矩形”与“容纳子级”的容器；Rect 不支持子级）。内容文本作为
      // 真子级挂载：随框架移动/缩放/旋转/删除自动跟随，序列化只读框架数据不读子级。
      // 普通型（无内容）保持 Rect。autoSize（默认开启）按内容撑尺寸。
      let boxW = d.width ?? 0;
      let boxH = d.height ?? 0;
      const text = normalizeContent(d.content ?? "");
      if (d.content && d.autoSize !== false) {
        const size = frameContentSize(d.content, d.contentType);
        boxW = size.width;
        boxH = size.height;
        // 折叠：内容超高时框架高度压到折叠上限，超出部分裁剪 + 滚轮滚动查看
        if (d.collapsed) {
          boxH = Math.min(boxH, FRAME_COLLAPSED_HEIGHT);
        }
      }
      let contentText: Text | null = null;
      if (text) {
        contentText = new Text({
          x: FRAME_PADDING,
          y: FRAME_PADDING,
          // 定宽 + 按宽度折行：长行在框内换行，配合 autoSize 折行高度不溢出
          width: Math.max(1, boxW - FRAME_PADDING * 2),
          textWrap: "break",
          text,
          fontSize: FRAME_CONTENT_SIZE,
          // leafer 的 lineHeight 数值为像素值（非倍数），倍数须用 percent 单位：
          // 直接传 1.6 会渲染为 1.6px 行高导致多行文字重叠
          lineHeight: { type: "percent", value: FRAME_LINE_HEIGHT },
          fontFamily: d.contentType === "code" ? FRAME_CODE_FONT : undefined,
          fill: d.stroke ?? FRAME_CONTENT_COLOR,
          // 内容文本不参与命中/编辑：点击穿透到框架本体，编辑器不可操作
          hit: false,
          locked: true,
        });
      }
      // 名称标签：悬于框架上沿之外（负 y），点击穿透到框体即选中整框；
      // 折叠状态 overflow 裁剪掉负 y 区域 → 标签随折叠自然隐藏。
      // 序列化只读框架元数据不读子级，标签不会进入数据
      let nameLabel: Text | null = null;
      if (typeof d.name === "string" && d.name.trim()) {
        nameLabel = new Text({
          x: 0,
          y: -(FRAME_NAME_LABEL_SIZE + FRAME_NAME_LABEL_GAP),
          text: d.name,
          fontSize: FRAME_NAME_LABEL_SIZE,
          fill: FRAME_NAME_LABEL_COLOR,
          hit: false,
          locked: true,
        });
      }
      const el = new Box({
        ...common,
        width: boxW,
        height: boxH,
        // 框架一律带填充（fill 缺失时补默认色）：内部可命中走增量拖动管线
        fill: fill ?? FRAME_DEFAULT_FILL,
        dashPattern: d.constrain ? undefined : (d.strokeDash ?? [8, 5]),
        // 折叠状态：裁剪超出内容，scrollY 偏移子级渲染。overflow 必须含
        // "scroll"（leafer Box 只在 overflow 含 scroll 时应用 scrollX/scrollY
        // 平移子级 bounds，hide 仅裁剪不滚动；无 scroller 插件不显示滚动条），
        // scrollY 负值内容上移（0 = 顶部，-max = 底部），无需手动遮罩
        overflow: d.collapsed ? "scroll" : undefined,
        scrollY: d.collapsed ? (d.scrollY ?? 0) : undefined,
        // 注意：children 显式传 undefined 会让 leafer 2.2.9 的 Group/Branch
        // children 保持 undefined，入树时 __bindLeafer 遍历其 length 崩溃并
        // 卡死布局管线（画布永不渲染），必须用空数组
        children: [...(contentText ? [contentText] : []), ...(nameLabel ? [nameLabel] : [])],
      });
      const meta = el as unknown as Record<string, unknown>;
      meta[FRAME_FLAG] = true;
      meta.__frameName = d.name;
      meta.__frameContentType = d.contentType;
      meta.__frameContent = d.content;
      meta.__frameAutoSize = d.autoSize;
      meta.__frameConstrain = d.constrain;
      meta.__frameCollapsed = d.collapsed;
      // 框架的抓取心智：内容常占满内部，边线/角点是最自然的抓取处——
      // 禁用手柄缩放与旋转（抓边/抓角 = 移动框架；leafer 在手柄不可缩放时
      // 会把 resize 点当旋转用，形成“抓边无反应”的死区，一并关闭）；
      // 尺寸调整交给内容 autoSize 或转回矩形
      (
        el as unknown as { editConfig?: { resizeable?: boolean; rotateable?: boolean } }
      ).editConfig = { resizeable: false, rotateable: false };
      return el;
    }
    case "ellipse": {
      return new Ellipse({
        ...common,
        width: d.width,
        height: d.height,
        fill,
      });
    }
    case "line": {
      const el = new Line({
        ...common,
        points: d.points,
        startArrow: toLeaferArrow(d.startArrow),
        endArrow: toLeaferArrow(d.endArrow),
      });
      bindingsToEl(el, d);
      if (d.route === true) {
        (el as unknown as { __isRoute?: boolean }).__isRoute = true;
      }
      return el;
    }
    case "arrow": {
      const el = new Line({
        ...common,
        points: d.points,
        // 终点默认三角箭头（兼容旧文件）；显式 "none" 时保持无端点
        startArrow: toLeaferArrow(d.startArrow),
        endArrow: d.endArrow !== undefined ? toLeaferArrow(d.endArrow) : "triangle",
      });
      bindingsToEl(el, d);
      if (d.route === true) {
        (el as unknown as { __isRoute?: boolean }).__isRoute = true;
      }
      return el;
    }
    case "path": {
      const el = new Path({
        ...common,
        path: d.path,
        fill: fill,
        strokeCap: "round",
        strokeJoin: "round",
      });
      // 手绘风格元素：seed 随数据透传到实例（撤销/重载后序列化不丢）
      if (d.rough) {
        (el as unknown as Record<string, unknown>).__rough = d.rough;
      }
      return el;
    }
    case "freehand": {
      const el = new Path({
        ...common,
        path: d.path,
        fill: d.stroke,
        stroke: undefined,
        strokeCap: "round",
        strokeJoin: "round",
      });
      const t = el as unknown as Record<string, unknown>;
      t.__freehandPoints = d.penPoints;
      t.__penSize = d.penSize;
      return el;
    }
    case "text":
      return new Text({
        ...common,
        text: d.text,
        fontSize: d.fontSize,
        fill: fill ?? d.stroke,
        // 文本排版扩展：对齐/字重/字体恢复；自动宽度下居中/右对齐需 autoSizeAlign
        textAlign: d.textAlign,
        fontFamily: d.fontFamily,
        fontWeight: d.fontWeight,
        autoSizeAlign: d.textAlign && d.textAlign !== "left" && !d.width ? true : undefined,
      });
    case "image":
      return new Image({
        ...common,
        url: d.url,
        width: d.width,
        height: d.height,
      });
  }
}

/** 把生成器输出的元素数据增量应用到草稿实例（拖拽中实时刷新） */
export function applyDataToDraft(draft: UI, d: ElementData) {
  const t = draft as unknown as Record<string, unknown>;
  if (d.x !== undefined) t.x = d.x;
  if (d.y !== undefined) t.y = d.y;
  if (d.width !== undefined) t.width = d.width;
  if (d.height !== undefined) t.height = d.height;
  if (d.rotation !== undefined) t.rotation = d.rotation;
  if (d.stroke !== undefined) t.stroke = d.stroke;
  if (d.strokeWidth !== undefined) t.strokeWidth = d.strokeWidth;
  if ("fill" in d) {
    // leafer 2.x 中 "none" 渲染为黑色实心，必须转 undefined
    t.fill = d.fill === "none" ? undefined : d.fill;
  }
  if (d.points !== undefined && draft instanceof Line) t.points = d.points;
  if (d.path !== undefined && draft instanceof Path) t.path = d.path;
  if (d.text !== undefined && draft instanceof Text) t.text = d.text;
  if (d.fontSize !== undefined && draft instanceof Text) t.fontSize = d.fontSize;
}
