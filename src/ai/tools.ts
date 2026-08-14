import type { Board } from "../board/canvas";
import { TEXT_FONT_SIZE } from "../board/canvas";
import type { ToolRegistry } from "../board/registry";
import type { Toolbar } from "../ui/toolbar";
import type { CustomToolInput, ElementData } from "../types";
import type { AiMode, AiTool, AiToolExecution } from "./types";

// ================= 画布感知（非多模态：把画布转成 JSON 给模型看） =================

const MAX_DESCRIBE = 300;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 解析 SVG path 的命令结构，输出形状描述（代替原始路径字符串，token 开销小）。
 * 模型据此可判断三角形/多边形/曲线类形状；手绘笔迹开放且首尾接近时提示间距辅助推断。
 */
function describePath(path: string, w: number, h: number): string {
  const letters = path.match(/[MLHVQCSTAZ]/gi) ?? [];
  const counts: Record<string, number> = {};
  for (const ch of letters) {
    const c = ch.toLowerCase();
    counts[c] = (counts[c] ?? 0) + 1;
  }
  const lines = (counts.l ?? 0) + (counts.h ?? 0) + (counts.v ?? 0);
  const curves =
    (counts.q ?? 0) +
    (counts.c ?? 0) +
    (counts.s ?? 0) +
    (counts.t ?? 0) +
    (counts.a ?? 0);
  // 无 Z 时按首尾距离判断近似闭合（容差 = 尺寸 5%，最小 6px）；H/V 结尾无法取终点则跳过
  let gap = -1;
  const lastCmd = letters[letters.length - 1]?.toLowerCase() ?? "";
  if (/[lqctsa]/.test(lastCmd)) {
    const nums = (path.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
    if (nums.length >= 4) {
      gap = Math.hypot(
        nums[nums.length - 2] - nums[0],
        nums[nums.length - 1] - nums[1],
      );
    }
  }
  const closed =
    (counts.z ?? 0) > 0 || (gap >= 0 && gap < Math.max(6, Math.max(w, h) * 0.05));

  if (closed) {
    if (curves === 0) {
      // 边数 = 顶点数 = M 起点 + L/H/V 命令数；Z 从终点闭合回起点构成最后一条边
      const edges = lines + 1;
      if (edges === 3) return "闭合三角形（3 条直线边）";
      if (edges === 4) return "闭合四边形（4 条直线边）";
      if (edges === 5) return "闭合五边形（5 条直线边，可能是星形）";
      return `闭合多边形（${edges} 条直线边）`;
    }
    if (lines === 0) {
      return `曲线闭合形状（${curves} 段曲线，疑似圆形/椭圆类）`;
    }
    return `闭合路径（直线 ${lines} 段 + 曲线 ${curves} 段，如圆角矩形类）`;
  }
  if (curves === 0) {
    return `开放折线（${lines} 段直线）`;
  }
  if (lines === 0) {
    return gap >= 0
      ? `开放曲线路径（${curves} 段曲线，首尾相距约 ${Math.round(gap)}px）`
      : `开放曲线路径（${curves} 段曲线）`;
  }
  return `开放路径（直线 ${lines} 段 + 曲线 ${curves} 段）`;
}

/**
 * 把画布序列化为紧凑 JSON 描述，供 LLM 理解内容：
 * - path 只保留路径段数（原始 SVG 路径 token 太大）
 * - image 不包含 dataURL 本体，只保留尺寸
 * - 元素过多时截断（最多 MAX_DESCRIBE 个）
 */
export function describeCanvas(board: Board, ids?: string[]): string {
  let all = board.serialize();
  if (ids?.length) {
    const set = new Set(ids);
    all = all.filter((e) => e.id && set.has(e.id));
  }
  const els = all.slice(0, MAX_DESCRIBE);
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
      d.path = describePath(el.path, el.width ?? 0, el.height ?? 0);
    }
    if ((el.type === "line" || el.type === "arrow") && el.points) {
      d.points = el.points.slice(0, 2).map((p) => ({ x: round1(p.x), y: round1(p.y) }));
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
  const over = all.length - MAX_DESCRIBE;
  return (
    JSON.stringify(compact) + (over > 0 ? `\n（另有 ${over} 个元素已省略）` : "")
  );
}

// ================= 工具定义 =================

/** 画布感知工具：交流/编辑模式共用（只读，不修改画布） */
function getCanvasTool(): AiTool {
  return {
    name: "get_canvas",
    description:
      "获取画布元素的结构化 JSON 数据（坐标、颜色、文字内容、形状描述等），用于理解画布上有什么；可传 ids 只看指定元素（如用户 @ 的选区）",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "可选：元素 id 列表，只返回这些元素的数据；不传则返回全部",
        },
      },
    },
  };
}

