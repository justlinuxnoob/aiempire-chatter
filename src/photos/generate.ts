// Step 5: photos made on demand with the owner's RunPod image endpoints
// (same job format as their Telegram bot: see docs/image-prompt-rules.md).
//
//   generate_image (her tool) → RunPod job → every minute: done? → upload to Fanvue
//   → approval in Telegram (✅/❌), unless turned off → sent to the fan (free or locked)

import { addAlert, addMessage, getOwner, getSettings, type Source } from "../db";
import { checkJob, submitJob } from "../runpod";
import { esc, send, sendPhoto, type Button } from "../telegram";
import { fv } from "../fanvue/api";
import { recordOffer, MAX_PRICE_CENTS, MIN_PRICE_CENTS } from "../catalog/catalog";
import { minorCoded } from "../brain/safety";
import { photoPriceRange, salesNumber } from "../control/fields";

export type Kind = "teaser" | "ppv";

// Extra words that are never allowed in an image prompt (on top of the minor-coded list).
const IMAGE_BLOCKLIST = /\b(child|children|kid|kids|childlike|child-like|baby[\s-]?face|underdeveloped|flat[\s-]?chested|pigtails?|braces|lollipop|diaper|toddler|preteen|tween)\b/i;
const GIVE_UP_AFTER = 30 * 60_000;

export function canGenerate(settings: Record<string, string>): boolean {
  return !!(settings.trigger_word && settings.hair_eyes && settings.lora_url && (settings.sfw_endpoint_id || settings.nsfw_endpoint_id));
}

export function approvalsOn(settings: Record<string, string>): boolean {
  return settings.photo_approval !== "off";
}

/** Cleans her prompt: trigger word + hair/eyes first, smartphone look last. Returns an error if it's not allowed. */
export function buildPrompt(settings: Record<string, string>, raw: string): { prompt: string } | { error: string; blocked?: string } {
  let text = String(raw ?? "").replace(/\s+/g, " ").trim();
  const blocked = minorCoded(text) ?? text.match(IMAGE_BLOCKLIST)?.[0];
  if (blocked) return { error: `That photo idea isn't allowed ("${blocked}"). Turn it down in character.`, blocked };
  const trigger = settings.trigger_word.trim();
  const hair = settings.hair_eyes.trim();
  // Drop whatever she put in front of the scene if it repeats the trigger/hair, then put the exact ones back.
  text = text.replace(new RegExp(`^${escapeRe(trigger)}\\s*,?\\s*`, "i"), "").replace(new RegExp(`^${escapeRe(hair)}\\s*,?\\s*`, "i"), "");
  if (!/candid smartphone photo/i.test(text)) text += ", candid smartphone photo";
  if (!/natural skin texture/i.test(text)) text += ", natural skin texture";
  const words = text.split(" ").length;
  if (words < 15) return { error: "The photo description is too short. Describe pose, outfit (or what's visible), place and light." };
  return { prompt: `${trigger}, ${hair}, ${text}`.slice(0, 1200) };
}

