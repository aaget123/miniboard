import type { AiMode, AiTool } from "./types";

// ================= 工具定义（schemas） =================
//
// 从 tools.ts 拆出的纯数据层：只描述「模型能看到什么工具与参数」，
// 不含任何执行逻辑（执行器见 tools.ts 的 executeTool）。

/** 画布感知工具：交流/编辑模式共用（只读，不修改画布） */
function getCanvasTool(): AiTool {
  return {
    name: "get_canvas",
    description:
      "获取画布元素的结构化 JSON 数据（坐标、颜色、文字内容、形状描述等），用于理解画布上有什么；可传 ids 只看指定元素（如用户 @ 的选区），或传 viewport/bounds 只看某个世界坐标区域（如当前视口）内的元素。返回内容附带整体摘要：元素数量与类型统计、内容范围、空间分布（元素集中在哪个区域、哪里空旷）、当前视口范围与缩放、坐标系说明、背景色；每个元素带 region 字段（中心在内容包围盒九宫格中的位置）与形状描述，AI 创建的元素带 intent 字段（创建时自报的意图）；line/arrow 的 points 为画布绝对坐标。增量感知：全量调用时若画布自上次获取后没有变化，只返回简短的「无变化」摘要；有变化时默认只返回增量变更集（新增 / 更新元素的完整数据 + 删除元素的 id 清单），未变更元素不再重复返回，需要完整快照时传 full:true。请勿在画布未修改时反复调用（浪费轮次与 token），需要细化时用 ids/bounds/viewport 参数定向获取",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "可选：元素 id 列表，只返回这些元素的数据；不传则返回全部",
        },
        full: {
          type: "boolean",
          description:
            "可选：true 时跳过增量感知，强制返回完整快照（默认有变化时只返回增量变更集）",
        },
        viewport: {
          type: "boolean",
          description:
            "可选：true 时只返回当前视口（使用者当前看到的区域）内的元素；与 bounds 同时传时以 viewport 为准",
        },
        bounds: {
          type: "object",
          description:
            "可选：只返回位于该世界坐标矩形区域内的元素（元素与区域相交即返回；坐标系与元素坐标、摘要中的视口范围同基准：左上角原点、y 轴向下、单位 px）",
          properties: {
            minX: { type: "number", description: "区域左边界（世界坐标）" },
            minY: { type: "number", description: "区域上边界（世界坐标）" },
            maxX: { type: "number", description: "区域右边界（世界坐标）" },
            maxY: { type: "number", description: "区域下边界（世界坐标）" },
          },
        },
      },
    },
  };
}

/** 读图工具：按 id 读取画布图片的实际内容（压缩 dataURL，视觉模型可看图） */
function readImageTool(): AiTool {
  return {
    name: "read_image",
    description:
      "读取画布中一张图片的实际内容（返回压缩后的图片数据，视觉模型可直接看到图里的内容，如照片、截图、标志等）。get_canvas 对图片只返回尺寸、看不到内容；当你需要评价、识别或针对图片内容给出建议时调用。参数 id 为图片元素的稳定 id（来自 get_canvas 或 @选区）；一次只读一张，多张请多次调用；返回的图片已压缩，分辨率可能低于原图",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "图片元素的稳定 id" },
      },
      required: ["id"],
    },
  };
}

/** 澄清提问工具：中断工具循环等待用户结构化回答（面板接管执行） */
function askUserTool(): AiTool {
  return {
    name: "ask_user",
    description:
      "向用户提出澄清问题并等待其结构化回答：当需求存在多种理解、缺少关键信息（如要画几列、什么风格、先做哪部分）或需要在方案之间做出选择时调用本工具，而不是擅自假设。一次只问一个主题；options 提供候选答案（2~4 个短选项）时用户可直接点选，也可自由输入。返回用户的回答文本；用户也可能跳过不答",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "要问用户的问题（具体、自包含；不要一次塞多个问题）",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "可选：候选答案列表（2~4 个，每个尽量 ≤10 字）",
        },
      },
      required: ["question"],
    },
  };
}

