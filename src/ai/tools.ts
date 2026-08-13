import type { Board } from "../board/canvas";
import { TEXT_FONT_SIZE } from "../board/canvas";
import type { ElementData } from "../types";
import type { AiMode, AiTool, AiToolExecution } from "./types";

// ================= 画布感知（非多模态：把画布转成 JSON 给模型看） =================

const MAX_DESCRIBE = 300;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 把画布序列化为紧凑 JSON 描述，供 LLM 理解内容：
 * - path 只保留路径段数（原始 SVG 路径 token 太大）
 * - image 不包含 dataURL 本体，只保留尺寸
 * - 元素过多时截断（最多 MAX_DESCRIBE 个）
 */
export function describeCanvas(board: Board): string {
  const els = board.serialize().slice(0, MAX_DESCRIBE);
  const compact = els.map((el) => {
    const d: Record<string, unknown> = {
      id: el.id,
      type: el.type,
      x: round1(el.x),
      y: round1(el.y),
    };
    if (typeof el.width === "number") d.w = round1(el.width);
    if (typeof el.height === "number") d.h = round1(el.height);
    if (typeof el.rotation === "number") d.rotation = round1(el.rotation);
    if (el.stroke) d.stroke = el.stroke;
    if (typeof el.strokeWidth === "number") d.strokeWidth = el.strokeWidth;
    if (el.fill && el.fill !== "none") d.fill = el.fill;
    if (el.text != null) d.text = el.text;
    if (typeof el.fontSize === "number") d.fontSize = el.fontSize;
    if (el.type === "path" && el.path) {
      d.path = `手绘路径（${(el.path.match(/[MLQCS]/gi) ?? []).length} 段）`;
    }
    if (el.type === "image") {
      d.image = `图片 ${round1(el.width ?? 0)}x${round1(el.height ?? 0)}`;
    }
    if (el.locked) d.locked = true;
    return d;
  });
  if (els.length === 0) {
    return "（画布是空的）";
  }
  const over = board.serialize().length - MAX_DESCRIBE;
  return JSON.stringify(compact) + (over > 0 ? `\n（另有 ${over} 个元素已省略）` : "");
}

// ================= 工具定义 =================

const pointSchema = {
  type: "object",
  properties: {
    x: { type: "number" },
    y: { type: "number" },
  },
  required: ["x", "y"],
};

const elementProps = {
  type: {
    type: "string",
    enum: ["rect", "ellipse", "line", "arrow", "path", "text", "image"],
  },
  x: { type: "number", description: "左上角 x 坐标" },
  y: { type: "number", description: "左上角 y 坐标" },
  width: { type: "number" },
  height: { type: "number" },
  rotation: { type: "number", description: "旋转角度（度）" },
  fill: { type: "string", description: "填充色（如 #ff0000）；文本元素表示文字颜色；不传则无填充" },
  stroke: { type: "string", description: "描边/线条颜色" },
  strokeWidth: { type: "number" },
  text: { type: "string", description: "文本内容（text 类型）" },
  fontSize: { type: "number" },
  points: {
    type: "array",
    items: pointSchema,
    description: "直线/箭头的端点，如 [{x:0,y:0},{x:200,y:0}]（相对元素原点）",
  },
};

/** 两种模式共用的工具 */
function commonTools(): AiTool[] {
  return [
    {
      name: "get_canvas",
      description:
        "获取画布当前全部元素的结构化 JSON 数据（坐标、颜色、文字内容等），用于理解画布上有什么",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "draw_flowchart",
      description:
        "把用户的想法、计划或流程表达成流程图并写入主画布：给出节点（含文字）与节点间的连线关系，前端自动排版为从上到下的流程图",
      parameters: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "节点短标识，如 n1、n2" },
                label: { type: "string", description: "节点上显示的文字，尽量简短（10 字内）" },
              },
              required: ["id", "label"],
            },
            description: "流程图节点列表",
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string", description: "起点节点 id" },
                to: { type: "string", description: "终点节点 id" },
              },
              required: ["from", "to"],
            },
            description: "节点连线关系",
          },
        },
        required: ["nodes"],
      },
      mutating: true,
    },
  ];
}

