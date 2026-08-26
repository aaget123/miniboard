import { isDesktop } from "../storage";
import type { AiConfig, AiToolCall, ChatMessage } from "./types";

/** 单轮补全结果 */
export type ChatTurnResult = {
  /** 本轮流式输出的文本（追加到消息气泡） */
  text: string;
  /** 本轮模型请求的工具调用（若有） */
  toolCalls: AiToolCall[];
};

export type ChatCallbacks = {
  /** 流式文本增量（渲染到气泡） */
  onText?: (delta: string) => void;
};

/** 浏览器直接 fetch；Tauri 桌面端经 plugin-http 转发（绕开 CORS） */
async function httpFetch(url: string, init: RequestInit): Promise<Response> {
  if (isDesktop()) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return fetch(url, init);
  }
  return fetch(url, init);
}

/** 对话请求超时（ms）：流式需读完整个回复，覆盖较长的生成时长 */
const CHAT_TIMEOUT = 90_000;
/** 模型列表/连接探测超时（ms）：接口应秒级响应，超时即判定不可用 */
const PROBE_TIMEOUT = 15_000;

/**
 * 组合外部取消信号与内部超时的 fetch：任一触发即中断请求。
 * 外部信号用于面板“停止”按钮；超时到抛 DOMException(TimeoutError)。
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("请求超时", "TimeoutError")),
    ms,
  );
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) {
    ctrl.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", onAbort);
  }
  try {
    return await httpFetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function chatURL(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function headers(cfg: AiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };
}

/** 解析 OpenAI 兼容 SSE 流，累积文本与工具调用 */
function parseSSE(body: string): ChatTurnResult {
  let text = "";
  const toolCalls: AiToolCall[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    let chunk: {
      choices?: { delta?: { content?: string | null; tool_calls?: unknown[] } }[];
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      continue;
    }
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const item of delta.tool_calls as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[]) {
        const idx = item.index ?? 0;
        let call = toolCalls[idx];
        if (!call) {
          call = { id: "", type: "function", function: { name: "", arguments: "" } };
          toolCalls[idx] = call;
        }
        if (item.id) {
          call.id = item.id;
        }
        if (item.function?.name) {
          call.function.name += item.function.name;
        }
        if (item.function?.arguments) {
          call.function.arguments += item.function.arguments;
        }
      }
    }
  }
  return { text, toolCalls: toolCalls.filter((c) => c.function.name) };
}

/**
 * 请求一轮补全（流式，带 tools）。
 * 返回文本与工具调用；若模型最终未产出内容且无工具调用，返回空结果。
 */
export async function chatTurn(
  cfg: AiConfig,
  messages: ChatMessage[],
  openAiTools: unknown[],
  cb?: ChatCallbacks,
  signal?: AbortSignal,
): Promise<ChatTurnResult> {
  const url = chatURL(cfg.baseURL);
  const body = {
    model: cfg.model,
    messages,
    tools: openAiTools.length ? openAiTools : undefined,
    stream: true,
  };

  // 流式主路径；失败时降级为非流式（个别服务对 stream 参数不友好）
  try {
    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: headers(cfg),
        body: JSON.stringify(body),
      },
      signal,
      CHAT_TIMEOUT,
    );
    if (!resp.ok) {
      throw await toApiError(resp);
    }
    const result = parseSSE(await resp.text());
    cb?.onText?.(result.text);
    return result;
  } catch (err) {
    if (err instanceof Error && /stream/i.test(err.message)) {
      return nonStreamChat(url, cfg, messages, openAiTools, cb, signal);
    }
    throw err;
  }
}

/** 非流式降级：一次返回完整内容或工具调用 */
async function nonStreamChat(
  url: string,
  cfg: AiConfig,
  messages: ChatMessage[],
  openAiTools: unknown[],
  cb?: ChatCallbacks,
  signal?: AbortSignal,
): Promise<ChatTurnResult> {
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({
        model: cfg.model,
        messages,
        tools: openAiTools.length ? openAiTools : undefined,
      }),
    },
    signal,
    CHAT_TIMEOUT,
  );
  if (!resp.ok) {
    throw await toApiError(resp);
  }
  const json = (await resp.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[];
  };
  const message = json.choices?.[0]?.message;
  const text = message?.content ?? "";
  const toolCalls: AiToolCall[] = Array.isArray(message?.tool_calls)
    ? (message.tool_calls as AiToolCall[])
    : [];
  cb?.onText?.(text);
  return { text, toolCalls };
}

