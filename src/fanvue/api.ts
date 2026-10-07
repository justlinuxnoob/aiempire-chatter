// Fanvue API calls. Docs: https://api.fanvue.com/docs

import { FanvueDisconnected, accessToken, expireToken } from "./auth";

const VERSION = "2025-06-26";

export class FanvueError extends Error {
  constructor(public status: number, public body: string) {
    super(`Fanvue error ${status}: ${body.slice(0, 300)}`);
  }
}

export async function fv(env: Env, memberId: string, method: string, path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await accessToken(env, memberId);
    const res = await fetch(`${env.FANVUE_API || "https://api.fanvue.com"}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Fanvue-API-Version": VERSION,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) {
      await expireToken(env, memberId); // token went stale early: refresh once and retry
      continue;
    }
    if ((res.status === 429 || res.status >= 502) && attempt < 2) {
      const wait = Math.min(Number(res.headers.get("Retry-After") || 2), 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new FanvueError(res.status, text);
    return text ? JSON.parse(text) : null;
  }
  throw new FanvueDisconnected();
}

export interface ChatSummary {
  user: { uuid: string; handle: string; displayName: string };
  unreadMessagesCount: number;
  lastMessage: { uuid: string; text: string | null; senderUuid: string; senderRole: string; type: string } | null;
}

export async function unreadChats(env: Env, memberId: string): Promise<ChatSummary[]> {
  const res = await fv(env, memberId, "GET", "/v1/chats?filter=unread&size=50");
  return res?.data ?? [];
}

export interface FanvueMessage {
  uuid: string;
  text: string | null;
  sentAt: string | null;
  sender: { uuid: string; handle: string };
  type: string;
}

/** Newest first, like the API. */
export async function recentChatMessages(env: Env, memberId: string, fanUuid: string, limit = 20): Promise<FanvueMessage[]> {
  const res = await fv(env, memberId, "GET", `/v1/chats/${fanUuid}/messages?limit=${limit}&markAsRead=false`);
  return res?.data ?? [];
}

export async function sendMessage(
  env: Env,
  memberId: string,
  fanUuid: string,
  message: { text?: string; mediaUuids?: string[]; price?: number },
): Promise<string> {
  const res = await fv(env, memberId, "POST", `/v1/chats/${fanUuid}/message`, message);
  return res?.messageUuid;
}

export async function showTyping(env: Env, memberId: string, fanUuid: string): Promise<void> {
  await fv(env, memberId, "POST", `/v1/chats/${fanUuid}/typing`, { isTyping: true }).catch(() => {});
}

export async function markRead(env: Env, memberId: string, fanUuid: string): Promise<void> {
  await fv(env, memberId, "PATCH", `/v1/chats/${fanUuid}`, { isRead: true }).catch(() => {});
}

export async function subscribeWebhook(env: Env, memberId: string, url: string): Promise<{ id: string; signingSecret: string }> {
  return fv(env, memberId, "POST", "/v1/webhooks/subscriptions", {
    url,
    events: ["creator.message.received", "creator.payment.succeeded"],
  });
}

export async function deleteWebhook(env: Env, memberId: string, id: string): Promise<void> {
  await fv(env, memberId, "DELETE", `/v1/webhooks/subscriptions/${id}`).catch(() => {});
}
