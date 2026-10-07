// aiempire-chatter: the AI chatter's Cloudflare Worker.
//   GET  /          – is it running?
//   GET  /setup     – connects the Telegram control bot and links your account
//   POST /telegram  – updates from the control bot

import "./env";
import { handleUpdate } from "./control/bot";
import { createClaimCode, getOwner } from "./db";
import { tg, webhookSecret } from "./telegram";

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
      ctx.waitUntil(handleUpdate(env, update).catch((e) => console.error("update failed", e)));
      return new Response("ok");
    }

    if (url.pathname === "/setup") return setupPage(env, url);

    return page("AI chatter", "<p>✅ The AI chatter is running.</p><p>First time? Open <a href=\"/setup\">/setup</a>.</p>");
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