/** Her generate_image call. Starts the job (or, in the simulator, pretends to). */
export async function startGeneration(
  env: Env, memberId: string, fanId: string, source: Source, args: any,
): Promise<{ ok: string; simMessage?: string } | { error: string }> {
  const settings = await getSettings(env, memberId);
  const kind: Kind = args?.kind === "ppv" ? "ppv" : "teaser";
  const endpoint = kind === "ppv" ? settings.nsfw_endpoint_id : settings.sfw_endpoint_id;
  if (!endpoint) return { error: kind === "ppv" ? "You can't take paid photos right now, only teasers." : "You can't take free teasers right now, only paid photos." };

  const built = buildPrompt(settings, args?.prompt);
  if ("error" in built) {
    if (built.blocked) {
      await addAlert(env, memberId, fanId, "image_prompt_blocked", String(args?.prompt ?? ""));
      const owner = await getOwner(env);
      if (owner && source !== "sim") await send(env, owner.telegram_chat_id, `🛡️ <b>Blocked a photo request</b> (“${esc(built.blocked)}”).\n<i>${esc(String(args?.prompt ?? ""))}</i>`);
    }
    return { error: built.error };
  }

  let priceCents: number | null = null;
  if (kind === "ppv") {
    // Kept inside the owner's range from /sales (and Fanvue's $3–$500).
    const [lo, hi] = photoPriceRange(settings);
    const asked = Math.round(Number(args?.price) * 100);
    priceCents = Math.min(Math.max(Number.isFinite(asked) ? asked : lo, lo, MIN_PRICE_CENTS), hi, MAX_PRICE_CENTS);
  }
  const caption = String(args?.caption ?? "").trim().slice(0, 500) || "took this one just for you 😘";

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(status IN ('generating', 'review')) AS open, SUM(kind = 'teaser') AS teasers,
       SUM(prompt = ?) AS same FROM generations WHERE member_id = ? AND fan_id = ? AND created_at > ?`,
  ).bind(built.prompt, memberId, fanId, Date.now() - 86400_000).first<{ n: number; open: number; teasers: number; same: number }>();
  if (recent?.open) return { error: "You're already taking a photo for him. Tell him it's coming." };
  if ((recent?.n ?? 0) >= salesNumber(settings, "photos_per_day")) return { error: "No more new photos for him today. Offer something from your catalog instead." };
  if (kind === "teaser" && (recent?.teasers ?? 0) >= salesNumber(settings, "teasers_per_day")) return { error: "No more free photos for him today. Anything new is paid (kind ppv)." };
  if (recent?.same) return { error: "You already took exactly that photo. Change the pose, angle, outfit or light." };

  if (source === "sim") {
    // Simulator: no real GPU job. The photo goes out right after her reply, so the conversation can be tested.
    // It's still recorded, so the daily limits and "no duplicate photo" apply like for real fans.
    await env.DB.prepare(
      `INSERT INTO generations (member_id, fan_id, source, kind, prompt, caption, price_cents, endpoint, job_id, status, created_at, updated_at)
       VALUES (?, ?, 'sim', ?, ?, ?, ?, ?, NULL, 'sent', ?, ?)`,
    ).bind(memberId, fanId, kind, built.prompt, caption, priceCents, endpoint, Date.now(), Date.now()).run();
    if (kind === "ppv") await recordOffer(env, memberId, fanId, ["sim-generated"], priceCents!, null);
    return { ok: "Taken; it will be sent right after your reply.", simMessage: remembered(kind, priceCents, caption, built.prompt) };
  }

  const input = kind === "ppv"
    ? { prompt: built.prompt, lora_url: settings.lora_url }
    : { prompt: built.prompt, lora_url: settings.lora_url, lora_strength: 0.9, width: 1024, height: 1536 };
  const jobId = await submitJob(env, endpoint, input);
  await env.DB.prepare(
    `INSERT INTO generations (member_id, fan_id, source, kind, prompt, caption, price_cents, endpoint, job_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'generating', ?, ?)`,
  ).bind(memberId, fanId, source, kind, built.prompt, caption, priceCents, endpoint, jobId, Date.now(), Date.now()).run();
  return { ok: "Started. It takes a few minutes; tell him you're taking it now." };
}

/** What she remembers about a photo she sent. */
function remembered(kind: Kind, priceCents: number | null, caption: string, prompt: string): string {
  const what = prompt.split(",").slice(2, 6).join(",").trim();
  return kind === "ppv"
    ? `${caption} [new locked photo you took for him, $${((priceCents ?? 0) / 100).toFixed(2)}: ${what}]`
    : `${caption} [free photo you took for him: ${what}]`;
}

/** For her prompt: photos in progress / recently handled for this fan. */
export async function photosForFan(env: Env, memberId: string, fanId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT kind, status, created_at FROM generations WHERE member_id = ? AND fan_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 3",
  ).bind(memberId, fanId, Date.now() - 86400_000).all<{ kind: Kind; status: string; created_at: number }>();
  return results.map((g) => {
    if (g.status === "generating" || g.status === "review") return `You're still taking a ${g.kind === "ppv" ? "paid" : "free"} photo for him. It's coming soon.`;
    if (g.status === "rejected" || g.status === "failed") return "A photo you were taking for him didn't turn out. Don't mention it unless he asks; offer something else.";
    return "";
  }).filter(Boolean);
}

// ── every minute ─────────────────────────────────────────────────────────

export async function generationTick(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM generations WHERE status = 'generating' ORDER BY created_at LIMIT 5",
  ).all<any>();
  for (const g of results) {
    try {
      await advance(env, g);
    } catch (e) {
      console.error("generation failed", g.id, e);
      await fail(env, g, String((e as Error).message ?? e));
    }
  }
}

async function advance(env: Env, g: any): Promise<void> {
  const job = await checkJob(env, g.endpoint, g.job_id);
  if (job.state === "waiting" || job.state === "running") {
    if (Date.now() - g.created_at > GIVE_UP_AFTER) await fail(env, g, "the image endpoint didn't finish within 30 minutes");
    return;
  }
  if (job.state === "failed") return fail(env, g, job.error);
  const b64: string | undefined = job.output?.image;
  if (!b64) return fail(env, g, `no image in the result: ${JSON.stringify(job.output).slice(0, 200)}`);
  const bytes = fromBase64(b64);

  if (g.source === "fanvue") {
    g.media_uuid = await uploadToFanvue(env, g.member_id, bytes, `chatter-${g.id}.jpg`);
    await env.DB.prepare("UPDATE generations SET media_uuid = ?, updated_at = ? WHERE id = ?").bind(g.media_uuid, Date.now(), g.id).run();
  }
  const settings = await getSettings(env, g.member_id);
  if (g.source === "fanvue" && approvalsOn(settings)) {
    await env.DB.prepare("UPDATE generations SET status = 'review', updated_at = ? WHERE id = ?").bind(Date.now(), g.id).run();
    const owner = await getOwner(env);
    const fan = await env.DB.prepare("SELECT handle FROM fans WHERE member_id = ? AND fan_id = ?").bind(g.member_id, g.fan_id).first<{ handle: string }>();
    const what = g.kind === "ppv" ? `locked · $${(g.price_cents / 100).toFixed(2)}` : "free teaser";
    const buttons: Button[][] = [[{ text: "✅ Send", callback_data: `gen:ok:${g.id}` }, { text: "❌ Don't send", callback_data: `gen:no:${g.id}` }]];
    if (owner) await sendPhoto(env, owner.telegram_chat_id, bytes, `📸 For @${fan?.handle ?? "fan"} (${what})\n💋 ${g.caption}`, buttons);
    return;
  }
  await deliver(env, g, bytes);
}

/** Send the photo to the fan (Fanvue), or to the owner's Telegram for /chat tests. */
export async function deliver(env: Env, g: any, bytes?: Uint8Array): Promise<void> {
  const text = remembered(g.kind, g.price_cents, g.caption, g.prompt);
  if (g.source === "fanvue") {
    const res = await fv(env, g.member_id, "POST", `/v1/chats/${g.fan_id}/message`, {
      text: g.caption,
      mediaUuids: [g.media_uuid],
      ...(g.kind === "ppv" ? { price: g.price_cents } : {}),
    });
    await addMessage(env, g.member_id, g.fan_id, "her", text, res?.messageUuid);
    if (g.kind === "ppv") await recordOffer(env, g.member_id, g.fan_id, [g.media_uuid], g.price_cents, res?.messageUuid ?? null);
  } else if (g.fan_id === "selftest") {
    const owner = await getOwner(env);
    if (owner && bytes) await sendPhoto(env, owner.telegram_chat_id, bytes, `✅ ${g.caption}\n\nPrompt: ${g.prompt}`);
  } else {
    const owner = await getOwner(env);
    if (owner && bytes) {
      const what = g.kind === "ppv" ? `🔒 locked · $${(g.price_cents / 100).toFixed(2)}` : "free teaser";
      await sendPhoto(env, owner.telegram_chat_id, bytes, `💋 ${g.caption}\n(${what})`);
    }
    await addMessage(env, g.member_id, g.fan_id, "her", text);
    if (g.kind === "ppv") await recordOffer(env, g.member_id, g.fan_id, ["test-generated"], g.price_cents, null);
  }
  await env.DB.prepare("UPDATE generations SET status = 'sent', updated_at = ? WHERE id = ?").bind(Date.now(), g.id).run();
}

/** ✅ / ❌ in Telegram. */
export async function review(env: Env, id: number, approve: boolean): Promise<string> {
  const g = await env.DB.prepare("SELECT * FROM generations WHERE id = ?").bind(id).first<any>();
  if (!g || g.status !== "review") return "That one was already handled.";
  if (!approve) {
    await env.DB.prepare("UPDATE generations SET status = 'rejected', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
    return "❌ Not sent. She'll offer him something else.";
  }
  await deliver(env, g);
  return "✅ Sent to the fan.";
}

async function fail(env: Env, g: any, error: string): Promise<void> {
  await env.DB.prepare("UPDATE generations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(error.slice(0, 500), Date.now(), g.id).run();
  const owner = await getOwner(env);
  const what = g.fan_id === "selftest" ? "❌ Test photo failed" : "⚠️ A photo for a fan failed";
  if (owner) await send(env, owner.telegram_chat_id, `${what}: ${esc(error.slice(0, 300))}`);
}

/** Fanvue multipart upload (one part is plenty for a photo), then wait until it's ready. */
async function uploadToFanvue(env: Env, memberId: string, bytes: Uint8Array, filename: string): Promise<string> {
  const session = await fv(env, memberId, "POST", "/v1/media/uploads", { name: filename, filename, mediaType: "image", sizeBytes: bytes.length });
  if ((session.totalParts ?? 1) > 1) throw new Error("photo too big for a single-part upload");
  const url: string = await fv(env, memberId, "GET", `/v1/media/uploads/${session.uploadId}/parts/1/url`);
  const put = await fetch(url, { method: "PUT", body: bytes });
  if (!put.ok) throw new Error(`upload to Fanvue storage failed: HTTP ${put.status}`);
  const etag = put.headers.get("ETag") ?? "";
  await fv(env, memberId, "PATCH", `/v1/media/uploads/${session.uploadId}`, { parts: [{ PartNumber: 1, ETag: etag }] });
  for (let i = 0; i < 10; i++) {
    const media = await fv(env, memberId, "GET", `/v1/media/${session.mediaUuid}`);
    if (media?.status === "ready") return session.mediaUuid;
    if (media?.status === "error") throw new Error("Fanvue couldn't process the photo");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Fanvue is still processing the photo after 20 seconds");
}

function fromBase64(b64: string): Uint8Array {
  const native = (Uint8Array as any).fromBase64;
  if (typeof native === "function") return native(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
