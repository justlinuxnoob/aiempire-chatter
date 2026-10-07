// Step 4: the catalog of photos she can sell, and the sales she made.
//
// Every minute (cron):
//   - every 30 min, new vault photos are added to the catalog
//   - photos without a description are sent to the vision model (a few at a time)
//   - locked photos she sent are checked: did he open (buy) it?

import { getOwner, getSettings, setSetting } from "../db";
import { checkJob, submitJob } from "../runpod";
import { esc, send } from "../telegram";
import { fv } from "../fanvue/api";
import { connectedAccounts } from "../fanvue/auth";
import { LLM_SETTINGS, parseCompletion } from "../brain/tools";

export interface CatalogItem {
  id: string;
  description: string;
  level: "sfw" | "spicy" | "explicit";
  price_cents: number;
  demo?: boolean;
}

export const MIN_PRICE_CENTS = 300; // Fanvue's minimum
export const MAX_PRICE_CENTS = 50_000; // Fanvue's default ceiling ($500)

// Used for /chat and simulations while the real vault is empty, so selling can be tested.
export const DEMO_CATALOG: CatalogItem[] = [
  { id: "demo-1", description: "mirror selfie in a white crop top and grey sweatpants, messy bun", level: "sfw", price_cents: 500, demo: true },
  { id: "demo-2", description: "red lace lingerie set, lying on the bed, looking at the camera", level: "spicy", price_cents: 1200, demo: true },
  { id: "demo-3", description: "black bikini at the beach at golden hour, from behind", level: "spicy", price_cents: 900, demo: true },
  { id: "demo-4", description: "topless in the shower, wet hair, steam on the glass", level: "explicit", price_cents: 1800, demo: true },
  { id: "demo-5", description: "fully nude on white sheets, morning light", level: "explicit", price_cents: 2500, demo: true },
  { id: "demo-6", description: "gym mirror selfie in a tight pink sports bra and leggings", level: "sfw", price_cents: 600, demo: true },
];

/** What she can sell to this fan right now, with what he already bought or was offered. */
export async function catalogForFan(env: Env, memberId: string, fanId: string, allowDemo: boolean) {
  const { results } = await env.DB.prepare(
    `SELECT media_uuid AS id, description, level, price_cents FROM catalog
     WHERE member_id = ? AND enabled = 1 AND described_at IS NOT NULL ORDER BY created_at DESC LIMIT 40`,
  ).bind(memberId).all<CatalogItem>();
  const items = results.length ? results : allowDemo ? DEMO_CATALOG : [];
  const sales = await fanSales(env, memberId, fanId);
  const bought = new Set(sales.filter((s) => s.status === "bought").flatMap((s) => s.media));
  const offered = new Set(sales.flatMap((s) => s.media));
  return items.map((i) => ({ ...i, he_bought_it: bought.has(i.id), already_offered: offered.has(i.id) }));
}

export async function hasCatalog(env: Env, memberId: string, allowDemo: boolean): Promise<boolean> {
  if (allowDemo) return true;
  return !!(await env.DB.prepare("SELECT 1 FROM catalog WHERE member_id = ? AND enabled = 1 AND described_at IS NOT NULL LIMIT 1")
    .bind(memberId).first());
}

export async function fanSales(env: Env, memberId: string, fanId: string) {
  const { results } = await env.DB.prepare(
    "SELECT media_uuids, price_cents, status, offered_at FROM sales WHERE member_id = ? AND fan_id = ? ORDER BY offered_at DESC LIMIT 50",
  ).bind(memberId, fanId).all<{ media_uuids: string; price_cents: number; status: string; offered_at: number }>();
  return results.map((r) => ({ ...r, media: JSON.parse(r.media_uuids) as string[] }));
}

export async function recordOffer(
  env: Env, memberId: string, fanId: string, media: string[], priceCents: number, messageUuid: string | null,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sales (member_id, fan_id, message_uuid, media_uuids, price_cents, status, offered_at) VALUES (?, ?, ?, ?, ?, 'offered', ?)",
  ).bind(memberId, fanId, messageUuid, JSON.stringify(media), priceCents, Date.now()).run();
}

