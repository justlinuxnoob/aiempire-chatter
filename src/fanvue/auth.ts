// "Connect Fanvue": OAuth 2.0 + PKCE, encrypted token storage, refresh.
// Docs: https://api.fanvue.com/docs/authentication/overview

import { decrypt, encrypt, pkce, randomToken } from "../crypto";
import { addAlert, getOwner } from "../db";
import { esc, send } from "../telegram";

export const SCOPES = [
  "openid",
  "offline_access",
  "offline",
  "read:self", // her profile, webhooks
  "read:chat", // read fan messages
  "write:chat", // reply, typing, mark read
  "read:fan", // fan profiles
  "read:media", // vault (step 4)
  "write:media", // upload generated photos (step 5)
  "read:insights", // what a fan has spent
  "read:creator", // purchase notifications
].join(" ");

export const authBase = (env: Env) => env.FANVUE_AUTH || "https://auth.fanvue.com";
export const callbackUrl = (origin: string) => `${origin}/fanvue/callback`;

export interface Account {
  member_id: string;
  creator_uuid: string;
  handle: string | null;
  display_name: string | null;
  status: "connected" | "disconnected";
  webhook_id: string | null;
  webhook_secret: string | null;
}

export async function getAccount(env: Env, memberId: string): Promise<Account | null> {
  return env.DB.prepare(
    "SELECT member_id, creator_uuid, handle, display_name, status, webhook_id, webhook_secret FROM fanvue_accounts WHERE member_id = ?",
  ).bind(memberId).first<Account>();
}

export async function accountByCreator(env: Env, creatorUuid: string): Promise<Account | null> {
  return env.DB.prepare(
    "SELECT member_id, creator_uuid, handle, display_name, status, webhook_id, webhook_secret FROM fanvue_accounts WHERE creator_uuid = ?",
  ).bind(creatorUuid).first<Account>();
}

export async function connectedAccounts(env: Env): Promise<Account[]> {
  const { results } = await env.DB.prepare(
    "SELECT member_id, creator_uuid, handle, display_name, status, webhook_id, webhook_secret FROM fanvue_accounts WHERE status = 'connected'",
  ).all<Account>();
  return results;
}

/** The link the owner taps to connect (or reconnect) Fanvue. Valid for 30 minutes. */
export async function connectLink(env: Env, memberId: string, origin: string, forceLogin = false): Promise<string> {
  const state = randomToken();
  const { verifier, challenge } = await pkce();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE created_at < ?").bind(Date.now() - 30 * 60_000),
    env.DB.prepare("INSERT INTO oauth_states (state, member_id, verifier, created_at) VALUES (?, ?, ?, ?)")
      .bind(state, memberId, verifier, Date.now()),
  ]);
  const params = new URLSearchParams({
    client_id: env.FANVUE_CLIENT_ID,
    redirect_uri: callbackUrl(origin),
    response_type: "code",
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Ask Fanvue to show its login page even if some account is already signed in.
    ...(forceLogin ? { prompt: "login" } : {}),
  });
  return `${authBase(env)}/oauth2/auth?${params}`;
}