/** 交流模式：理解画布 + 可视化流程 */
function chatTools(): AiTool[] {
  return [
    getCanvasTool(),
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
                label: {
                  type: "string",
                  description: "节点上显示的文字，尽量简短（10 字内）",
                },
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
    {
      name: "update_elements",
      description:
        "优化/修改画布元素：按 id 更新元素属性（stroke 描边色、fill 填充色、strokeWidth 粗细、x/y/width/height 位置尺寸、rotation 旋转、text 文字内容、fontSize 字号，line/arrow 可改 points 端点，path 可改 path）。只应修改用户 @ 选中或明确指定的元素；整轮改动会合并为一步撤销",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "元素 id（来自 get_canvas 或 @ 选区数据）" },
                patch: {
                  type: "object",
                  description: "要更新的属性；fill 不要传字符串 none（会渲染成黑色实心）",
                  additionalProperties: true,
                },
              },
              required: ["id", "patch"],
            },
            description: "要更新的元素及其属性",
          },
        },
        required: ["updates"],
      },
      mutating: true,
    },
  ];
}

/** 编辑模式：画布感知（只读）+ 按统一功能规则管理功能区（自定义工具增删改查） */
function editTools(): AiTool[] {
  return [
    getCanvasTool(),
    {
      name: "list_tools",
      description:
        "查看功能区全部绘制工具（内置 + AI 生成的）的 id、名称、图标、快捷键、类型",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "add_tool",
      description:
        "按统一功能规则添加一个新绘制工具：提供名称、图标、可选快捷键与生成器代码（生成器接收拖拽上下文 ctx 返回元素数据，详见系统提示中的规则与示例）。id 由系统自动分配",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "工具名称，如 五角星" },
          icon: { type: "string", description: "按钮图标，一个字符或短符号，如 ★" },
          shortcut: {
            type: "string",
            description: "可选单字母快捷键（不能与现有工具冲突）",
          },
          generator: {
            type: "string",
            description: "生成器函数体源码：(ctx) => ElementData，ctx={x0,y0,x1,y1,style}",
          },
          description: { type: "string", description: "工具用途说明" },
        },
        required: ["name", "icon", "generator"],
      },
      mutating: true,
    },
    {
      name: "update_tool",
      description: "修改已存在的自定义工具（名称/图标/快捷键/生成器/说明）；内置工具只读不可修改",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "要修改的工具 id" },
          patch: {
            type: "object",
            properties: {
              name: { type: "string" },
              icon: { type: "string" },
              shortcut: { type: "string" },
              generator: { type: "string" },
              description: { type: "string" },
            },
            description: "要修改的字段",
          },
        },
        required: ["id", "patch"],
      },
      mutating: true,
    },
    {
      name: "remove_tool",
      description: "删除一个 AI 生成的自定义工具；内置工具不可删除",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "要删除的工具 id" },
        },
        required: ["id"],
      },
      mutating: true,
    },
  ];
}

export function toolsForMode(mode: AiMode): AiTool[] {
  return mode === "edit" ? editTools() : chatTools();
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
  registry: ToolRegistry;
  /** 注册表变化后刷新工具栏按钮 */
  toolbar?: Toolbar;
  mode: AiMode;
};

const NODE_W = 180;
const NODE_H = 60;
const H_GAP = 60;
const V_GAP = 90;

