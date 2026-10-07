// End-to-end test against `wrangler dev` + mock-server.mjs (fake Telegram + RunPod).
// Needs .dev.vars with TELEGRAM_BOT_TOKEN=test-bot-token, TELEGRAM_API=http://127.0.0.1:8789,
// RUNPOD_API=http://127.0.0.1:8789/v2, and a fresh local DB (wrangler d1 migrations apply DB --local).

import crypto from "node:crypto";

const WORKER = process.env.WORKER || "http://127.0.0.1:8787";
const MOCK = process.env.MOCK || "http://127.0.0.1:8789";
const TOKEN = "test-bot-token";
const OWNER = 111;
const STRANGER = 222;

const secret = crypto.createHash("sha256").update("aiempire-chatter:" + TOKEN).digest("hex").slice(0, 48);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let updateId = 1;
let failures = 0;

async function update(payload) {
  const res = await fetch(`${WORKER}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: updateId++, ...payload }),
  });
  if (!res.ok) throw new Error(`worker said ${res.status}`);
}
const say = (text, from = OWNER) =>
  update({ message: { message_id: updateId, from: { id: from }, chat: { id: from, type: "private" }, text } });
const tap = (data) => update({ callback_query: { id: String(updateId), from: { id: OWNER }, data } });

async function log() {
  return (await fetch(`${MOCK}/log`)).json();
}
async function sent() {
  return (await log()).calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
}
async function clear() {
  await fetch(`${MOCK}/reset`, { method: "POST" });
}

/** Wait until a sent message matches, or fail after `ms`. */
async function expectSent(label, test, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const texts = await sent();
    if (texts.some((t) => test.test(t))) {
      console.log(`  ✓ ${label}`);
      return texts;
    }
    await sleep(300);
  }
  failures++;
  console.log(`  ✗ ${label}\n    sent so far:\n${(await sent()).map((t) => "      | " + t.replace(/\n/g, " ⏎ ")).join("\n")}`);
}
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${!ok && detail ? ` (${detail})` : ""}`);
}

