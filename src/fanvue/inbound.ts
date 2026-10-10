// Fan messages coming in from Fanvue, two ways:
//   1. webhook: Fanvue pushes creator.message.received the moment a fan writes
//   2. every minute (cron), as a safety net: unread chats whose last message we haven't seen
// Both end in route(), which decides whether she answers (mode, test fans).

import { hmacHex, sameText } from "../crypto";
import { getFan, getOwner, getSettings, setSetting } from "../db";
import { esc, send } from "../telegram";
import { connectedAccounts, getAccount, type Account } from "./auth";
import { markRead, recentChatMessages, unreadChats } from "./api";
import { decrypt } from "../crypto";

export type FanvueMode = "test" | "dryrun" | "live";

export const modeOf = (settings: Record<string, string>): FanvueMode =>
  (["test", "dryrun", "live"].includes(settings.fanvue_mode) ? settings.fanvue_mode : "test") as FanvueMode;

export interface Incoming {
  fanUuid: string;
  messageUuid: string;
  text: string;
  handle?: string;
  displayName?: string;
  sentAt?: string | null;
}

// Older messages are never answered (e.g. the backlog of unread chats when going live).
const MAX_AGE = 24 * 3600_000;

// Fanvue system/automation messages she should never answer.
const SKIP_TYPES = /^(AUTOMATED_|BROADCAST|GHOST_PROMOTION|MARKETING_|VOICE_CALL)/;

// ── webhook ──────────────────────────────────────────────────────────────

export async function handleWebhook(env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.text();
  const signature = request.headers.get("X-Fanvue-Signature") ?? "";
  let account: Account | null = null;
  for (const a of await connectedAccounts(env)) {
    if (a.webhook_secret && (await validSignature(await decrypt(env, a.webhook_secret), raw, signature))) {
      account = a;
      break;
    }
  }
  if (!account) return new Response("bad signature", { status: 401 });

  const event = JSON.parse(raw);
  ctx.waitUntil(onEvent(env, account, event).catch((e) => console.error("fanvue event failed", e)));
  return new Response("ok");
}

/** X-Fanvue-Signature: t=<unix>,v0=<hex HMAC-SHA256 of "t.body">, max 5 minutes old. */
export async function validSignature(secret: string, raw: string, header: string): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  if (!parts.v0 || !t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const payload = `${t}.${raw}`;
  if (sameText(await hmacHex(secret, payload), parts.v0)) return true;
  // Docs don't say whether the "whsec_" prefix is part of the key; accept the hex-key form too.
  const hex = secret.replace(/^whsec_/, "");
  if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) {
    const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    if (sameText(await hmacHex(bytes, payload), parts.v0)) return true;
  }
  return false;
}

async function onEvent(env: Env, account: Account, event: any): Promise<void> {
  const d = event?.data ?? {};
  if (event?.type === "creator.message.received") {
    if (d.sender !== "fan" || d.is_automated || SKIP_TYPES.test(d.message_type ?? "")) return;
    const text = describe(d.text, (d.media_uuids ?? []).length > 0, d.tip?.price);
    if (!text) return;
    await route(env, account, {
      fanUuid: d.fan.uuid,
      messageUuid: d.uuid,
      text,
      handle: d.fan.handle,
      displayName: d.fan.display_name,
    });
  }
  // creator.payment.succeeded is used from step 4 (purchases).
}

/** What the fan "said", in words she can react to. */
function describe(text: string | undefined | null, hasMedia: boolean, tipCents?: number): string {
  const parts: string[] = [];
  if (text?.trim()) parts.push(text.trim());
  if (hasMedia) parts.push("[he sent a photo]");
  if (tipCents) parts.push(`[he sent a $${(tipCents / 100).toFixed(2)} tip]`);
  return parts.join(" ");
}

// ── every-minute safety net ──────────────────────────────────────────────

export async function pollUnread(env: Env): Promise<void> {
  for (const account of await connectedAccounts(env)) {
    try {
      await pollAccount(env, account);
    } catch (e) {
      console.error("poll failed", account.member_id, e);
    }
  }
}

