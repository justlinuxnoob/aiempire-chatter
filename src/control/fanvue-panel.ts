// /fanvue in the control bot: connect, choose the mode, add your test fan account.

import { getSettings, randomId, setSetting, type Member } from "../db";
import { esc, send, type Button } from "../telegram";
import { connectLink, getAccount } from "../fanvue/auth";
import { modeOf, type FanvueMode } from "../fanvue/inbound";

const MODES: Record<FanvueMode, { button: string; text: string }> = {
  test: { button: "🧪 Test", text: "🧪 <b>Test</b>: she only answers your test fan account. Real fans are ignored." },
  dryrun: { button: "👀 Dry-run", text: "👀 <b>Dry-run</b>: she reads real fans and shows you here what she would reply. Nothing is sent." },
  live: { button: "🟢 Live", text: "🟢 <b>Live</b>: she answers every fan on Fanvue." },
};

export async function showFanvue(env: Env, owner: Member, origin: string): Promise<void> {
  if (!env.FANVUE_CLIENT_ID || !env.FANVUE_CLIENT_SECRET) {
    await send(
      env,
      owner.telegram_chat_id,
      `🔗 <b>Fanvue app keys missing.</b>\nAdd <b>FANVUE_CLIENT_ID</b> and <b>FANVUE_CLIENT_SECRET</b> in Cloudflare (Workers &amp; Pages → your Worker → Settings → Variables and Secrets, type Secret).\nYour Fanvue app's redirect must be exactly:\n<code>${esc(origin)}/fanvue/callback</code>`,
    );
    return;
  }
  const account = await getAccount(env, owner.id);
  const link = await connectLink(env, owner.id, origin);
  if (!account || account.status !== "connected") {
    await send(
      env,
      owner.telegram_chat_id,
      `🔗 <b>Fanvue isn't connected${account ? " anymore" : " yet"}.</b>\nTap the button, log in to Fanvue as <b>her</b> creator account, and approve. (The link works for 30 minutes.)`,
      [[{ text: "🔗 Connect Fanvue", url: link }]],
    );
    return;
  }

  const mode = modeOf(await getSettings(env, owner.id));
  const { results: testFans } = await env.DB.prepare("SELECT handle FROM fans WHERE member_id = ? AND is_test = 1")
    .bind(owner.id).all<{ handle: string | null }>();
  const fans = testFans.map((f) => `@${esc(f.handle ?? "?")}`).join(", ") || "none yet";

  const modeButtons: Button[] = (Object.keys(MODES) as FanvueMode[]).map((m) => ({
    text: (m === mode ? "• " : "") + MODES[m].button,
    callback_data: `fv:mode:${m}`,
  }));
  await send(
    env,
    owner.telegram_chat_id,
    `✅ Connected to Fanvue as <b>@${esc(account.handle ?? "")}</b>\n\n<b>Mode</b>\n${MODES[mode].text}\n\n<b>Test fan accounts:</b> ${fans}`,
    [modeButtons, [{ text: "➕ Add my test fan account", callback_data: "fv:testfan" }], [{ text: "🔄 Reconnect Fanvue", url: link }]],
  );
}

export async function onFanvueButton(env: Env, owner: Member, action: string, origin: string): Promise<void> {
  const chatId = owner.telegram_chat_id;

  if (action === "testfan") {
    const code = `test-${randomId(5)}`;
    await setSetting(env, owner.id, "test_code", code);
    await setSetting(env, owner.id, "test_code_expires", String(Date.now() + 15 * 60_000));
    await send(
      env,
      chatId,
      `➕ <b>Add your test fan account</b>\n\n1. Log in to Fanvue with your <b>fan</b> account (not hers).\n2. Send her this exact message:\n\n<code>${code}</code>\n\nI'll recognize the account within a minute. The code works for 15 minutes.`,
    );
    return;
  }

  const mode = action.replace(/^mode:/, "").replace(/!$/, "") as FanvueMode;
  if (!MODES[mode]) return;
  if (mode === "live" && !action.endsWith("!")) {
    await send(env, chatId, "🟢 <b>Go live?</b>\nEvery fan who messages her on Fanvue will get her replies, including unread messages waiting right now.", [
      [{ text: "✅ Yes, go live", callback_data: "fv:mode:live!" }, { text: "Cancel", callback_data: "fv:mode:cancel" }],
    ]);
    return;
  }
  await setSetting(env, owner.id, "fanvue_mode", mode);
  await send(env, chatId, `Mode changed.\n${MODES[mode].text}`);
  await showFanvue(env, owner, origin);
}

export async function fanvueStatusLine(env: Env, memberId: string): Promise<string> {
  const account = await getAccount(env, memberId);
  if (!account) return "🔗 Fanvue: not connected (/fanvue)";
  if (account.status !== "connected") return "⚠️ Fanvue: disconnected, reconnect with /fanvue";
  const mode = modeOf(await getSettings(env, memberId));
  return `✅ Fanvue: @${esc(account.handle ?? "")} · ${MODES[mode].button}`;
}
