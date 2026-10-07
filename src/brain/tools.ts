// The tools the chat brain can use. Step 2 is text only; list_catalog,
// send_ppv and generate_image arrive in steps 4 and 5.

import type { FanProfile } from "../db";
import type { ChatMessage, ToolCall } from "./prompt";

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const TOOLS = [
  tool(
    "reply",
    "Text him. 1 to 3 short messages, sent one after another.",
    { messages: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 } },
    ["messages"],
  ),
  tool(
    "remember",
    "Save something about him for later: his name, likes, job, mood, plans.",
    {
      name: { type: "string", description: "His first name, if he told you" },
      fact: { type: "string", description: "One short fact, e.g. 'works night shifts as a nurse'" },
    },
    [],
  ),
  tool("get_fan_profile", "What you know about him: name, notes, what he bought, how much he spent.", {}, []),
];

export const LLM_SETTINGS = {
  model: "chatter",
  max_tokens: 400,
  temperature: 0.8,
  top_p: 0.9,
  top_k: 20,
  // Qwen thinks before answering by default; for texting that's slow and wasted.
  chat_template_kwargs: { enable_thinking: false },
};

export interface Parsed {
  calls: { id: string; name: string; args: any; bad?: string }[];
  text: string;
  raw: ChatMessage;
}

/** Read the model's answer: tool calls (with parsed arguments) and any plain text. */
export function parseCompletion(output: any): Parsed {
  const message = output?.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = message.tool_calls ?? [];
  const calls = toolCalls.map((c) => {
    try {
      return { id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || "{}") };
    } catch {
      return { id: c.id, name: c.function.name, args: {}, bad: "arguments were not valid JSON" };
    }
  });
  const text = stripThinking(message.content ?? "");
  return {
    calls,
    text,
    raw: { role: "assistant", content: message.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
  };
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** reply's messages, cleaned: trimmed, non-empty, max 3. */
export function replyMessages(args: any): string[] {
  const list = Array.isArray(args?.messages) ? args.messages : typeof args?.messages === "string" ? [args.messages] : [];
  return list
    .map((m: unknown) => String(m ?? "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

/** Apply remember() to a profile. Keeps at most 30 notes, no duplicates. */
export function applyRemember(profile: FanProfile, args: any): FanProfile {
  const next: FanProfile = { ...profile, notes: [...(profile.notes ?? [])] };
  if (typeof args?.name === "string" && args.name.trim()) next.name = args.name.trim().slice(0, 40);
  if (typeof args?.fact === "string" && args.fact.trim()) {
    const fact = args.fact.trim().slice(0, 200);
    if (!next.notes!.some((n) => n.toLowerCase() === fact.toLowerCase())) next.notes!.push(fact);
    next.notes = next.notes!.slice(-30);
  }
  return next;
}

/** If the model answered with plain text instead of the reply tool, use it anyway. */
export function textAsMessages(text: string): string[] {
  return text
    .split(/\n+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3);
}