/** 交流模式：理解画布 + 可视化流程 + 澄清提问 */
function chatTools(): AiTool[] {
  return [
    getCanvasTool(),
    readImageTool(),
    askUserTool(),
    {
      name: "draw_flowchart",
      description:
        "把用户的想法、计划或流程表达成流程图并写入主画布：给出节点（含文字）与节点间的连线关系，前端自动分层排版并写入画布（连线为正交折线并绑定节点，节点移动连线跟随）。可用 direction 选择从上到下（TB，默认）或从左到右（LR）布局，hGap/vGap 微调间距",
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
          direction: {
            type: "string",
            enum: ["TB", "LR"],
            description: "可选：布局方向——TB 自上而下（默认）；LR 自左向右",
          },
          hGap: {
            type: "number",
            description: "可选：同层相邻节点的水平间距 px（TB 布局生效，默认 60，范围 20~200）",
          },
          vGap: {
            type: "number",
            description: "可选：层与层的垂直间距 px（TB 布局生效，默认 90，范围 20~300）",
          },
        },
        required: ["nodes"],
      },
      mutating: true,
    },
    {
      name: "update_elements",
      description:
        "优化/修改画布元素：按 id 更新元素属性（stroke 描边色、fill 填充色、strokeWidth 粗细、x/y/width/height 位置尺寸、rotation 旋转、text 文字内容、fontSize 字号，line/arrow 可改 points 端点，path 可改 path）。points 请传画布绝对坐标（与 get_canvas/@选区数据一致，系统自动换算回元素坐标）；path 使用相对元素左上角 (x,y) 的局部坐标，否则会错位。只应修改用户 @ 选中或明确指定的元素；整轮改动会合并为一步撤销",
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
    {
      name: "arrange_elements",
      description:
        "批量排列画布元素（对齐/分布/翻转/层序）：一次调用对多个元素做几何整理，坐标计算由前端完成，不要自己心算坐标。动作：align-left/align-centerX/align-right/align-top/align-centerY/align-bottom 为对齐（以目标集合整体包围盒为基准，对齐需至少 2 个元素）；distribute-h/distribute-v 为均匀分布（需至少 3 个元素）；flip-h/flip-v 为翻转（绕集合中心镜像，单元素也可）；front/back/forward/backward 为层序（置顶/置底/上移/下移一层）。ids 为元素 id 列表（来自 get_canvas 或 @选区）；锁定元素自动跳过；同组成员整组参与（只传组内一个 id 即可）；目标不足或已在目标位置时自动跳过（无效果）。与 update_elements 的分工：改属性（颜色/文字/坐标等）用 update_elements，批量几何整理用 arrange_elements",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要操作的元素 id 列表（对齐需 ≥2、分布需 ≥3 才有实际效果）",
          },
          action: {
            type: "string",
            enum: [
              "align-left",
              "align-centerX",
              "align-right",
              "align-top",
              "align-centerY",
              "align-bottom",
              "distribute-h",
              "distribute-v",
              "flip-h",
              "flip-v",
              "front",
              "back",
              "forward",
              "backward",
            ],
            description: "要执行的动作",
          },
        },
        required: ["ids", "action"],
      },
      mutating: true,
    },
    {
      name: "delete_elements",
      description:
        "按 id 删除画布元素：ids 为元素 id 列表（来自 get_canvas 或 @选区）；仅在使用者明确要求删除时调用；锁定元素自动跳过；同组成员整组参与（只传组内一个 id 即可）。适合「删掉/去掉/移除这些元素」类请求",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要删除的元素 id 列表",
          },
        },
        required: ["ids"],
      },
      mutating: true,
    },
    {
      name: "beautify_elements",
      description:
        "把手绘笔迹整理为标准图形（beautify）：闭合笔迹识别为圆/椭圆/矩形/三角形/多边形等标准元素，近似直线转为标准线段，其余弯曲线条拉直简化；保留颜色与粗细。只整理 ids 指定的元素，其他元素原样不动；ids 为元素 id 列表（来自 get_canvas 或 @选区）；锁定元素自动跳过；同组成员整组参与（只传组内一个 id 即可）；没有手绘笔迹的目标会自动跳过（返回未执行时不要重复提交相同调用）。适合“整理/识别/清理这些手绘图形”类请求",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要整理的元素 id 列表（手绘笔迹 freehand 才有效果）",
          },
        },
        required: ["ids"],
      },
      mutating: true,
    },
    {
      name: "sketchify_elements",
      description:
        "把标准图形转为 rough 手绘风格（矩形/椭圆/直线/箭头/标准多边形）：双线+抖动描边，抖动 seed 随元素保存（撤销/重载后形态可复现）；已手绘元素自动跳过。ids 为元素 id 列表（来自 get_canvas 或 @选区）；锁定元素自动跳过；同组成员整组参与；无可转换目标时自动跳过（返回未执行时不要重复提交相同调用）。适合“把这些图形变成手绘风格”类请求",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要手绘化的元素 id 列表（标准图形才有有效果）",
          },
        },
        required: ["ids"],
      },
      mutating: true,
    },
    {
      name: "set_roughness",
      description:
        "调整已手绘元素的粗糙度（0~2，步进 0.1；0 = 接近规整，2 = 抖动最强）：以同一抖动 seed 即时重绘，抖动态不变仅幅度变化。ids 为元素 id 列表；无手绘元数据的元素自动跳过；锁定元素自动跳过；同组成员整组参与。适合“更粗糙一点/更规整一点”类请求",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要调整粗糙度的元素 id 列表（已手绘元素才有效果）",
          },
          value: {
            type: "number",
            description: "粗糙度 0~2（0.1 步进）",
          },
        },
        required: ["ids", "value"],
      },
      mutating: true,
    },
    {
      name: "create_elements",
      description:
        '用 leafer 官方 JSON 格式在画布上创建元素（rect/ellipse/line/arrow/path/text/image），返回创建的 id。字段规则：x/y 必填；rect/ellipse 可省略 width/height（默认 100）；text 需要 text 字符串（可选 fontSize）；path 需要 path 字符串（相对元素左上角的局部坐标）；image 需要 url；可选 stroke/strokeWidth/fill/rotation；可选 intent（简短中文自报创建意图，如"流程起点"、"标题"——系统会保存并在 get_canvas 返回，供后续轮次理解你的设计意图）。禁止 fill 传字符串 "none"（会渲染成黑色实心），无填充时省略 fill。line/arrow 的 points 传画布绝对坐标（至少 2 个点，系统自动换算）。不需要传 id（系统分配）。一次创建多个元素时请自行规划好坐标避免重叠',
      parameters: {
        type: "object",
        properties: {
          elements: {
            type: "array",
            items: {
              type: "object",
              description: "一个 leafer 官方格式元素（type/x/y 必填）",
              additionalProperties: true,
            },
            description: "要创建的元素数组",
          },
        },
        required: ["elements"],
      },
      mutating: true,
    },
  ];
}

