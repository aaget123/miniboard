// AI 功能共享类型

/** 交流模式：对话/评价/建议/画流程图；编辑模式：增删改画布元素 */
export type AiMode = "chat" | "edit";

export type AiConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 模型是否支持视觉输入（多模态）：开启后交流模式发送画布截图，默认关闭 */
  multimodal?: boolean;
};

/** 一个已注册的模型配置条目（多配置管理：设置弹窗中新增/编辑/选择） */
export type AiProfile = AiConfig & {
  /** 配置条目唯一 id */
  id: string;
  /** 显示名称 */
  name: string;
};

/** 模型配置存储：当前激活条目 + 全部条目 */
export type AiProfileStore = {
  activeId: string;
  profiles: AiProfile[];
};

export type AiRole = "system" | "user" | "assistant" | "tool";

export type AiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON 字符串（流式时逐片累积） */
    arguments: string;
  };
};

/** 多模态内容片段：文本或图片（视觉模型用，图片为 dataURL） */
export type AiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: AiRole;
  /** 纯文本，或多模态内容数组（视觉模型）；工具调用轮可为 null */
  content: string | AiContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: AiToolCall[];
};

/** 工具定义（OpenAI 兼容 tools 格式） */
export type AiTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 工具是否修改画布（会话据此合并历史/展示回执） */
  mutating?: boolean;
};

/** 工具执行结果（回填给模型 + 面板展示） */
export type AiToolExecution = {
  name: string;
  /** 解析后的参数（面板展示用） */
  args: Record<string, unknown>;
  /** 回给模型的文本结果 */
  result: string;
  /** 是否实际修改了画布 */
  changed: boolean;
  /** 功能区工具快照（add/update/remove_tool 成功时附带，面板渲染工具卡片用） */
  tool?: { name: string; icon: string; shortcut?: string; group?: string; kind?: string };
};
