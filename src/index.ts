// aiempire-chatter: the AI chatter's Cloudflare Worker.
//   GET  /          – is it running?
//   GET  /setup     – connects the Telegram control bot and links your account
//   POST /telegram  – updates from the control bot
//   GET  /fanvue/callback – back from "Connect Fanvue"
//   POST /fanvue/webhook  – Fanvue pushes new fan messages here

import "./env";
import { handleUpdate } from "./control/bot";
import { createClaimCode, getOwner, randomId, setSetting } from "./db";
import { connectLink } from "./fanvue/auth";
import { fv } from "./fanvue/api";
import { tg, webhookSecret } from "./telegram";
import { FAN_TYPES } from "./sim/fans";
import { handleCallback, trySetupWebhook } from "./fanvue/connect";
import { handleWebhook, pollUnread } from "./fanvue/inbound";

export { FanChat } from "./chat/fanchat";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env))) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      // Answer Telegram right away; do the work in the background.
      ctx.waitUntil(handleUpdate(env, update, url.origin).catch((e) => console.error("update failed", e)));
      return new Response("ok");
    }

    if (url.pathname === "/setup") return setupPage(env, url);

    if (url.pathname === "/fanvue/callback") {
      const result = await handleCallback(env, url);
      return page(result.title, result.body);
    }
    if (url.pathname === "/fanvue/webhook" && request.method === "POST") return handleWebhook(env, request, ctx);

    if (url.pathname.startsWith("/admin/") && request.method === "POST") return admin(env, request, url);

    return page("AI chatter", "<p>✅ The AI chatter is running.</p><p>First time? Open <a href=\"/setup\">/setup</a>.</p>");
  },

  // Every minute: catch any Fanvue message the webhook missed.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(pollUnread(env));
  },
} satisfies ExportedHandler<Env>;

async function setupPage(env: Env, url: URL): Promise<Response> {
  const missing = ["TELEGRAM_BOT_TOKEN", "RUNPOD_API_KEY"].filter((k) => !env[k as keyof Env]);
  if (missing.length) {
    return page("Almost there", `<p>❌ Missing in Cloudflare: <b>${missing.join(", ")}</b>.</p>
      <p>Add them in the Cloudflare dashboard: Workers &amp; Pages → this Worker → Settings → Variables and Secrets.
      Then open this page again.</p>`);
  }

  const me = await tg(env, "getMe", {});
  if (!me.ok) return page("Telegram problem", `<p>❌ Telegram doesn't accept the bot token. Check <b>TELEGRAM_BOT_TOKEN</b>.</p>`);
  const hook = await tg(env, "setWebhook", {
    url: `${url.origin}/telegram`,
    secret_token: await webhookSecret(env),
    allowed_updates: ["message", "callback_query"],
  });
  if (!hook.ok) return page("Telegram problem", `<p>❌ Telegram said: ${escapeHtml(hook.description ?? "unknown error")}</p>`);

  const bot = `@${me.result.username}`;
  if (await getOwner(env)) {
    return page("Connected", `<p>✅ Your control bot <b>${bot}</b> is connected and already linked to your Telegram account.</p>
      <p>Open it in Telegram: <a href="https://t.me/${me.result.username}">t.me/${me.result.username}</a></p>`);
  }
  const code = await createClaimCode(env);
  const link = `https://t.me/${me.result.username}?start=${code}`;
  return page("Last step", `<p>✅ Your control bot <b>${bot}</b> is connected.</p>
    <p>Last step: link it to <b>your</b> Telegram account, so it only listens to you.</p>
    <p><a class="button" href="${link}">Open ${bot} in Telegram</a></p>
    <p class="small">Then tap <b>Start</b> in Telegram. Don't share this page's link: whoever taps it first becomes the owner.</p>`);
}

/**
 * For testing from a script (only if ADMIN_KEY is set): start a simulation or
 * send a message as the owner's test fan. Output goes to the owner's Telegram.
 *   POST /admin/simulate {"type": "shy"}
 *   POST /admin/fan-message {"text": "hey"}
 *   POST /admin/fanvue-connect-link, POST /admin/test-code
 */
async function admin(env: Env, request: Request, url: URL): Promise<Response> {
  if (!env.ADMIN_KEY || request.headers.get("Authorization") !== `Bearer ${env.ADMIN_KEY}`) {
    return new Response("not found", { status: 404 });
  }
  const owner = await getOwner(env);
  if (!owner) return Response.json({ error: "no owner yet" }, { status: 409 });
  const body: any = await request.json().catch(() => ({}));

  if (url.pathname === "/admin/simulate" && FAN_TYPES[body.type]) {
    const chat = env.FAN_CHAT.get(env.FAN_CHAT.idFromName(`${owner.id}:sim`));
    // Script-started simulations stay out of the owner's Telegram; read them with scripts/admin.sh transcript.
    await chat.simulate(owner.id, owner.telegram_chat_id, body.type, true);
    return Response.json({ ok: true });
  }
  if (url.pathname === "/admin/fan-message" && typeof body.text === "string") {
    const fanId = `test:${owner.telegram_user_id}`;
    const chat = env.FAN_CHAT.get(env.FAN_CHAT.idFromName(`${owner.id}:${fanId}`));
    await chat.receive(owner.id, fanId, "test", owner.telegram_chat_id, body.text);
    return Response.json({ ok: true });
  }
  if (url.pathname === "/admin/fanvue-connect-link") {
    return Response.json({ url: await connectLink(env, owner.id, url.origin) });
  }
  if (url.pathname === "/admin/fanvue-raw" && typeof body.path === "string") {
    // Debugging: call the Fanvue API as her and show the raw answer.
    try {
      return Response.json({ ok: true, data: await fv(env, owner.id, body.method ?? "GET", body.path, body.body) });
    } catch (e) {
      return Response.json({ ok: false, error: String((e as Error).message) });
    }
  }
  if (url.pathname === "/admin/fanvue-webhook") {
    return Response.json({ error: await trySetupWebhook(env, owner.id, url.origin) });
  }
  if (url.pathname === "/admin/test-code") {
    // Same as tapping "➕ Add my test fan account" in /fanvue.
    const code = `test-${randomId(5)}`;
    await setSetting(env, owner.id, "test_code", code);
    await setSetting(env, owner.id, "test_code_expires", String(Date.now() + 15 * 60_000));
    return Response.json({ code });
  }
  return Response.json({ error: "unknown admin action" }, { status: 400 });
}

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font:17px/1.5 system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#222;background:#fafafa}
.button{display:inline-block;background:#229ED9;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600}
.small{font-size:14px;color:#666}
</style></head><body><h1>${title}</h1>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