/** 编辑模式：画布感知（只读）+ 按统一功能规则管理功能区（自定义工具增删改查） */
function editTools(): AiTool[] {
  return [
    getCanvasTool(),
    readImageTool(),
    {
      name: "list_tools",
      description:
        "查看功能区绘制工具（内置 + AI 生成的）的 id、名称、图标、快捷键、类型。可选 id 过滤单个工具；includeSource=true 或按 id 过滤时附带自定义工具的 generator 源码——修改工具前必须先取源码做增量修改，不要凭记忆重写",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "可选：只查这一个工具（自动附带其 generator 源码）" },
          includeSource: {
            type: "boolean",
            description: "可选：true 时为所有自定义工具附带 generator 源码",
          },
        },
      },
    },
    {
      name: "add_tool",
      description:
        "按统一功能规则添加一个新绘制工具：提供名称、图标、可选快捷键、行为类别与生成器代码（生成器接收拖拽上下文 ctx 返回元素数据或元素数据数组，详见系统提示中的规则与示例）。添加前系统会验证生成器（危险代码/超时/返回值格式），未通过会返回具体原因，请修正后重试；通过后会自动在画布右侧试画示例供查看。id 由系统自动分配",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "工具名称，如 五角星" },
          icon: { type: "string", description: "按钮图标，一个字符或短符号，如 ★" },
          shortcut: {
            type: "string",
            description: "可选单字母快捷键（不能与现有工具冲突）",
          },
          kind: {
            type: "string",
            enum: ["drag", "click"],
            description:
              "行为类别：drag 拖拽生成（默认，根据拖拽范围动态计算形状）；click 点击即生成固定大小元素（如印章、便利贴）",
          },
          group: {
            type: "string",
            enum: ["shape"],
            description:
              '可选：工具分组。与已有同类型工具归入同一分组：形状类工具（拖拽生成闭合形状，如三角形/五角星/多边形/圆角矩形等）必须传 "shape" 归入“形状▾”下拉；其他类型省略',
          },
          generator: {
            type: "string",
            description:
              "生成器函数体源码：(ctx) => ElementData 或 ElementData[]（组合工具），ctx={x0,y0,x1,y1,style}",
          },
          description: { type: "string", description: "工具用途说明" },
        },
        required: ["name", "icon", "generator"],
      },
      mutating: true,
    },
    {
      name: "update_tool",
      description:
        "修改已存在的自定义工具（名称/图标/快捷键/生成器/说明/分组/行为类别）；内置工具只读不可修改。修改生成器时同样会验证（危险代码/超时/返回值格式），未通过不会生效",
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
              kind: { type: "string", enum: ["drag", "click"] },
              group: { type: "string", enum: ["shape"] },
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
