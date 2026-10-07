// What happens when the owner comes back from approving on Fanvue.

import { encrypt } from "../crypto";
import { getOwner } from "../db";
import { esc, send } from "../telegram";
import { finishConnect, getAccount } from "./auth";
import { deleteWebhook, subscribeWebhook } from "./api";
import { modeOf } from "./inbound";
import { getSettings } from "../db";

export async function handleCallback(env: Env, url: URL): Promise<{ title: string; body: string }> {
  const result = await finishConnect(env, url);
  if ("error" in result) {
    const retry = result.retryLink
      ? `<p>Usually this means Fanvue is signed in as a different account in this browser. Log in again as <b>her</b> creator account:</p>
         <p><a class="button" href="${esc(result.retryLink)}">Log in to Fanvue again</a></p>`
      : "";
    return { title: "Not connected", body: `<p>❌ ${esc(result.error)}</p>${retry}` };
  }

  const webhook = await setupWebhook(env, result.memberId, url.origin);
  const account = await getAccount(env, result.memberId);
  const owner = await getOwner(env);
  const mode = modeOf(await getSettings(env, result.memberId));
  if (owner) {
    await send(
      env,
      owner.telegram_chat_id,
      `✅ <b>Fanvue connected</b> as @${esc(account?.handle ?? "")}.\n` +
        (webhook ? "New messages arrive instantly." : "New messages are checked every minute.") +
        (mode === "test"
          ? "\n\nShe's in 🧪 <b>Test</b> mode: she only answers your own test fan account and ignores real fans.\nNext: send /fanvue and tap <b>➕ Add my test fan account</b>."
          : "") ,
    );
  }
  return {
    title: "Fanvue connected",
    body: `<p>✅ Connected as <b>@${esc(account?.handle ?? "")}</b>.</p><p>You can close this page and go back to Telegram.</p>`,
  };
}

/** Ask Fanvue to push new messages to us. Falls back to the every-minute check if it fails. */
export async function setupWebhook(env: Env, memberId: string, origin: string): Promise<boolean> {
  return (await trySetupWebhook(env, memberId, origin)) === null;
}

/** null on success, otherwise why it failed. */
export async function trySetupWebhook(env: Env, memberId: string, origin: string): Promise<string | null> {
  const account = await getAccount(env, memberId);
  if (account?.webhook_id) await deleteWebhook(env, memberId, account.webhook_id);
  try {
    const sub = await subscribeWebhook(env, memberId, `${origin}/fanvue/webhook`);
    await env.DB.prepare("UPDATE fanvue_accounts SET webhook_id = ?, webhook_secret = ?, updated_at = ? WHERE member_id = ?")
      .bind(sub.id, await encrypt(env, sub.signingSecret), Date.now(), memberId).run();
    return null;
  } catch (e) {
    console.error("webhook subscribe failed", e);
    await env.DB.prepare("UPDATE fanvue_accounts SET webhook_id = NULL, webhook_secret = NULL WHERE member_id = ?").bind(memberId).run();
    return String((e as Error).message ?? e);
  }
}
