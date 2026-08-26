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

/**
 * 箭头端点样式（line/arrow 两端可配；"dot" = 小号实心圆点）。
 * leafer 渲染映射：none→无；arrow→arrow；triangle→triangle；circle→circle；
 * dot→{ type: "circle", scale: 0.5 }（leafer 无独立圆点形状，用小号实心圆实现）。
 */
export type ArrowHead = "none" | "arrow" | "triangle" | "circle" | "dot";

/** 文字字重档位（leafer IFontWeight 数值档位；常规 400 / 粗体 700） */
export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

/** 当前绘制样式（描边色/粗细/填充开关） */
export type BoardStyle = {
  stroke: string;
  strokeWidth: number;
  fillEnabled: boolean;
  /** 填充颜色（独立于描边色；填充 = 该色 15% 半透明） */
  fillColor: string;
  /** 文字字号（仅选中文字时生效，不作为新文字默认值） */
  fontSize?: number;
  /** 描边虚线（undefined = 实线；仅作用于选中，不进默认样式） */
  strokeDash?: number[];
  /** 不透明度 0~1（仅作用于选中） */
  opacity?: number;
  /** 圆角半径（仅 rect；仅作用于选中） */
  cornerRadius?: number;
  // ---- 文本排版扩展（仅选中文字时生效，不进默认样式） ----
  /** 文字水平对齐（undefined = 左对齐） */
  textAlign?: "left" | "center" | "right";
  /** 字体族（undefined = 默认字体） */
  fontFamily?: string;
  /** 字重（undefined = 常规；整元素切换，TextEditor 纯文本机制不支持局部加粗） */
  fontWeight?: FontWeight;
  /** 起点端点样式（仅作用于选中 line/arrow） */
  startArrow?: ArrowHead;
  /** 终点端点样式（仅作用于选中 line/arrow） */
  endArrow?: ArrowHead;
  /** 粗糙度 0~2（仅作用于已手绘元素，同一 seed 重绘） */
  roughness?: number;
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
  /** 当前画布缩放（世界/屏幕比）：做"屏幕恒定大小"元素时用于换算 */
  zoom?: number;
  /** 拖拽/点击时按住的修饰键（可选字段，向后兼容） */
  shiftKey?: boolean;
  altKey?: boolean;
};

/**
 * 工具行为类别：
 * - drag：拖拽生成元素，走统一管线（内置 rect/ellipse/line/arrow 与 AI 工具同）；
 * - click：点击即生成固定大小元素（AI 自定义工具可选用，如印章/标注）；
 * - freehand：自由笔迹（pen，保留 canvas 专有实现）；
 * - interaction：特殊交互（select/hand/marquee/lasso/eraser/text，保留 canvas 专有实现）。
 */
export type ToolKind = "drag" | "click" | "freehand" | "interaction";

/**
 * 工具栏分组：select = 选中类工具（选择/框选/套索）收进“选择”下拉按钮，
 * shape = 收进“形状”下拉按钮（矩形/椭圆等基础形状），
 * ai = 收进“AI 工具”下拉按钮（AI 生成的自定义工具默认归入）。
 * 分组按钮为拆分式：点击主按钮直接使用组内当前工具，点击右侧箭头展开菜单切换。
 * 内置三个分组；用户可在设置中自建分组（id 形如 "cg-*"），工具可被拖入自定义分组。
 */
export type ToolGroup = "select" | "shape" | "ai" | (string & {});

/** 统一功能定义：内置工具与 AI 生成工具共用 */
export type ToolDef = {
  id: string;
  name: string;
  /** 按钮图标：内置工具为图标名（src/ui/icons.ts 的 IconName），AI 工具为 1-2 字符符号 */
  icon: string;
  title: string;
  shortcut?: string;
  kind: ToolKind;
  source: "builtin" | "custom";
  /** 工具栏分组：与同类型的其他工具收纳在同一下拉按钮中 */
  group?: ToolGroup;
};

