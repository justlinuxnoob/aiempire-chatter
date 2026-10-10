// The Telegram control bot: the owner's control panel.

export type Button = { text: string; callback_data: string } | { text: string; url: string };

const LIMIT = 4000; // Telegram allows 4096 characters per message

export async function tg(env: Env, method: string, body: Record<string, unknown>): Promise<any> {
  const base = env.TELEGRAM_API || "https://api.telegram.org";
  const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) console.warn(`telegram ${method} failed: ${data.description}`);
  return data;
}

/** Send HTML-formatted text (escape user content with esc()). Long text is split. */
export async function send(env: Env, chatId: string, html: string, buttons?: Button[][]): Promise<void> {
  const parts = split(html);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: parts[i],
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(last && buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }
}

/** Send text exactly as written, no formatting (for persona text the owner will copy). */
export async function sendPlain(env: Env, chatId: string, text: string): Promise<void> {
  for (const part of split(text)) await tg(env, "sendMessage", { chat_id: chatId, text: part });
}

/** Send a photo (raw bytes) with an optional caption and buttons. */
export async function sendPhoto(env: Env, chatId: string, bytes: Uint8Array, caption: string, buttons?: Button[][]): Promise<boolean> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption.slice(0, 1000));
  form.append("photo", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
  if (buttons) form.append("reply_markup", JSON.stringify({ inline_keyboard: buttons }));
  const base = env.TELEGRAM_API || "https://api.telegram.org";
  const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
  const data: any = await res.json().catch(() => ({}));
  if (!data.ok) console.warn(`telegram sendPhoto failed: ${data.description ?? res.status}`);
  return !!data.ok;
}

export function typing(env: Env, chatId: string): Promise<any> {
  return tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
}

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Telegram sends this back with every update, so strangers can't post fake updates. */
export async function webhookSecret(env: Env): Promise<string> {
  const data = new TextEncoder().encode("aiempire-chatter:" + env.TELEGRAM_BOT_TOKEN);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

function split(text: string): string[] {
  if (text.length <= LIMIT) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf("\n", LIMIT);
    if (cut < LIMIT / 2) cut = LIMIT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}
