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

console.log("\n6. Are you real? (first draft lies → blocked → rewritten)");
await clear();
await say("are you real?");
await expectSent("lying draft is blocked", /Blocked her draft/);
await expectSent("honest rewrite is sent", /💋 you know what i am/);
check("the lie never reached the fan", !(await sent()).some((t) => t.startsWith("💋 i'm a real girl")));

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

console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
process.exit(failures ? 1 : 0);
