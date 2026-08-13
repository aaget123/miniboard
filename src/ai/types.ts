// AI 功能共享类型

/** 交流模式：对话/评价/建议/画流程图；编辑模式：增删改画布元素 */
export type AiMode = "chat" | "edit";

export type AiConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
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

export type ChatMessage = {
  role: AiRole;
  content: string | null;
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
};