async function pollAccount(env: Env, account: Account): Promise<void> {
  const settings = await getSettings(env, account.member_id);
  const mode = modeOf(settings);
  const chats = await unreadChats(env, account.member_id);
  // Capped so one run stays well inside the free plan's 50 outgoing requests.
  for (const chat of chats.slice(0, 15)) {
    const last = chat.lastMessage;
    if (!last || last.senderUuid === account.creator_uuid || last.senderRole !== "FAN") continue;
    if (await alreadySeen(env, account.member_id, last.uuid)) continue;
    const fan = await getFan(env, account.member_id, chat.user.uuid);
    if (mode === "test" && !fan?.is_test && !isTestCode(settings, last.text ?? "")) continue; // real fans untouched in test mode

    const messages = (await recentChatMessages(env, account.member_id, chat.user.uuid, 10)).reverse();
    for (const m of messages) {
      if (m.sender.uuid === account.creator_uuid || SKIP_TYPES.test(m.type ?? "")) continue;
      if (await alreadySeen(env, account.member_id, m.uuid)) continue;
      const text = fanText(m.text);
      await route(env, account, {
        fanUuid: chat.user.uuid,
        messageUuid: m.uuid,
        text,
        handle: chat.user.handle,
        displayName: chat.user.displayName,
        sentAt: m.sentAt,
      });
    }
  }
}

/** A message without text (the list endpoint doesn't say what it was) is usually a photo or a tip. */
function fanText(text: string | null): string {
  return describe(text, false) || "[he sent you something without text, probably a photo]";
}

/**
 * Fan messages in this chat that aren't in the database yet, oldest first.
 * The conversation calls this right after marking the chat read, so a message that
 * arrived since the last poll isn't lost (a read chat no longer shows up as unread).
 */
export async function unseenFanMessages(env: Env, memberId: string, fanUuid: string): Promise<{ uuid: string; text: string }[]> {
  const account = await getAccount(env, memberId);
  if (!account) return [];
  const out: { uuid: string; text: string }[] = [];
  for (const m of (await recentChatMessages(env, memberId, fanUuid, 10)).reverse()) {
    if (m.sender.uuid === account.creator_uuid || SKIP_TYPES.test(m.type ?? "")) continue;
    if (m.sentAt && Date.now() - Date.parse(m.sentAt) > MAX_AGE) continue;
    if (await alreadySeen(env, memberId, m.uuid)) continue;
    out.push({ uuid: m.uuid, text: fanText(m.text) });
  }
  return out;
}

async function alreadySeen(env: Env, memberId: string, messageUuid: string): Promise<boolean> {
  return !!(await env.DB.prepare(
    "SELECT 1 FROM messages WHERE member_id = ?1 AND external_id = ?2 UNION SELECT 1 FROM seen_messages WHERE member_id = ?1 AND external_id = ?2",
  ).bind(memberId, messageUuid).first());
}

async function markSeen(env: Env, memberId: string, messageUuid: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO seen_messages (member_id, external_id, created_at) VALUES (?, ?, ?)")
    .bind(memberId, messageUuid, Date.now()).run();
}

// ── routing ──────────────────────────────────────────────────────────────

function isTestCode(settings: Record<string, string>, text: string): boolean {
  return !!settings.test_code && Number(settings.test_code_expires) > Date.now() && text.trim().toLowerCase() === settings.test_code;
}

export async function route(env: Env, account: Account, msg: Incoming): Promise<void> {
  const memberId = account.member_id;
  const settings = await getSettings(env, memberId);
  const owner = await getOwner(env);
  if (!owner) return;

  // The owner sent the one-time code from their test fan account: remember that account.
  if (isTestCode(settings, msg.text)) {
    await env.DB.prepare(
      `INSERT INTO fans (member_id, fan_id, source, display_name, handle, is_test, created_at, updated_at) VALUES (?, ?, 'fanvue', ?, ?, 1, ?, ?)
       ON CONFLICT (member_id, fan_id) DO UPDATE SET is_test = 1, handle = excluded.handle, display_name = excluded.display_name`,
    ).bind(memberId, msg.fanUuid, msg.displayName ?? null, msg.handle ?? null, Date.now(), Date.now()).run();
    await setSetting(env, memberId, "test_code", "");
    await markSeen(env, memberId, msg.messageUuid); // the code itself is not a chat message to answer
    await markRead(env, memberId, msg.fanUuid);
    await send(env, owner.telegram_chat_id, `✅ <b>@${esc(msg.handle ?? "your account")}</b> is now your test fan. Message Mia from that account on Fanvue and she'll answer.`);
    return;
  }

  const fan = await getFan(env, memberId, msg.fanUuid);
  if (modeOf(settings) === "test" && !fan?.is_test) return;
  if (msg.sentAt && Date.now() - Date.parse(msg.sentAt) > MAX_AGE) {
    await markSeen(env, memberId, msg.messageUuid);
    return;
  }

  const chat = env.FAN_CHAT.get(env.FAN_CHAT.idFromName(`${memberId}:fv:${msg.fanUuid}`));
  await chat.receive(memberId, msg.fanUuid, "fanvue", owner.telegram_chat_id, msg.text, {
    externalId: msg.messageUuid,
    handle: msg.handle,
    displayName: msg.displayName,
  });
}
