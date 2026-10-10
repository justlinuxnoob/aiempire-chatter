// /catalog in the control bot: what she sells, at what price, and changing prices.

import { esc, send, type Button } from "../telegram";
import { clearMode, setMode, type Member } from "../db";
import { syncVault } from "../catalog/catalog";
import { getAccount } from "../fanvue/auth";

const PAGE = 10;

export async function showCatalog(env: Env, owner: Member, page = 0): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT media_uuid, description, level, price_cents, enabled, described_at FROM catalog WHERE member_id = ?
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(owner.id, PAGE + 1, page * PAGE).all<any>();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(described_at IS NULL) AS pending FROM catalog WHERE member_id = ?")
    .bind(owner.id).first<{ n: number; pending: number }>();
  const sales = await env.DB.prepare("SELECT COUNT(*) AS sent, SUM(status = 'bought') AS bought, SUM(CASE WHEN status = 'bought' THEN price_cents END) AS cents FROM sales WHERE member_id = ? AND message_uuid IS NOT NULL")
    .bind(owner.id).first<{ sent: number; bought: number; cents: number }>();

  const head = `🖼️ <b>Catalog</b>: ${total?.n ?? 0} photos${total?.pending ? ` (${total.pending} still being described)` : ""}\n` +
    `💰 Locked photos sent on Fanvue: ${sales?.sent ?? 0}, bought: ${sales?.bought ?? 0} ($${((sales?.cents ?? 0) / 100).toFixed(2)})`;
  if (!results.length) {
    await send(env, owner.telegram_chat_id, `${head}\n\nNo photos yet. Upload photos to her Fanvue vault, then tap 🔄 (new ones are also picked up every 30 minutes). Until then she uses a demo catalog in /chat and /simulate.`, [
      [{ text: "🔄 Check the vault now", callback_data: "cat:sync" }],
    ]);
    return;
  }
  const items = results.slice(0, PAGE);
  const lines = items.map((it: any, n: number) => {
    const no = page * PAGE + n + 1;
    if (!it.described_at) return `${no}. ⏳ being described…`;
    return `${no}. ${it.enabled ? "" : "🚫 "}<b>$${(it.price_cents / 100).toFixed(2)}</b> · ${it.level} · ${esc(it.description)}`;
  });
  const buttons: Button[][] = [];
  for (let n = 0; n < items.length; n += 5) {
    buttons.push(items.slice(n, n + 5).map((it: any, k: number) => ({ text: `✏️ ${page * PAGE + n + k + 1}`, callback_data: `cat:edit:${it.media_uuid}` })));
  }
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: "◀️", callback_data: `cat:page:${page - 1}` });
  nav.push({ text: "🔄 Check the vault", callback_data: "cat:sync" });
  if (results.length > PAGE) nav.push({ text: "▶️", callback_data: `cat:page:${page + 1}` });
  buttons.push(nav);
  await send(env, owner.telegram_chat_id, `${head}\n\n${lines.join("\n")}\n\nTap ✏️ to change a price or hide a photo.`, buttons);
}

export async function onCatalogButton(env: Env, owner: Member, value: string): Promise<void> {
  const [action, arg] = value.split(":");
  if (action === "page") return showCatalog(env, owner, Number(arg) || 0);
  if (action === "sync") {
    if (!(await getAccount(env, owner.id))) return send(env, owner.telegram_chat_id, "Connect Fanvue first: /fanvue");
    const added = await syncVault(env, owner.id);
    await send(env, owner.telegram_chat_id, added ? `Found ${added} new photo(s). They'll be described in the next few minutes.` : "No new photos in the vault.");
    return showCatalog(env, owner);
  }
  if (action === "edit") {
    const item = await env.DB.prepare("SELECT description, price_cents FROM catalog WHERE member_id = ? AND media_uuid = ?")
      .bind(owner.id, arg).first<any>();
    if (!item) return;
    await setMode(env, owner.id, "edit", `price:${arg}`);
    await send(
      env,
      owner.telegram_chat_id,
      `<i>${esc(item.description ?? "")}</i>\nNow: <b>$${((item.price_cents ?? 0) / 100).toFixed(2)}</b>\n\nSend a new price in dollars (e.g. <code>12</code>), <code>hide</code> to never sell it, or <code>show</code> to sell it again.\n<i>/cancel to stop</i>`,
    );
  }
}

/** The owner answered the price question. */
export async function answerPrice(env: Env, owner: Member, mediaUuid: string, text: string): Promise<void> {
  const value = text.trim().toLowerCase().replace(/^\$/, "");
  if (value === "hide" || value === "show") {
    await env.DB.prepare("UPDATE catalog SET enabled = ?, updated_at = ? WHERE member_id = ? AND media_uuid = ?")
      .bind(value === "show" ? 1 : 0, Date.now(), owner.id, mediaUuid).run();
  } else {
    const dollars = Number(value);
    if (!Number.isFinite(dollars) || dollars < 3 || dollars > 500) {
      return send(env, owner.telegram_chat_id, "Send a price between 3 and 500 (dollars), or hide / show.");
    }
    await env.DB.prepare("UPDATE catalog SET price_cents = ?, updated_at = ? WHERE member_id = ? AND media_uuid = ?")
      .bind(Math.round(dollars * 100), Date.now(), owner.id, mediaUuid).run();
  }
  await clearMode(env, owner.id);
  await send(env, owner.telegram_chat_id, "✅ Saved.");
  await showCatalog(env, owner);
}
