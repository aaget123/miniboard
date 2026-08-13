// 画布文件格式（保存/打开/自动保存共用）
export type ToolType =
  | "select"
  | "pen"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text";

export type ElementData = {
  type: "rect" | "ellipse" | "line" | "arrow" | "path" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  fill?: string; // "none" 表示无填充
  stroke?: string;
  strokeWidth?: number;
  points?: { x: number; y: number }[]; // line/arrow: 相对元素原点的坐标点
  path?: string; // path: SVG 路径字符串（相对坐标）
  text?: string;
  fontSize?: number;
};

export type SceneFile = {
  app: "miniboard";
  version: 1;
  background: string;
  elements: ElementData[];
};

export const FILE_VERSION = 1 as const;