/** 把想法画成流程图：分层布局 + 矩形节点 + 文字 + 箭头，写入主画布空白区 */
function drawFlowchart(board: Board, args: Record<string, unknown>): string {
  const nodes = Array.isArray(args.nodes)
    ? (args.nodes as { id?: string; label?: string }[])
    : [];
  if (!nodes.length) {
    return "错误：nodes 不能为空";
  }
  const edges = Array.isArray(args.edges)
    ? (args.edges as { from?: string; to?: string }[])
    : [];
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

  // 按层分组，每层节点横向排列并水平居中
  const layers = new Map<number, { id: string; label: string }[]>();
  const layerWidths = new Map<number, number>();
  for (const n of validNodes) {
    const l = level.get(n.id as string) ?? 0;
    const list = layers.get(l) ?? [];
    list.push({
      id: n.id as string,
      label: nodeMap.get(n.id as string)?.label ?? "",
    });
    layers.set(l, list);
    layerWidths.set(l, list.length * NODE_W + (list.length - 1) * H_GAP);
  }
  const maxLayerWidth = Math.max(...[...layerWidths.values()]);

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
          width: n.label.length * TEXT_FONT_SIZE,
          height: TEXT_FONT_SIZE * 1.4,
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

/** 执行工具调用，返回给模型的文本结果与是否修改了画布/功能区 */
export function executeTool(
  tool: AiTool,
  rawArgs: string,
  ctx: AiToolContext,
): AiToolExecution {
  const { board, registry, mode } = ctx;
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return {
      name: tool.name,
      args: {},
      result: "错误：工具参数不是合法 JSON",
      changed: false,
    };
  }

  switch (tool.name) {
    case "get_canvas": {
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((s): s is string => typeof s === "string")
        : undefined;
      return {
        name: tool.name,
        args,
        result: `当前画布元素数据：\n${describeCanvas(board, ids)}`,
        changed: false,
      };
    }

    case "update_elements": {
      const updates = Array.isArray(args.updates)
        ? (args.updates as { id?: string; patch?: Record<string, unknown> }[])
        : [];
      if (!updates.length) {
        return {
          name: tool.name,
          args,
          result: "错误：updates 不能为空",
          changed: false,
        };
      }
      let ok = 0;
      const failed: string[] = [];
      for (const u of updates) {
        if (!u.id || typeof u.patch !== "object" || u.patch === null) {
          failed.push(u.id ?? "(缺 id)");
          continue;
        }
        const done = board.updateElement(u.id, u.patch as Partial<ElementData>);
        if (done) {
          ok++;
        } else {
          failed.push(u.id);
        }
      }
      return {
        name: tool.name,
        args,
        result: failed.length
          ? `已更新 ${ok} 个元素；失败 ${failed.length} 个：${failed.join("、")}（不存在或已锁定）`
          : `已更新 ${ok} 个元素`,
        changed: ok > 0,
      };
    }

    case "draw_flowchart":
      if (mode !== "chat") {
        return {
          name: tool.name,
          args,
          result: "错误：draw_flowchart 仅交流模式可用",
          changed: false,
        };
      }
      return {
        name: tool.name,
        args,
        result: drawFlowchart(board, args),
        changed: true,
      };

    case "list_tools": {
      if (mode !== "edit") {
        return {
          name: tool.name,
          args,
          result: "错误：功能区管理工具仅在编辑模式可用",
          changed: false,
        };
      }
      const tools = registry.list().map((t) => ({
        id: t.id,
        name: t.name,
        icon: t.icon,
        shortcut: t.shortcut ?? null,
        kind: t.kind,
        source: t.source,
      }));
      return {
        name: tool.name,
        args,
        result: `功能区当前工具（${tools.length} 个）：\n${JSON.stringify(tools)}`,
        changed: false,
      };
    }

    case "add_tool": {
      if (mode !== "edit") {
        return {
          name: tool.name,
          args,
          result: "错误：功能区管理工具仅在编辑模式可用",
          changed: false,
        };
      }
      try {
        const toolDef = registry.addCustom(args as unknown as CustomToolInput);
        ctx.toolbar?.refresh();
        return {
          name: tool.name,
          args,
          result: `已添加工具「${toolDef.name}」，id=${toolDef.id}，图标「${toolDef.icon}」${toolDef.shortcut ? `，快捷键 ${toolDef.shortcut}` : ""}，已出现在工具栏绘制区并可立即拖拽使用`,
          changed: true,
        };
      } catch (err) {
        return {
          name: tool.name,
          args,
          result: `错误：添加失败——${err instanceof Error ? err.message : String(err)}`,
          changed: false,
        };
      }
    }

    case "update_tool": {
      if (mode !== "edit") {
        return {
          name: tool.name,
          args,
          result: "错误：功能区管理工具仅在编辑模式可用",
          changed: false,
        };
      }
      const id = typeof args.id === "string" ? args.id : "";
      const patch = (args.patch ?? {}) as Partial<CustomToolInput>;
      const def = registry.getTool(id);
      if (!def) {
        return {
          name: tool.name,
          args,
          result: `错误：工具 ${id || "(未提供)"} 不存在`,
          changed: false,
        };
      }
      if (def.source !== "custom") {
        return {
          name: tool.name,
          args,
          result: `错误：内置工具「${def.name}」只读，不能修改（只能修改 AI 生成的自定义工具）`,
          changed: false,
        };
      }
      try {
        const updated = registry.updateCustom(id, patch);
        ctx.toolbar?.refresh();
        return {
          name: tool.name,
          args,
          result: `已更新工具「${updated?.name}」（id=${id}）`,
          changed: true,
        };
      } catch (err) {
        return {
          name: tool.name,
          args,
          result: `错误：修改失败——${err instanceof Error ? err.message : String(err)}`,
          changed: false,
        };
      }
    }

    case "remove_tool": {
      if (mode !== "edit") {
        return {
          name: tool.name,
          args,
          result: "错误：功能区管理工具仅在编辑模式可用",
          changed: false,
        };
      }
      const id = typeof args.id === "string" ? args.id : "";
      const def = registry.getTool(id);
      if (!def) {
        return {
          name: tool.name,
          args,
          result: `错误：工具 ${id || "(未提供)"} 不存在`,
          changed: false,
        };
      }
      if (def.source !== "custom") {
        return {
          name: tool.name,
          args,
          result: `错误：内置工具「${def.name}」不可删除（只能删除 AI 生成的自定义工具）`,
          changed: false,
        };
      }
      registry.removeCustom(id);
      ctx.toolbar?.refresh();
      return {
        name: tool.name,
        args,
        result: `已删除工具「${def.name}」（id=${id}），工具栏已刷新`,
        changed: true,
      };
    }

    default:
      return {
        name: tool.name,
        args,
        result: `错误：未知工具 ${tool.name}`,
        changed: false,
      };
  }
}