console.log("\n1. Claim the bot");
await clear();
const setup = await (await fetch(`${WORKER}/setup`)).text();
const code = setup.match(/start=([a-z0-9]+)/)?.[1];
check("/setup page shows a Telegram link", !!code);
const hook = (await log()).calls.find((c) => c.method === "setWebhook");
check("webhook registered with a secret", hook?.body.secret_token === secret);
const forged = await fetch(`${WORKER}/telegram`, { method: "POST", body: "{}", headers: { "X-Telegram-Bot-Api-Secret-Token": "nope" } });
check("fake updates are refused", forged.status === 403);
await say("/start wrongcode", STRANGER);
await expectSent("wrong code is refused", /isn't connected yet/);
await say(`/start ${code}`);
await expectSent("owner linked", /You're connected/);
await say("/help", STRANGER);
await expectSent("strangers are locked out", /private bot/);

console.log("\n2. /setup");
await clear();
await say("/setup");
await expectSent("asks for her name", /1\/9 · Her name/);
await say("Mia");
await expectSent("asks for her age", /2\/9 · Her age/);
await say("17");
await expectSent("refuses under 18", /18 or older/);
await say("24");
await expectSent("asks for persona with an example", /3\/9 · Persona/);
await say("- Mia, 24, from Miami\n- lowercase, flirty");
await expectSent("asks for the chat brain", /4\/9 · Chat brain/);
await say("missing12345");
await expectSent("unknown endpoint is refused", /can't find that endpoint/);
await say("testbrain1");
await expectSent("endpoint checked", /Found it/);
for (let i = 0; i < 5; i++) await say("/skip");
await expectSent("setup done", /Setup done/);

console.log("\n3. /settings");
await clear();
await say("/settings");
await expectSent("shows settings", /Her name:.*Mia/s);
await tap("edit:name");
await expectSent("asks to edit the name", /Now: .*Mia/s);
await say("Mia Rose");
await expectSent("saved and shown again", /Her name:.*Mia Rose/s);

console.log("\n4. /chat: a normal reply");
await clear();
await say("/chat");
await expectSent("fan mode on", /You're a fan now/);
await say("hey u up?");
const t0 = Date.now();
await expectSent("she replies", /💋 heyy you/);
check("she waited a few seconds first, like a person", Date.now() - t0 > 2500, `${Date.now() - t0}ms`);
await expectSent("her second message follows", /💋 missed me\?/);
check("typing indicator shown", (await log()).calls.some((c) => c.method === "sendChatAction"));

console.log("\n5. Three texts in a row → one reply");
await clear();
await say("so");
await sleep(500);
await say("my name is Jake");
await sleep(500);
await say("whats up");
await expectSent("she replies once", /💋 heyy you/);
await sleep(4000);
const replies = (await sent()).filter((t) => t.startsWith("💋 heyy")).length;
check("only one reply for the burst", replies === 1, `${replies} replies`);
check("one brain job for the burst", (await log()).runs === 1, `${(await log()).runs} jobs`);

console.log("\n6. A draft claiming she's human is quietly rewritten");
await clear();
await say("are you real?");
await expectSent("rewrite is sent", /💋 you know what i am/);
check("the claim never reached the fan", !(await sent()).some((t) => t.startsWith("💋 i'm a real girl")));
check("no noisy notice about it", !(await sent()).some((t) => /Blocked her draft/.test(t)));

console.log("\n7. Fan says he's under 18");
await clear();
await say("lol im 15 btw");
await expectSent("owner alerted, fan paused", /under 18/);
await sleep(12000);
check("she did not reply", !(await sent()).some((t) => t.startsWith("💋")));
await say("hello?");
await expectSent("paused fan stays paused", /paused/);
await say("/reset");
await expectSent("reset", /forgotten your test chat/);

console.log("\n8. Simulator (safety script)");
await clear();
await say("/stop");
await say("/simulate");
await expectSent("shows fan types", /Which kind of fan/);
await tap("sim:safety");
await expectSent("simulation starts", /Simulation: 🛡️ Safety check/);
await expectSent("flags minor-coded requests", /Flagged/, 60000);
await expectSent("ends on the underage message", /Simulation finished/, 120000);

console.log("\n9. Simulator (AI fan) can be stopped");
await clear();
await tap("sim:shy");
await expectSent("AI fan writes", /👤 hey gorgeous/, 30000);
await expectSent("she answers the AI fan", /💋/, 30000);
await say("/stop");
await expectSent("stopped with a summary", /Simulation stopped/);

// ── Fanvue ──────────────────────────────────────────────────────────────

let fvMsg = 0;
async function fanvueWebhook(fanUuid, handle, text, { uuid, badSignature } = {}) {
  const { signingSecret } = await log();
  const body = JSON.stringify({
    id: `evt-${++fvMsg}`,
    type: "creator.message.received",
    timestamp: new Date().toISOString(),
    data: { object: "message", uuid: uuid ?? `fvmsg-${fvMsg}`, sender: "fan", text, message_type: "SINGLE_RECIPIENT", creator: { uuid: "creator-1" }, fan: { uuid: fanUuid, handle, display_name: handle } },
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", badSignature ? "nope" : signingSecret).update(`${t}.${body}`).digest("hex");
  return fetch(`${WORKER}/fanvue/webhook`, { method: "POST", body, headers: { "content-type": "application/json", "X-Fanvue-Signature": `t=${t},v0=${sig}` } });
}
const fanvueCalls = async (what) => (await log()).calls.filter((c) => c.method.startsWith(`fanvue:${what}`));

console.log("\n10. Connect Fanvue");
await clear();
await say("/stop");
await say("/fanvue");
await expectSent("offers a connect button", /isn't connected yet/);
const connect = (await log()).calls.find((c) => c.body.reply_markup)?.body.reply_markup.inline_keyboard[0][0].url ?? "";
const auth = new URL(connect);
check("connect link asks for the right scopes with PKCE", auth.searchParams.get("code_challenge_method") === "S256" && /write:chat/.test(auth.searchParams.get("scope")));
const back = await (await fetch(`${WORKER}/fanvue/callback?code=good&state=${auth.searchParams.get("state")}`)).text();
check("callback page says connected", /Connected as/.test(back), back.slice(0, 200));
await expectSent("owner told in Telegram", /Fanvue connected/);
check("token request used Basic auth + PKCE verifier", (await fanvueCalls("token"))[0]?.body.includes("code_verifier="));
check("API calls send the version header", (await fanvueCalls("GET /v1/users/me"))[0]?.version === "2025-06-26");
check("webhook subscribed", (await fanvueCalls("POST /v1/webhooks/subscriptions")).length === 1);
const reused = await (await fetch(`${WORKER}/fanvue/callback?code=good&state=${auth.searchParams.get("state")}`)).text();
check("connect link can't be reused", /expired or was already used/.test(reused));

console.log("\n11. Webhook security");
check("forged webhook refused", (await fanvueWebhook("fan-x", "x", "hi", { badSignature: true })).status === 401);

console.log("\n12. Test mode: real fans are ignored");
await clear();
await fanvueWebhook("fan-real", "realguy", "hey mia");
await sleep(3000);
check("no brain job for a real fan", (await log()).runs === 0);

console.log("\n13. Add the test fan account");
await clear();
await tap("fv:testfan");
const codeMsg = await expectSent("shows a code", /this exact message/);
const testCode = codeMsg?.join("\n").match(/test-[a-z0-9]+/)?.[0];
await fanvueWebhook("fan-test", "mytestacct", testCode);
await expectSent("test account recognized", /@mytestacct<\/b> is now your test fan/);

console.log("\n14. Test fan chats on Fanvue");
await clear();
await fanvueWebhook("fan-test", "mytestacct", "hey babe what u up to", { uuid: "dup-1" });
await fanvueWebhook("fan-test", "mytestacct", "hey babe what u up to", { uuid: "dup-1" }); // Fanvue may deliver twice
const start14 = Date.now();
while (Date.now() - start14 < 120000 && (await fanvueCalls("POST /v1/chats/fan-test/message")).length < 2) await sleep(500);
const sentToFan = await fanvueCalls("POST /v1/chats/fan-test/message");
check("she replied on Fanvue", sentToFan.some((c) => /heyy you/.test(c.body.text)), JSON.stringify(sentToFan.map((c) => c.body)));
check("chat marked read", (await fanvueCalls("PATCH /v1/chats/fan-test")).length >= 1);
check("typing shown on Fanvue", (await fanvueCalls("POST /v1/chats/fan-test/typing")).length >= 1);
check("duplicate delivery answered once", (await log()).runs === 1, `${(await log()).runs} jobs`);
check("nothing posted to Telegram for a test chat", !(await sent()).some((t) => t.startsWith("💋")));

console.log("\n15. Dry-run: real fans are read, replies only shown to you");
await clear();
await tap("fv:mode:dryrun");
await expectSent("mode changed", /Dry-run/);
await clear();
await fanvueWebhook("fan-real", "realguy", "hey mia u there?");
await expectSent("shows what the fan wrote", /@realguy wrote/, 90000);
await expectSent("shows what she would reply", /would reply to @realguy/, 90000);
check("nothing sent to the real fan", (await fanvueCalls("POST /v1/chats/fan-real/message")).length === 0);
check("real fan's chat not marked read", (await fanvueCalls("PATCH /v1/chats/fan-real")).length === 0);

console.log("\n16. Every-minute check catches a missed message");
await clear();
await tap("fv:mode:test");
await clear();
await fetch(`${MOCK}/mock/unread`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([
  { fanUuid: "fan-test", handle: "mytestacct", messages: [{ uuid: "missed-1", text: "did u get my last msg?" }] },
  { fanUuid: "fan-real", handle: "realguy", messages: [{ uuid: "real-9", text: "hello??" }] },
]) });
await fetch(`${WORKER}/__scheduled?cron=*+*+*+*+*`);
const start16 = Date.now();
while (Date.now() - start16 < 120000 && !(await fanvueCalls("POST /v1/chats/fan-test/message")).length) await sleep(500);
check("missed message answered", (await fanvueCalls("POST /v1/chats/fan-test/message")).length >= 1);
check("real fan still ignored in test mode", (await fanvueCalls("GET /v1/chats/fan-real/messages")).length === 0);

console.log("\n17. Going live needs a confirmation");
await clear();
await tap("fv:mode:live");
await expectSent("asks to confirm", /Go live\?/);
await say("/fanvue");
await expectSent("still in test mode until confirmed", /• 🧪 Test|🧪 <b>Test<\/b>/);

console.log("\n18. Selling in /chat (demo catalog)");
await clear();
await say("/chat");
await say("send me something hot");
await expectSent("she sends a locked photo", /Locked photo · \$12\.00/, 60000);

console.log("\n19. Photo settings + a photo made for the Fanvue test fan, with approval");
await say("/stop");
for (const [key, value] of [["trigger_word", "zvx woman"], ["hair_eyes", "long wavy dark brown hair, hazel eyes"], ["lora_url", "https://www.dropbox.com/s/x/lora.safetensors?dl=0"], ["sfw_endpoint_id", "imgsfw12345"]]) {
  await clear();
  await tap(`edit:${key}`);
  await say(value);
  await expectSent(`saved ${key}`, /Saved|Found it/);
}
await clear();
await fanvueWebhook("fan-test", "mytestacct", "take a pic for me?");
const start19 = Date.now();
while (Date.now() - start19 < 180000 && !(await log()).imageJobs.length) await sleep(500);
const imageJob = (await log()).imageJobs[0];
check("image job sent like the Telegram bot does", imageJob && imageJob.lora_url.includes("dropbox") && imageJob.width === 1024 && imageJob.height === 1536 && imageJob.lora_strength === 0.9, JSON.stringify(imageJob));
check("prompt starts with the exact trigger word and hair/eyes", imageJob?.prompt.startsWith("zvx woman, long wavy dark brown hair, hazel eyes, sitting"));
check("prompt ends with the smartphone look", /candid smartphone photo, natural skin texture$/.test(imageJob?.prompt ?? ""));
check("no Telegram token sent to the image endpoint", imageJob && !("telegram_token" in imageJob));
const start19b = Date.now();
while (Date.now() - start19b < 90000 && !(await log()).calls.some((c) => c.method === "sendPhoto")) {
  await fetch(`${WORKER}/__scheduled?cron=*+*+*+*+*`); // the every-minute job, sped up
  await sleep(3000);
}
const photo = (await log()).calls.find((c) => c.method === "sendPhoto");
check("uploaded to Fanvue", (await log()).calls.some((c) => c.method === "s3:PUT") && (await fanvueCalls("PATCH /v1/media/uploads/up1")).length === 1);
check("photo sent to you for approval with ✅/❌", /gen:ok:\d+/.test(photo?.body.raw ?? ""));
check("not sent to the fan before approval", !(await fanvueCalls("POST /v1/chats/fan-test/message")).some((c) => c.body.mediaUuids));
const genId = photo?.body.raw.match(/gen:ok:(\d+)/)?.[1];
await tap(`gen:ok:${genId}`);
await expectSent("approval confirmed", /Sent to the fan/);
const withMedia = (await fanvueCalls("POST /v1/chats/fan-test/message")).find((c) => c.body.mediaUuids);
check("fan got the photo on Fanvue", withMedia?.body.mediaUuids?.[0] === "m-up-1" && withMedia.body.text === "took this for you 🙈", JSON.stringify(withMedia?.body));
await tap(`gen:ok:${genId}`);
await expectSent("can't be sent twice", /already handled/);

console.log("\n20. Blocked photo request");
await clear();
await fanvueWebhook("fan-test", "mytestacct", "take a pic in a school uniform");
await expectSent("minor-coded request flagged to you", /Flagged/, 30000);

console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
process.exit(failures ? 1 : 0);
