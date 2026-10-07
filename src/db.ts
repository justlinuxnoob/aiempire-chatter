// Small helpers over the D1 database. Every query is scoped by member_id.

export type Role = "fan" | "her";
export type Source = "fanvue" | "test" | "sim";

export interface Member {
  id: string;
  telegram_user_id: string;
  telegram_chat_id: string;
}

export interface FanProfile {
  name?: string;
  notes?: string[];
}

export interface Fan {
  fan_id: string;
  source: Source;
  display_name: string | null;
  handle: string | null;
  is_test: boolean;
  profile: FanProfile;
  total_spent_cents: number;
  paused: boolean;
}

export interface Message {
  id: number;
  role: Role;
  text: string;
  created_at: number;
}

const now = () => Date.now();

// ── owner ────────────────────────────────────────────────────────────────

/** This deployment's owner (one per Worker for now). */
export async function getOwner(env: Env): Promise<Member | null> {
  return env.DB.prepare("SELECT id, telegram_user_id, telegram_chat_id FROM members LIMIT 1").first<Member>();
}

export async function createClaimCode(env: Env): Promise<string> {
  const existing = await env.DB.prepare("SELECT code FROM claim_codes LIMIT 1").first<{ code: string }>();
  if (existing) return existing.code;
  const code = randomId(16);
  await env.DB.prepare("INSERT INTO claim_codes (code, created_at) VALUES (?, ?)").bind(code, now()).run();
  return code;
}

/** Link a Telegram account as owner, if the code is right and nobody owns this chatter yet. */
export async function claim(env: Env, code: string, userId: string, chatId: string): Promise<Member | null> {
  if (await getOwner(env)) return null;
  const valid = await env.DB.prepare("SELECT code FROM claim_codes WHERE code = ?").bind(code).first();
  if (!valid) return null;
  const member = { id: "m_" + randomId(10), telegram_user_id: userId, telegram_chat_id: chatId };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO members (id, telegram_user_id, telegram_chat_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(member.id, userId, chatId, now()),
    env.DB.prepare("DELETE FROM claim_codes"),
  ]);
  return member;
}

// ── settings ─────────────────────────────────────────────────────────────

export async function getSettings(env: Env, memberId: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE member_id = ?")
    .bind(memberId).all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function setSetting(env: Env, memberId: string, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (member_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (member_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(memberId, key, value, now()).run();
}

// ── control bot state ────────────────────────────────────────────────────

export type Mode = "setup" | "edit" | "fan";

export async function getMode(env: Env, memberId: string): Promise<{ mode: Mode; field: string | null } | null> {
  return env.DB.prepare("SELECT mode, field FROM control_state WHERE member_id = ?")
    .bind(memberId).first<{ mode: Mode; field: string | null }>();
}

export async function setMode(env: Env, memberId: string, mode: Mode, field: string | null = null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO control_state (member_id, mode, field, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (member_id) DO UPDATE SET mode = excluded.mode, field = excluded.field, updated_at = excluded.updated_at`,
  ).bind(memberId, mode, field, now()).run();
}

export async function clearMode(env: Env, memberId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM control_state WHERE member_id = ?").bind(memberId).run();
}

// ── fans & messages ──────────────────────────────────────────────────────

export async function ensureFan(
  env: Env, memberId: string, fanId: string, source: Source, displayName?: string, handle?: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fans (member_id, fan_id, source, display_name, handle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (member_id, fan_id) DO UPDATE SET
       display_name = COALESCE(excluded.display_name, fans.display_name), handle = COALESCE(excluded.handle, fans.handle)`,
  ).bind(memberId, fanId, source, displayName ?? null, handle ?? null, now(), now()).run();
}

export async function getFan(env: Env, memberId: string, fanId: string): Promise<Fan | null> {
  const row = await env.DB.prepare(
    "SELECT fan_id, source, display_name, handle, profile, total_spent_cents, paused, is_test FROM fans WHERE member_id = ? AND fan_id = ?",
  ).bind(memberId, fanId).first<any>();
  if (!row) return null;
  return { ...row, profile: safeJson(row.profile), paused: !!row.paused, is_test: !!row.is_test };
}

export async function saveFanProfile(env: Env, memberId: string, fanId: string, profile: FanProfile): Promise<void> {
  await env.DB.prepare("UPDATE fans SET profile = ?, updated_at = ? WHERE member_id = ? AND fan_id = ?")
    .bind(JSON.stringify(profile), now(), memberId, fanId).run();
}

export async function pauseFan(env: Env, memberId: string, fanId: string, reason: string): Promise<void> {
  await env.DB.prepare("UPDATE fans SET paused = 1, paused_reason = ?, updated_at = ? WHERE member_id = ? AND fan_id = ?")
    .bind(reason, now(), memberId, fanId).run();
}

/** Returns the new id, or null if this Fanvue message (externalId) was already saved. */
export async function addMessage(
  env: Env, memberId: string, fanId: string, role: Role, text: string, externalId?: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    `INSERT INTO messages (member_id, fan_id, role, text, created_at, external_id) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING RETURNING id`,
  ).bind(memberId, fanId, role, text, now(), externalId ?? null).first<{ id: number }>();
  return row?.id ?? null;
}

/** The last `limit` messages, oldest first. */
export async function recentMessages(env: Env, memberId: string, fanId: string, limit = 40): Promise<Message[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, role, text, created_at FROM messages WHERE member_id = ? AND fan_id = ? ORDER BY id DESC LIMIT ?",
  ).bind(memberId, fanId, limit).all<Message>();
  return results.reverse();
}

export async function lastFanMessageId(env: Env, memberId: string, fanId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT MAX(id) AS id FROM messages WHERE member_id = ? AND fan_id = ? AND role = 'fan'",
  ).bind(memberId, fanId).first<{ id: number | null }>();
  return row?.id ?? 0;
}

/** Forget a fan completely (used for test and simulator fans). */
export async function deleteFan(env: Env, memberId: string, fanId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE member_id = ? AND fan_id = ?").bind(memberId, fanId),
    env.DB.prepare("DELETE FROM fans WHERE member_id = ? AND fan_id = ?").bind(memberId, fanId),
  ]);
}

export async function addAlert(env: Env, memberId: string, fanId: string | null, kind: string, detail: string): Promise<void> {
  await env.DB.prepare("INSERT INTO alerts (member_id, fan_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(memberId, fanId, kind, detail, now()).run();
}

// ── utils ────────────────────────────────────────────────────────────────

export function randomId(length: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