/** Simulator only: the AI fan decided to buy the last locked photo she sent. */
export async function simulatePurchase(env: Env, memberId: string, fanId: string): Promise<number | null> {
  const sale = await env.DB.prepare(
    "SELECT id, price_cents FROM sales WHERE member_id = ? AND fan_id = ? AND status = 'offered' ORDER BY offered_at DESC LIMIT 1",
  ).bind(memberId, fanId).first<{ id: number; price_cents: number }>();
  if (!sale) return null;
  await env.DB.batch([
    env.DB.prepare("UPDATE sales SET status = 'bought', bought_at = ? WHERE id = ?").bind(Date.now(), sale.id),
    env.DB.prepare("UPDATE fans SET total_spent_cents = total_spent_cents + ? WHERE member_id = ? AND fan_id = ?").bind(sale.price_cents, memberId, fanId),
  ]);
  return sale.price_cents;
}

// ── every minute ─────────────────────────────────────────────────────────

export async function catalogTick(env: Env): Promise<void> {
  for (const account of await connectedAccounts(env)) {
    const memberId = account.member_id;
    try {
      const settings = await getSettings(env, memberId);
      if (Date.now() - Number(settings.catalog_synced_at || 0) > 30 * 60_000) {
        await syncVault(env, memberId);
        await setSetting(env, memberId, "catalog_synced_at", String(Date.now()));
      }
      if (settings.llm_endpoint_id) await describePending(env, memberId, settings);
      await checkPurchases(env, memberId);
    } catch (e) {
      console.error("catalog tick failed", memberId, e);
    }
  }
}

/** Add new, ready vault images to the catalog (undescribed for now). */
export async function syncVault(env: Env, memberId: string): Promise<number> {
  let cursor = "";
  let added = 0;
  for (let page = 0; page < 6; page++) {
    const res = await fv(env, memberId, "GET", `/v1/media?size=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const m of res?.data ?? []) {
      if (m.status !== "ready" || (m.mediaType && m.mediaType !== "image")) continue;
      const r = await env.DB.prepare(
        "INSERT OR IGNORE INTO catalog (member_id, media_uuid, source, created_at, updated_at) VALUES (?, ?, 'vault', ?, ?)",
      ).bind(memberId, m.uuid, Date.now(), Date.now()).run();
      added += r.meta.changes;
    }
    cursor = res?.nextCursor ?? "";
    if (!cursor) break;
  }
  return added;
}

const DESCRIBE_PROMPT = (name: string) =>
  `You catalog photos of ${name} for her pay-to-view sales. Look at the photo and answer with JSON only:
{"description": "<one short sentence: outfit, pose, setting, what is visible>", "level": "sfw" | "spicy" | "explicit", "price": <suggested USD price>}
Pricing guide: sfw 5-8, spicy (lingerie, bikini, teasing) 9-15, explicit (nudity) 15-30.`;

async function describePending(env: Env, memberId: string, settings: Record<string, string>): Promise<void> {
  const endpoint = settings.llm_endpoint_id;
  // Finished jobs first.
  const { results: running } = await env.DB.prepare(
    "SELECT media_uuid, describe_job FROM catalog WHERE member_id = ? AND describe_job IS NOT NULL LIMIT 10",
  ).bind(memberId).all<{ media_uuid: string; describe_job: string }>();
  for (const item of running) {
    const job = await checkJob(env, endpoint, item.describe_job);
    if (job.state === "waiting" || job.state === "running") continue;
    const parsed = job.state === "done" ? parseDescription(parseCompletion(job.output).text) : null;
    if (parsed) {
      await env.DB.prepare(
        "UPDATE catalog SET description = ?, level = ?, price_cents = ?, describe_job = NULL, described_at = ?, updated_at = ? WHERE member_id = ? AND media_uuid = ?",
      ).bind(parsed.description, parsed.level, parsed.price_cents, Date.now(), Date.now(), memberId, item.media_uuid).run();
    } else {
      await env.DB.prepare("UPDATE catalog SET describe_job = NULL WHERE member_id = ? AND media_uuid = ?").bind(memberId, item.media_uuid).run();
    }
  }
  if (running.length >= 3) return;

  // Start a few new ones (3 attempts max per photo).
  const { results: todo } = await env.DB.prepare(
    `SELECT media_uuid FROM catalog WHERE member_id = ? AND described_at IS NULL AND describe_job IS NULL AND describe_attempts < 3
     ORDER BY created_at LIMIT ?`,
  ).bind(memberId, 3 - running.length).all<{ media_uuid: string }>();
  for (const item of todo) {
    const image = await imageDataUrl(env, memberId, item.media_uuid);
    if (!image) {
      await env.DB.prepare("UPDATE catalog SET describe_attempts = describe_attempts + 1 WHERE member_id = ? AND media_uuid = ?")
        .bind(memberId, item.media_uuid).run();
      continue;
    }
    const body = {
      ...LLM_SETTINGS,
      max_tokens: 200,
      temperature: 0.2,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: image } }, { type: "text", text: DESCRIBE_PROMPT(settings.name || "her") }] }],
    };
    const jobId = await submitJob(env, endpoint, { openai_route: "/v1/chat/completions", openai_input: body });
    await env.DB.prepare(
      "UPDATE catalog SET describe_job = ?, describe_attempts = describe_attempts + 1 WHERE member_id = ? AND media_uuid = ?",
    ).bind(jobId, memberId, item.media_uuid).run();
  }
}

/** Download a small version of the photo and inline it, so the vision model doesn't need Fanvue access. */
async function imageDataUrl(env: Env, memberId: string, mediaUuid: string): Promise<string | null> {
  const media = await fv(env, memberId, "GET", `/v1/media/${mediaUuid}?variants=thumbnail,main`).catch(() => null);
  const variants: any[] = media?.variants ?? [];
  const pick = variants.find((v) => v.variantType === "thumbnail") ?? variants.find((v) => v.variantType === "main");
  if (!pick?.url) return null;
  const res = await fetch(pick.url);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 4_000_000) return null;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${res.headers.get("content-type") || "image/jpeg"};base64,${btoa(bin)}`;
}

export function parseDescription(text: string): { description: string; level: CatalogItem["level"]; price_cents: number } | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const d = JSON.parse(json);
    const level = ["sfw", "spicy", "explicit"].includes(d.level) ? d.level : "spicy";
    const price = Math.round(Math.min(Math.max(Number(d.price) || 10, 3), 50) * 100);
    const description = String(d.description ?? "").trim().slice(0, 200);
    return description ? { description, level, price_cents: price } : null;
  } catch {
    return null;
  }
}

