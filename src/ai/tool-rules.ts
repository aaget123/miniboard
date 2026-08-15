// 统一功能规则（单一来源）：AI 提示词渲染与执行端校验共用同一份规则定义，
// 修改规则时只需改这里，避免提示词与代码校验漂移。

/** 自定义工具允许的行为类别（与 registry.CUSTOM_KINDS 保持一致） */
export const TOOL_KIND_RULES: {
  value: "drag" | "click";
  label: string;
  desc: string;
}[] = [
  {
    value: "drag",
    label: "drag（拖拽生成）",
    desc: "默认。根据拖拽范围动态计算形状，拖拽中实时预览",
  },
  {
    value: "click",
    label: "click（点击生成）",
    desc: "点击即生成固定大小元素（印章、便利贴、标注等），生成器收到 x0=x1=点击点，必须用固定尺寸、以点击点 (x0,y0) 为几何中心输出，禁止随机大小/随机位置（Math.random 会被冒烟测试拒绝）",
  },
];

/** 工具栏分组规则（与 registry 校验保持一致） */
export const TOOL_GROUP_RULES = [
  {
    value: "shape",
    label: "shape（形状▾）",
    desc: "拖拽生成闭合形状的工具（三角形、五角星、多边形、圆角矩形、菱形等）必须归入此组，与已有形状工具放在一起",
  },
  {
    value: "ai",
    label: "ai（AI 工具▾）",
    desc: "未指定 group 时的默认分组，收纳到“AI 工具▾”下拉，避免平铺顶栏",
  },
];

/** 生成器可返回的元素类型（与 validate.ts 保持一致） */
export const GENERATABLE_TYPES = ["rect", "ellipse", "line", "arrow", "path", "text"];

/** 生成器返回值：单个元素或元素数组（组合工具，最多 8 个） */
export const GENERATOR_RETURN_DESC =
  "ElementData 或 ElementData[]（组合工具：一次生成多个相关元素，如标题+下划线；最多 8 个）";

/** 生成器禁止使用的代码（与 registry.scanGeneratorSource 保持一致，冒烟测试会拒绝） */
export const GENERATOR_FORBIDDEN_DESC =
  "while 循环、无限 for 循环、eval、new Function、DOM API（document/window）、网络请求（fetch/XMLHttpRequest/WebSocket）、存储（localStorage/sessionStorage）、定时器（setTimeout/setInterval）、动态 import、Worker；click 点击类工具额外禁止 Math.random 等随机函数";

/** 渲染“统一功能规则”章节（编辑模式系统提示词用） */
export function renderToolRules(): string {
  const kinds = TOOL_KIND_RULES.map(
    (k) => `- ${k.label}：${k.desc}`,
  ).join("\n");
  const groups = TOOL_GROUP_RULES.map(
    (g) => `- ${g.label}：${g.desc}`,
  ).join("\n");
  return `## 统一功能规则

工具条目结构：
- id：唯一标识（自定义工具由系统自动分配，形如 tool-xxx）
- name：名称，如"五角星"
- icon：按钮图标，一个字符或短符号，如 ★
- shortcut：可选单字母快捷键（与现有工具冲突会被拒绝，k 已被 AI 助手面板占用）
- kind：行为类别，自定义工具可选：
${kinds}
- group：可选分组，与同类型工具收纳在同一下拉按钮中（见"分组规则"）
- generator：生成器函数体源码
- description：工具用途说明（可选）

生成器接口：
- 签名：(ctx) => ElementData 或 ElementData[]
- ctx 字段：x0、y0（拖拽起点画布坐标）、x1、y1（当前拖拽点坐标；click 工具 x0=x1、y0=y1 均为点击点）、style（当前样式：stroke 描边色、strokeWidth 粗细、fillEnabled 填充开关、fillColor 填充色）
- 单个元素必须包含 type（${GENERATABLE_TYPES.join("/")} 之一）与位置尺寸：
  - rect/ellipse：x、y、width、height（左上角 + 宽高，允许负数方向拖拽需取 min/abs）
  - line/arrow：points 端点数组 [{x,y},{x,y}]（画布绝对坐标），x/y 置 0
  - path：path（SVG 路径字符串，画布绝对坐标）+ width/height，**x/y 必须为 0**（leafer 渲染位置 = (x,y) + path，同时设置非零 x/y 与绝对坐标 path 会双重偏移，如星星印章点击后漂移到别处；校验会拒绝非零 x/y）
  - text：text 文字 + x/y + fontSize
- 可选：stroke（线条/描边色）、strokeWidth、fill（填充色）、rotation
- 组合工具返回数组时：第一个元素是主元素（拖拽中实时预览），其余元素在松手时一次性补齐，全部合并为一步撤销
- 拖拽过程中生成器会被反复调用（随 x1、y1 变化），必须根据 x1、y1 动态计算形状；不要使用固定数值（click 工具除外，用固定尺寸）
- click 点击类工具：用固定尺寸、以 (x0, y0) 为几何中心（如星星印章中心在点击点）；不要用 Math.random 随机尺寸或随机偏移，否则每次点击大小/位置漂移、行为不可预期，会被冒烟测试拒绝
- 不要返回 fill 为 "none" 的字符串（leafer 中会渲染成黑色实心），无填充时省略 fill 或返回 undefined
- 只能使用纯 JavaScript 数学计算，禁止：${GENERATOR_FORBIDDEN_DESC}

分组规则：

工具栏把同类型的工具收纳在同一个下拉按钮里（如"形状▾"）。添加/修改工具前先调用 list_tools 查看现有工具的 group 字段，遵循：
${groups}
- 不允许设置其他分组值（如 select 是内置框选/套索工具的专属分组）

验证与反馈：

添加/修改工具时系统会先验证生成器（危险代码扫描 → 隔离执行 → 返回值格式校验），未通过会返回具体原因（如"生成器包含不允许的代码：while 循环"、"第 1 个元素：line/arrow 需要至少 2 个 points 点"），请根据原因修正生成器后重试；验证通过后会自动在画布右侧试画示例元素，可直接看到工具效果。`;
}