/** AI 生成工具：行为为 drag/click，generator 为代码函数体源码 */
export type CustomToolDef = ToolDef & {
  kind: "drag" | "click";
  source: "custom";
  /** 函数体源码：(ctx: GeneratorContext) => ElementData 或 ElementData[] */
  generator: string;
  description?: string;
  createdAt: number;
};

/** 新增/修改自定义工具的入参（AI add_tool / update_tool 用） */
export type CustomToolInput = {
  name: string;
  icon: string;
  shortcut?: string;
  /** 行为类别：drag 拖拽生成（默认）；click 点击即生成固定大小元素 */
  kind?: "drag" | "click";
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
    | "image"
    | "frame";
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
  /** rough 手绘风格：seed 保证抖动可复现，original 记录原几何类型（供还原/AI 理解），roughness 粗糙度 0~2（undefined = 1），originalPath 记录多边形原始顶点 path，originalWidth/originalHeight/originalPoints 记录原始几何参数（改粗糙度重绘用，避免以含抖动的渲染尺寸为基准导致逐次放大） */
  rough?: {
    seed: number;
    original?: string;
    roughness?: number;
    originalPath?: string;
    originalWidth?: number;
    originalHeight?: number;
    originalPoints?: { x: number; y: number }[];
  };
  /** text: 文本内容 */
  text?: string;
  fontSize?: number;
  url?: string; // image: dataURL 或路径
  /** line/arrow: 端点绑定的元素稳定 id（被绑元素移动时端点自动跟随） */
  bindStart?: string;
  bindEnd?: string;
  /** line/arrow: 起点端点样式（undefined = 无） */
  startArrow?: ArrowHead;
  /** line/arrow: 终点端点样式（undefined = 无；arrow 类型创建时默认 triangle） */
  endArrow?: ArrowHead;
  locked?: boolean; // 锁定后不可拖动/缩放/删除
  // ---- frame 内容容器（阶段 1：导入内容 + 约束夹紧） ----
  /** frame: 框架名称（预留，供框架标签显示） */
  name?: string;
  /** frame: 内容类型（有 content 时框架为内容容器，渲染为框内派生文本） */
  contentType?: "markdown" | "code" | "text";
  /** frame: 内容文本（导入的 MD/代码/文本） */
  content?: string;
  /** frame: 自适应开关（有内容时按内容撑尺寸；undefined = 开启） */
  autoSize?: boolean;
  /** frame: 内容折叠开关（折叠后固定高度裁剪，滚轮滚动查看；undefined = 全部展示） */
  collapsed?: boolean;
  /** frame: 折叠状态下的内容滚动偏移（px，随文件保存；0 = 顶部，负值向上滚） */
  scrollY?: number;
  /** frame: 内容约束（框内绘制/拖动夹紧到框架边界；默认关闭） */
  constrain?: boolean;
  /** 分组 id：同组元素整组联动（任一成员选中则整组参与移动/删除/AI 排列） */
  groupId?: string;
  /** 内容归属：所在框架的 id（有值时 x/y 为相对框架原点坐标，随框架移动/缩放/旋转同步） */
  frameId?: string;
  /** 描边虚线（leafer 渲染映射 dashPattern；undefined = 实线） */
  strokeDash?: number[];
  /** 整体不透明度 0~1（undefined = 不透明） */
  opacity?: number;
  /** 圆角半径（仅 rect；undefined = 直角） */
  cornerRadius?: number;
  /** AI 创建时自报的创建意图（简短中文，说明为何创建此元素；仅 AI 创建的元素有） */
  intent?: string;
  // ---- 文本排版扩展 ----
  /** text: 水平对齐（undefined = 左对齐） */
  textAlign?: "left" | "center" | "right";
  /** text: 字体族（undefined = 默认字体） */
  fontFamily?: string;
  /** text: 字重（undefined = 常规；旧数据可能为 "normal"/"bold" 字符串，读取时兼容） */
  fontWeight?: FontWeight;
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
