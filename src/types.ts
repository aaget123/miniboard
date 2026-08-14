// 画布文件格式（保存/打开/自动保存共用）
export type ToolType =
  | "select"
  | "hand"
  | "marquee"
  | "lasso"
  | "pen"
  | "eraser"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text";

// ================= 统一功能规则 =================
// 功能区（绘制工具）统一注册：内置工具与 AI 生成工具共用同一结构。

/** 当前绘制样式（描边色/粗细/填充开关） */
export type BoardStyle = {
  stroke: string;
  strokeWidth: number;
  fillEnabled: boolean;
  /** 填充颜色（独立于描边色；填充 = 该色 15% 半透明） */
  fillColor: string;
  /** 文字字号（仅选中文字时生效，不作为新文字默认值） */
  fontSize?: number;
};

/**
 * 绘制工具生成器上下文：拖拽起点 (x0,y0)、当前点 (x1,y1)、当前样式。
 * 生成器根据上下文输出元素数据，拖拽过程中被反复调用。
 */
export type GeneratorContext = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  style: BoardStyle;
};

/**
 * 工具行为类别：
 * - drag：拖拽生成元素，走统一管线（内置 rect/ellipse/line/arrow 与 AI 工具同）；
 * - freehand：自由笔迹（pen，保留 canvas 专有实现）；
 * - interaction：特殊交互（select/hand/marquee/lasso/eraser/text，保留 canvas 专有实现）。
 */
export type ToolKind = "drag" | "freehand" | "interaction";

/**
 * 工具栏分组：shape = 收进“形状”下拉按钮（矩形/椭圆等基础形状），
 * select = 收进“选择”下拉按钮（框选/套索等选中类工具）。
 */
export type ToolGroup = "shape" | "select";

/** 统一功能定义：内置工具与 AI 生成工具共用 */
export type ToolDef = {
  id: string;
  name: string;
  icon: string;
  title: string;
  shortcut?: string;
  kind: ToolKind;
  source: "builtin" | "custom";
  /** 工具栏分组：与同类型的其他工具收纳在同一下拉按钮中 */
  group?: ToolGroup;
};

/** AI 生成工具：行为固定为 drag，generator 为代码函数体源码 */
export type CustomToolDef = ToolDef & {
  kind: "drag";
  source: "custom";
  /** 函数体源码：(ctx: GeneratorContext) => ElementData */
  generator: string;
  description?: string;
  createdAt: number;
};

/** 新增/修改自定义工具的入参（AI add_tool / update_tool 用） */
export type CustomToolInput = {
  name: string;
  icon: string;
  shortcut?: string;
  generator: string;
  description?: string;
  /** 与已有同类型工具归入同一分组（如形状类工具归入 shape 形状下拉） */
  group?: ToolGroup;
};

export type ElementData = {
  type:
    | "rect"
    | "ellipse"
    | "line"
    | "arrow"
    | "path"
    | "freehand"
    | "text"
    | "image";
  /** 稳定标识（AI 编辑模式按 id 引用元素），序列化时自动分配 */
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  fill?: string; // "none" 表示无填充
  stroke?: string;
  strokeWidth?: number;
  points?: { x: number; y: number }[]; // line/arrow: 相对元素原点的坐标点
  path?: string; // path: SVG 路径字符串（相对坐标）；freehand: 笔迹轮廓 path（与 penPoints 同基准）
  /** freehand: 原始笔迹采样点 [x, y, pressure?]（与 path 同基准），形状识别/重绘用 */
  penPoints?: number[][];
  /** freehand: perfect-freehand 的 size（笔画直径） */
  penSize?: number;
  /** rough 手绘风格：seed 保证抖动可复现，original 记录原几何类型（供还原/AI 理解） */
  rough?: { seed: number; original?: string };
  text?: string;
  fontSize?: number;
  url?: string; // image: dataURL 或路径
  /** line/arrow: 端点绑定的元素稳定 id（被绑元素移动时端点自动跟随） */
  bindStart?: string;
  bindEnd?: string;
  locked?: boolean; // 锁定后不可拖动/缩放/删除
};

export type SceneFile = {
  app: "miniboard";
  version: 1;
  background: string;
  elements: ElementData[];
};

/** 项目元数据（多项目管理：项目目录 + 切换 + 独立自动保存） */
export type ProjectMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export const FILE_VERSION = 1 as const;
