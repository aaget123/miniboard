// AI 对话历史的分桶持久化辅助（纯函数，无 DOM 依赖，便于单测）
import type { AiContentPart, ChatMessage } from "./types";

/** 对话存档 localStorage 键前缀：miniboard:ai-chat:{projectId}:{mode} */
export const LS_CHAT_PREFIX = "miniboard:ai-chat:";
/** 存档保留的最近 user 轮次数（治理后仅存文本，体积可控） */
export const MAX_PERSIST_TURNS = 12;

/** 多模态内容取纯文本（图片片段不落盘、不重渲染，降级为文本） */
export function textOf(content: string | AiContentPart[] | null): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

/**
 * 存档治理：只保留 user/assistant 纯文本轮次——
 * 丢弃 tool 轮次（画布 JSON 快照与图片 dataURL 会过期且体积大）、
 * 工具调用轮的 tool_calls 字段（配对 tool 消息已丢弃，残留即非法序列）、
 * 纯图片消息与空消息；最后截断为最近 MAX_PERSIST_TURNS 个 user 轮次，
 * 并保证开头为 user（部分 OpenAI 兼容 API 拒绝以 assistant 开头的历史）。
 */
export function sanitizeForStorage(history: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === "tool") {
      continue;
    }
    if (m.role === "assistant" && m.tool_calls) {
      const text = textOf(m.content);
      if (!text.trim()) {
        continue;
      }
      out.push({ role: "assistant", content: text });
      continue;
    }
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (!text.trim()) {
        continue;
      }
      out.push({ role: m.role, content: text });
      continue;
    }
    if (typeof m.content !== "string" || !m.content.trim()) {
      continue;
    }
    out.push({ ...m });
  }
  // 开头必须为 user（恢复数据可能以残留 assistant 开头）
  while (out.length && out[0].role !== "user") {
    out.shift();
  }
  const userIdx: number[] = [];
  out.forEach((m, i) => {
    if (m.role === "user") {
      userIdx.push(i);
    }
  });
  const drop = Math.max(0, userIdx.length - MAX_PERSIST_TURNS);
  return drop > 0 ? out.slice(userIdx[drop]) : out;
}
