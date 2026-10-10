// /test: checks every piece and reports in Telegram.
//   - settings complete?
//   - chat brain: a real tool-calling question (cold start can take ~5 min)
//   - image endpoint(s): a real test photo of her, sent to you
//   - Fanvue: connected, which account, AI badge, mode
// Slow parts (brain, photos) are finished by the every-minute job.

import { getSettings, setSetting, type Member } from "../db";
import { checkJob, health, submitJob } from "../runpod";
import { esc, send } from "../telegram";
import { getAccount } from "../fanvue/auth";
import { fv } from "../fanvue/api";
import { modeOf } from "../fanvue/inbound";
import { buildPrompt, imageEndpoint, imageJobInput } from "../photos/generate";
import { LLM_SETTINGS, TOOLS, parseCompletion } from "../brain/tools";
import { missingForChat } from "./fields";

const TEST_SCENE =
  "sitting at a small table in a sunny cafe by the window, holding a cup of coffee, cream knit sweater, small gold hoop earrings, soft morning daylight, upper body shot";

export async function runSelfTest(env: Env, owner: Member): Promise<void> {
  const chat = owner.telegram_chat_id;
  const settings = await getSettings(env, owner.id);
  const lines: string[] = ["🧪 <b>Testing everything</b>", "✅ Telegram: this bot works"];

  const missing = missingForChat(settings);
  lines.push(missing.length ? `❌ Setup: missing ${missing.map((f) => f.label).join(", ")} (send /setup)` : "✅ Setup: complete");

  // Fanvue (instant)
  const account = await getAccount(env, owner.id);
  if (!account) lines.push("➖ Fanvue: not connected yet (/fanvue)");
  else if (account.status !== "connected") lines.push("❌ Fanvue: disconnected, reconnect with /fanvue");
  else {
    const me = await fv(env, owner.id, "GET", "/v1/users/me").catch((e) => ({ error: String(e.message ?? e) }));
    if (me?.error) lines.push(`❌ Fanvue: ${esc(me.error)}`);
    else lines.push(`✅ Fanvue: @${esc(me.handle)}${me.isAiCreator ? " (AI badge on)" : " (⚠️ no AI badge on this account)"} · mode: ${modeOf(settings)}`);
  }

  // Chat brain (slow: answered by the every-minute job)
  if (settings.llm_endpoint_id) {
    const h = await health(env, settings.llm_endpoint_id);
    if (!h.ok) lines.push(`❌ Chat brain: ${esc(h.reason)}`);
    else {
      const body = {
        ...LLM_SETTINGS,
        max_tokens: 120,
        tools: TOOLS,
        tool_choice: "required",
        messages: [
          { role: "system", content: `You are ${settings.name || "her"}, texting a fan. Answer with the reply tool.` },
          { role: "user", content: "hey, how's your day going?" },
        ],
      };
      const job = await submitJob(env, settings.llm_endpoint_id, { openai_route: "/v1/chat/completions", openai_input: body });
      await setSetting(env, owner.id, "selftest_brain", JSON.stringify({ job, endpoint: settings.llm_endpoint_id, started: Date.now() }));
      lines.push(`⏳ Chat brain: asked a test question${h.awake ? "" : " (it's asleep: waking up can take ~5 min)"}…`);
    }
  }

  // Image endpoints (slow: a real photo, delivered by the every-minute job)
  const endpoints = [...new Set([settings.sfw_endpoint_id, settings.nsfw_endpoint_id].filter(Boolean))];
  if (!endpoints.length) lines.push("➖ Photos: no image endpoint set (/settings)");
  else if (!settings.trigger_word || !settings.hair_eyes || !settings.lora_url) {
    lines.push("❌ Photos: trigger word, hair & eyes and LoRA link are needed (/settings)");
  } else {
    const built = buildPrompt(settings, TEST_SCENE);
    for (const endpoint of endpoints) {
      const h = await health(env, endpoint);
      const teaser = imageEndpoint(settings, "teaser") === endpoint;
      const ppv = imageEndpoint(settings, "ppv") === endpoint;
      const role = teaser && ppv ? "free + paid photos" : teaser ? "free teasers" : "paid photos";
      if (!h.ok) {
        lines.push(`❌ Image endpoint (${role}): ${esc(h.reason)}`);
        continue;
      }
      if ("error" in built) continue;
      const jobId = await submitJob(env, endpoint, imageJobInput(settings, endpoint, built.prompt));
      await env.DB.prepare(
        `INSERT INTO generations (member_id, fan_id, source, kind, prompt, caption, price_cents, endpoint, job_id, status, created_at, updated_at)
         VALUES (?, 'selftest', 'test', 'teaser', ?, ?, NULL, ?, ?, 'generating', ?, ?)`,
      ).bind(owner.id, built.prompt, `🧪 Test photo from your image endpoint (${role})`, endpoint, jobId, Date.now(), Date.now()).run();
      lines.push(`⏳ Image endpoint (${role}): taking a test photo${h.awake ? "" : " (asleep: first photo can take ~5 min)"}…`);
    }
  }

  lines.push("", "The ⏳ results arrive here by themselves.");
  await send(env, chat, lines.join("\n"));
}

/** Every minute: report the brain test when it's done. (Test photos go through the normal photo job.) */
export async function selfTestTick(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT member_id, value FROM settings WHERE key = 'selftest_brain' AND value != ''")
    .all<{ member_id: string; value: string }>();
  for (const row of results) {
    const t = JSON.parse(row.value);
    const owner = await env.DB.prepare("SELECT telegram_chat_id FROM members WHERE id = ?").bind(row.member_id).first<{ telegram_chat_id: string }>();
    const job = await checkJob(env, t.endpoint, t.job).catch((e) => ({ state: "failed" as const, error: String(e) }));
    const secs = Math.round((Date.now() - t.started) / 1000);
    let report: string | null = null;
    if (job.state === "done") {
      const parsed = parseCompletion(job.output);
      const reply = parsed.calls.find((c) => c.name === "reply")?.args?.messages;
      report = reply
        ? `✅ Chat brain answered in ${secs}s, using her tools correctly:\n💋 ${esc([].concat(reply).join(" / "))}`
        : `⚠️ Chat brain answered in ${secs}s but didn't use her tools: ${esc(parsed.text.slice(0, 200))}`;
    } else if (job.state === "failed") report = `❌ Chat brain failed: ${esc(job.error.slice(0, 300))}`;
    else if (secs > 20 * 60) report = "❌ Chat brain didn't answer within 20 minutes. Check the endpoint in RunPod.";
    if (report) {
      await setSetting(env, row.member_id, "selftest_brain", "");
      if (owner) await send(env, owner.telegram_chat_id, report);
    }
  }
}