/** 编辑模式专用工具 */
function editTools(): AiTool[] {
  return [
    {
      name: "add_element",
      description:
        "向画布添加一个新元素。rect/ellipse 需 width/height；line/arrow 需 points；text 需 text；不传 fill 表示无填充（文本不传 fill 时用 stroke 颜色）",
      parameters: {
        type: "object",
        properties: elementProps,
        required: ["type", "x", "y"],
      },
      mutating: true,
    },
    {
      name: "update_element",
      description:
        "修改画布中已有元素的部分属性（按 id 定位，只改传入的字段）。id 必须是画布中真实存在的元素 id；锁定元素无法修改",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "目标元素 id（如 el-1）" },
          patch: {
            type: "object",
            description: "要修改的字段，例如 {stroke:'#ff0000'}、{text:'新文字'}、{x:100,y:200}",
            properties: elementProps,
          },
        },
        required: ["id", "patch"],
      },
      mutating: true,
    },
    {
      name: "delete_element",
      description: "删除画布中指定 id 的元素（锁定元素无法删除）",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
      mutating: true,
    },
    {
      name: "apply_selection",
      description: "选中画布中指定 id 的元素（操作后高亮反馈）",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
        },
        required: ["ids"],
      },
    },
  ];
}

export function toolsForMode(mode: AiMode): AiTool[] {
  return mode === "edit" ? [...commonTools(), ...editTools()] : commonTools();
}

/** OpenAI 兼容 tools 请求体格式 */
export function toOpenAiTools(tools: AiTool[]) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ================= 工具执行器 =================

export type AiToolContext = {
  board: Board;
  mode: AiMode;
};

const NODE_W = 180;
const NODE_H = 60;
const H_GAP = 60;
const V_GAP = 90;

/** 把想法画成流程图：分层布局 + 矩形节点 + 文字 + 箭头，写入主画布空白区 */
function drawFlowchart(board: Board, args: Record<string, unknown>): string {
  const nodes = Array.isArray(args.nodes) ? (args.nodes as { id?: string; label?: string }[]) : [];
  if (!nodes.length) {
    return "错误：nodes 不能为空";
  }
  const edges = Array.isArray(args.edges) ? (args.edges as { from?: string; to?: string }[]) : [];
  const validNodes = nodes.filter((n) => typeof n.id === "string" && n.id);
  if (!validNodes.length) {
    return "错误：节点缺少 id";
  }
  const nodeMap = new Map(validNodes.map((n) => [n.id as string, n]));

  // 拓扑分层：level(node) = max(level(from)) + 1
  const level = new Map<string, number>();
  for (const n of validNodes) {
    level.set(n.id as string, 0);
  }
  for (let pass = 0; pass < validNodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      if (!e.from || !e.to || !nodeMap.has(e.from) || !nodeMap.has(e.to)) {
        continue;
      }
      const next = Math.max(level.get(e.to) ?? 0, (level.get(e.from) ?? 0) + 1);
      if (next !== level.get(e.to)) {
        level.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  // 悬空边（指向不存在节点的）忽略

  // 按层分组，每层节点横向排列并水平居中
  const layers = new Map<number, { id: string; label: string }[]>();
  const layerWidths = new Map<number, number>();
  for (const n of validNodes) {
    const l = level.get(n.id as string) ?? 0;
    const list = layers.get(l) ?? [];
    list.push({ id: n.id as string, label: nodeMap.get(n.id as string)?.label ?? "" });
    layers.set(l, list);
    layerWidths.set(l, list.length * NODE_W + (list.length - 1) * H_GAP);
  }
  const maxLayerWidth = Math.max(...[...layerWidths.values()]);
  const layerCount = layers.size;

  // 放置起点：画布有内容时放在内容包围盒右下方，否则放在视口中心
  const els = board.serialize();
  let originX = 0;
  let originY = 0;
  if (els.length) {
    const maxX = Math.max(...els.map((e) => e.x + (e.width ?? 0)));
    const maxY = Math.max(...els.map((e) => e.y + (e.height ?? 0)));
    originX = maxX + 80;
    originY = maxY + 80;
  } else {
    const view = board.app.canvas.view as HTMLElement;
    const w = board.app.width ?? view.clientWidth;
    const h = board.app.height ?? view.clientHeight;
    const inner = board.app.tree.getInnerPoint({ x: w / 2, y: h / 2 });
    originX = inner.x - maxLayerWidth / 2;
    originY = inner.y - 120;
  }

  // 生成元素
  const idMap = new Map<string, string>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const [l, list] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const layerWidth = layerWidths.get(l) ?? 0;
    const startX = originX + (maxLayerWidth - layerWidth) / 2;
    list.forEach((n, i) => {
      const x = startX + i * (NODE_W + H_GAP);
      const y = originY + l * (NODE_H + V_GAP);
      positions.set(n.id, { x, y });
      const elId = board.addElement({
        type: "rect",
        x,
        y,
        width: NODE_W,
        height: NODE_H,
        stroke: "#4f8cff",
        strokeWidth: 2,
        fill: "rgba(79, 140, 255, 0.12)",
      });
      if (elId) {
        idMap.set(n.id, elId);
      }
      if (n.label) {
        board.addElement({
          type: "text",
          x: x + 8,
          y: y + (NODE_H - TEXT_FONT_SIZE) / 2 - 2,
          text: n.label,
          fontSize: TEXT_FONT_SIZE,
          fill: "#ffffff",
        });
      }
    });
  }
  for (const e of edges) {
    if (!e.from || !e.to) {
      continue;
    }
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) {
      continue;
    }
    const dx = to.x - from.x;
    // 连线：不同层时从起点底部中心指向终点顶部中心；同层时从侧面水平相连
    const horizontal = level.get(e.to) === level.get(e.from) ? 1 : 0;
    const sx = from.x + NODE_W / 2;
    const sy = from.y + (horizontal ? NODE_H / 2 : NODE_H);
    const tx =
      to.x +
      NODE_W / 2 +
      (horizontal ? (dx > 0 ? -NODE_W / 2 : NODE_W / 2) : 0);
    const ty = to.y + (horizontal ? NODE_H / 2 : 0);
    board.addElement({
      type: "arrow",
      x: 0,
      y: 0,
      width: Math.abs(tx - sx),
      height: Math.abs(ty - sy),
      points: [
        { x: sx, y: sy },
        { x: tx, y: ty },
      ],
      stroke: "#4f8cff",
      strokeWidth: 1.5,
    });
  }

  const mapping = [...idMap.entries()]
    .map(([nid, eid]) => `${nid}=${eid}`)
    .join("，");
  return `已生成流程图：${validNodes.length} 个节点、${edges.length} 条连线，起点位于画布 (${Math.round(originX)}, ${Math.round(originY)})。节点 id 映射：${mapping}（后续可用这些 id 引用）`;
}