/** 把非 2xx 响应转成带服务端错误信息的 Error */
async function toApiError(resp: Response): Promise<Error> {
  let detail = "";
  try {
    const j = (await resp.json()) as { error?: { message?: string } };
    detail = j?.error?.message ?? "";
  } catch {
    // 响应体不是 JSON，忽略
  }
  return new Error(`请求失败 (HTTP ${resp.status})${detail ? `：${detail}` : ""}`);
}

// ================= 模型查询与连接测试 =================

/** 拉取服务端模型列表（OpenAI 兼容 GET /models，15s 超时） */
export async function fetchModels(cfg: AiConfig): Promise<string[]> {
  // baseURL 可能已含 /chat/completions，统一替换为 /models
  const url = chatURL(cfg.baseURL).replace(/\/chat\/completions$/, "/models");
  const resp = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: headers(cfg),
    },
    undefined,
    PROBE_TIMEOUT,
  );
  if (!resp.ok) {
    throw await toApiError(resp);
  }
  const json = (await resp.json()) as { data?: { id?: string }[] };
  return (json.data ?? [])
    .map((m) => m.id)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

export type ConnectionTestResult = {
  ok: boolean;
  /** 服务端模型列表（/models 成功时返回） */
  models: string[];
  /** 展示用消息 */
  message: string;
  /** 是否支持工具调用（function calling）；不支持时编辑模式不可用 */
  tools: boolean;
};

/**
 * 工具调用能力探测：发一次携带假工具的最小请求。
 * - 正常响应（任何形状）→ 支持工具调用；
 * - HTTP 400 且报文提及 tool/function → 不支持；
 * - 其他失败（网络/鉴权等）→ 无法判定，按支持处理（交由主流程报错）。
 */
async function probeToolCalling(cfg: AiConfig): Promise<boolean> {
  try {
    const resp = await fetchWithTimeout(
      chatURL(cfg.baseURL),
      {
        method: "POST",
        headers: headers(cfg),
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
          tools: [
            {
              type: "function",
              function: {
                name: "__capability_probe",
                description: "capability probe",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        }),
      },
      undefined,
      PROBE_TIMEOUT,
    );
    if (resp.ok) {
      return true;
    }
    if (resp.status === 400 || resp.status === 404) {
      const text = await resp.text().catch(() => "");
      return !/tool|function/i.test(text);
    }
    return true;
  } catch {
    // 探测本身失败不作为「不支持」依据：主流程已有连接结果兜底
    return true;
  }
}

function withToolHint(message: string, tools: boolean): string {
  return tools
    ? message
    : `${message}；⚠ 该端点未通过工具调用探测，编辑模式可能不可用`;
}

/**
 * 测试连接：优先 GET /models（一次验证 Key 并取模型列表），
 * 服务不支持 /models 时降级为最小 chat 请求（max_tokens=1，不产生可见输出）。
 */
export async function testConnection(cfg: AiConfig): Promise<ConnectionTestResult> {
  try {
    const models = await fetchModels(cfg);
    const tools = await probeToolCalling(cfg);
    return {
      ok: true,
      models,
      tools,
      message: withToolHint(
        models.length
          ? `连接成功，可用模型 ${models.length} 个`
          : "连接成功（服务未返回模型列表）",
        tools,
      ),
    };
  } catch (modelsErr) {
    const modelsMsg =
      modelsErr instanceof Error ? modelsErr.message : String(modelsErr);
    try {
      const resp = await fetchWithTimeout(
        chatURL(cfg.baseURL),
        {
          method: "POST",
          headers: headers(cfg),
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            stream: false,
          }),
        },
        undefined,
        PROBE_TIMEOUT,
      );
      if (!resp.ok) {
        throw await toApiError(resp);
      }
      const tools = await probeToolCalling(cfg);
      return {
        ok: true,
        models: [],
        tools,
        message: withToolHint(
          "连接成功（该服务未提供 /models 接口，已通过最小请求验证）",
          tools,
        ),
      };
    } catch (chatErr) {
      const chatMsg = chatErr instanceof Error ? chatErr.message : String(chatErr);
      return {
        ok: false,
        models: [],
        tools: false,
        message: `连接失败：/models 不可用（${modelsMsg}）；最小请求：${chatMsg}`,
      };
    }
  }
}