/** Fanvue sends the owner back here after they approve. Returns the member id. */
export async function finishConnect(
  env: Env, url: URL,
): Promise<{ memberId: string } | { error: string; retryLink?: string }> {
  const state = url.searchParams.get("state") ?? "";
  const error = url.searchParams.get("error");
  if (error) {
    const pending = await env.DB.prepare("SELECT member_id FROM oauth_states WHERE state = ?").bind(state).first<{ member_id: string }>();
    return {
      error: `Fanvue said: ${url.searchParams.get("error_description") || error}`,
      retryLink: pending ? await connectLink(env, pending.member_id, url.origin, true) : undefined,
    };
  }
  const code = url.searchParams.get("code") ?? "";
  const row = await env.DB.prepare("SELECT member_id, verifier, created_at FROM oauth_states WHERE state = ?")
    .bind(state).first<{ member_id: string; verifier: string; created_at: number }>();
  if (!row || Date.now() - row.created_at > 30 * 60_000) {
    return { error: "This connect link expired or was already used. Send /fanvue in Telegram for a fresh one." };
  }
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();

  const tokens = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(url.origin),
    code_verifier: row.verifier,
  });
  if ("error" in tokens) return { error: tokens.error };

  const me = await meWith(env, tokens.access_token);
  if (!me) return { error: "Connected, but couldn't read the Fanvue profile. Try again." };
  if (!me.isCreator) return { error: `@${me.handle} is not a creator account. Connect the creator account (hers).` };

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO fanvue_accounts (member_id, creator_uuid, handle, display_name, is_ai_creator, access_token, refresh_token, expires_at, scope, status, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)
     ON CONFLICT (member_id) DO UPDATE SET creator_uuid = excluded.creator_uuid, handle = excluded.handle,
       display_name = excluded.display_name, is_ai_creator = excluded.is_ai_creator, access_token = excluded.access_token,
       refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, scope = excluded.scope,
       refreshing_until = NULL, status = 'connected', updated_at = excluded.updated_at`,
  ).bind(
    row.member_id, me.uuid, me.handle, me.displayName, me.isAiCreator ? 1 : 0,
    await encrypt(env, tokens.access_token), await encrypt(env, tokens.refresh_token),
    now + tokens.expires_in * 1000, tokens.scope ?? SCOPES, now, now,
  ).run();
  return { memberId: row.member_id };
}

/** A valid access token, refreshing it if it's about to expire. */
export async function accessToken(env: Env, memberId: string): Promise<string> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const row = await env.DB.prepare(
      "SELECT access_token, refresh_token, expires_at, refreshing_until, status FROM fanvue_accounts WHERE member_id = ?",
    ).bind(memberId).first<any>();
    if (!row || row.status !== "connected") throw new FanvueDisconnected();
    if (row.expires_at - Date.now() > 120_000) return decrypt(env, row.access_token);

    // Refresh tokens are single-use, so only one refresh may run at a time: take a short lock.
    const now = Date.now();
    const lock = await env.DB.prepare(
      "UPDATE fanvue_accounts SET refreshing_until = ? WHERE member_id = ? AND (refreshing_until IS NULL OR refreshing_until < ?)",
    ).bind(now + 20_000, memberId, now).run();
    if (!lock.meta.changes) {
      await new Promise((r) => setTimeout(r, 1000)); // someone else is refreshing: wait for their result
      continue;
    }
    const tokens = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: await decrypt(env, row.refresh_token) });
    if ("error" in tokens) {
      if (tokens.fatal) await markDisconnected(env, memberId, tokens.error);
      else await env.DB.prepare("UPDATE fanvue_accounts SET refreshing_until = NULL WHERE member_id = ?").bind(memberId).run();
      throw tokens.fatal ? new FanvueDisconnected() : new Error(tokens.error);
    }
    // Save the new refresh token before anything else uses it.
    await env.DB.prepare(
      "UPDATE fanvue_accounts SET access_token = ?, refresh_token = ?, expires_at = ?, refreshing_until = NULL, updated_at = ? WHERE member_id = ?",
    ).bind(
      await encrypt(env, tokens.access_token), await encrypt(env, tokens.refresh_token),
      Date.now() + tokens.expires_in * 1000, Date.now(), memberId,
    ).run();
    return tokens.access_token;
  }
  throw new Error("Timed out waiting for a Fanvue token refresh");
}

/** Force the next accessToken() call to refresh (used after a 401). */
export async function expireToken(env: Env, memberId: string): Promise<void> {
  await env.DB.prepare("UPDATE fanvue_accounts SET expires_at = 0 WHERE member_id = ?").bind(memberId).run();
}

export class FanvueDisconnected extends Error {
  constructor() {
    super("Fanvue is not connected");
  }
}

async function markDisconnected(env: Env, memberId: string, why: string): Promise<void> {
  await env.DB.prepare("UPDATE fanvue_accounts SET status = 'disconnected', refreshing_until = NULL, updated_at = ? WHERE member_id = ?")
    .bind(Date.now(), memberId).run();
  await addAlert(env, memberId, null, "fanvue_disconnected", why);
  const owner = await getOwner(env);
  if (owner) await send(env, owner.telegram_chat_id, `⚠️ <b>Fanvue got disconnected</b> (${esc(why)}). She can't read or answer fans until you reconnect: send /fanvue.`);
}

type TokenResult =
  | { access_token: string; refresh_token: string; expires_in: number; scope?: string }
  | { error: string; fatal: boolean };

async function tokenRequest(env: Env, form: Record<string, string>): Promise<TokenResult> {
  const res = await fetch(`${authBase(env)}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.FANVUE_CLIENT_ID}:${env.FANVUE_CLIENT_SECRET}`),
    },
    body: new URLSearchParams(form),
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.ok && data.access_token && data.refresh_token) return data;
  const err = data.error_description || data.error || `HTTP ${res.status}`;
  // invalid_grant / invalid_client: retrying won't help, the owner has to reconnect.
  return { error: `Fanvue login failed: ${err}`, fatal: ["invalid_grant", "invalid_client", "unauthorized_client"].includes(data.error) };
}

async function meWith(env: Env, token: string): Promise<any | null> {
  const res = await fetch(`${env.FANVUE_API || "https://api.fanvue.com"}/v1/users/me`, {
    headers: { Authorization: `Bearer ${token}`, "X-Fanvue-API-Version": "2025-06-26" },
  });
  return res.ok ? res.json() : null;
}