/** 执行工具调用，返回给模型的文本结果与是否改动画布 */
export function executeTool(
  tool: AiTool,
  rawArgs: string,
  ctx: AiToolContext,
): AiToolExecution {
  const { board, mode } = ctx;
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return { name: tool.name, args: {}, result: "错误：工具参数不是合法 JSON", changed: false };
  }

  switch (tool.name) {
    case "get_canvas":
      return {
        name: tool.name,
        args,
        result: `当前画布元素数据：\n${describeCanvas(board)}`,
        changed: false,
      };

    case "draw_flowchart":
      if (mode !== "chat") {
        return { name: tool.name, args, result: "错误：draw_flowchart 仅交流模式可用", changed: false };
      }
      return {
        name: tool.name,
        args,
        result: drawFlowchart(board, args),
        changed: true,
      };

    case "add_element": {
      if (mode !== "edit") {
        return { name: tool.name, args, result: "错误：编辑画布工具仅在编辑模式可用", changed: false };
      }
      const data = args as unknown as ElementData;
      const id = board.addElement(data);
      if (!id) {
        return { name: tool.name, args, result: "错误：元素数据不合法（未知 type 或缺少必要字段）", changed: false };
      }
      return {
        name: tool.name,
        args,
        result: `已添加元素 id=${id}（${data.type}${data.text ? `，文字"${data.text}"` : ""}）`,
        changed: true,
      };
    }

    case "update_element": {
      if (mode !== "edit") {
        return { name: tool.name, args, result: "错误：编辑画布工具仅在编辑模式可用", changed: false };
      }
      const id = typeof args.id === "string" ? args.id : "";
      const patch = (args.patch ?? {}) as Parameters<Board["updateElement"]>[1];
      if (!board.updateElement(id, patch)) {
        return { name: tool.name, args, result: `错误：元素 ${id || "(未提供)"} 不存在或已锁定`, changed: false };
      }
      return { name: tool.name, args, result: `已更新元素 ${id}：${JSON.stringify(patch)}`, changed: true };
    }

    case "delete_element": {
      if (mode !== "edit") {
        return { name: tool.name, args, result: "错误：编辑画布工具仅在编辑模式可用", changed: false };
      }
      const id = typeof args.id === "string" ? args.id : "";
      if (!board.deleteElementById(id)) {
        return { name: tool.name, args, result: `错误：元素 ${id || "(未提供)"} 不存在或已锁定`, changed: false };
      }
      return { name: tool.name, args, result: `已删除元素 ${id}`, changed: true };
    }

    case "apply_selection": {
      if (mode !== "edit") {
        return { name: tool.name, args, result: "错误：编辑画布工具仅在编辑模式可用", changed: false };
      }
      const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
      if (!board.selectByIds(ids)) {
        return { name: tool.name, args, result: `错误：id 列表 ${JSON.stringify(ids)} 均未命中画布元素`, changed: false };
      }
      return { name: tool.name, args, result: `已选中元素：${ids.join("、")}`, changed: false };
    }

    default:
      return { name: tool.name, args, result: `错误：未知工具 ${tool.name}`, changed: false };
  }
}