/** Did he open the locked photos she sent? Checked every few minutes for a week. */
async function checkPurchases(env: Env, memberId: string): Promise<void> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.fan_id, s.message_uuid, s.price_cents, f.handle FROM sales s LEFT JOIN fans f ON f.member_id = s.member_id AND f.fan_id = s.fan_id
     WHERE s.member_id = ? AND s.status = 'offered' AND s.message_uuid IS NOT NULL AND s.offered_at > ?
       AND (s.checked_at IS NULL OR s.checked_at < ?) ORDER BY s.checked_at LIMIT 10`,
  ).bind(memberId, now - 7 * 86400_000, now - 3 * 60_000).all<any>();
  for (const sale of results) {
    const msg = await fv(env, memberId, "GET", `/v1/chats/${sale.fan_id}/messages/${sale.message_uuid}`).catch(() => null);
    if (msg?.purchasedAt) {
      await env.DB.batch([
        env.DB.prepare("UPDATE sales SET status = 'bought', bought_at = ?, checked_at = ? WHERE id = ?").bind(Date.parse(msg.purchasedAt) || now, now, sale.id),
        env.DB.prepare("UPDATE fans SET total_spent_cents = total_spent_cents + ? WHERE member_id = ? AND fan_id = ?").bind(sale.price_cents, memberId, sale.fan_id),
      ]);
      const owner = await getOwner(env);
      if (owner) await send(env, owner.telegram_chat_id, `💰 <b>@${esc(sale.handle ?? "a fan")}</b> bought a locked photo for $${(sale.price_cents / 100).toFixed(2)}`);
    } else {
      await env.DB.prepare("UPDATE sales SET checked_at = ? WHERE id = ?").bind(now, sale.id).run();
    }
  }
}
