// The owner's Telegram control bot: /setup, /settings, /chat, /simulate...

import { esc, send, sendPlain, tg, type Button } from "../telegram";
import { health } from "../runpod";
import {
  claim, clearMode, deleteFan, getMode, getOwner, getSettings, setMode, setSetting, type Member,
} from "../db";
import { FIELDS, fieldByKey, missingForChat, type Field } from "./fields";
import { FAN_TYPES } from "../sim/fans";
import { fanvueStatusLine, onFanvueButton, showFanvue } from "./fanvue-panel";
import { answerPrice, onCatalogButton, showCatalog } from "./catalog-panel";
import { review } from "../photos/generate";

const HELP = `<b>Commands</b>
/setup – answer a few questions to set her up
/settings – see and change anything
/chat – text her as if you were a fan
/simulate – watch her chat with an AI fan
/fanvue – connect Fanvue, test mode / dry-run / live
/catalog – photos she sells and their prices
/stop – stop chatting or the simulation
/reset – forget the test chat and start over
/status – is everything set up and awake?`;

export async function handleUpdate(env: Env, update: any, origin: string): Promise<void> {
  if (update.callback_query) return onButton(env, update.callback_query, origin);
  const msg = update.message;
  if (!msg?.chat || msg.chat.type !== "private") return;
  const userId = String(msg.from?.id ?? "");
  const chatId = String(msg.chat.id);
  const text: string = (msg.text ?? "").trim();

  const owner = await getOwner(env);
  if (!owner) {
    const code = text.match(/^\/start\s+(\S+)/)?.[1];
    const member = code ? await claim(env, code, userId, chatId) : null;
    if (!member) {
      return send(env, chatId, "🔒 This bot isn't connected yet. Open your Worker's <b>/setup</b> page in a browser and tap the link there.");
    }
    return send(env, chatId, `🎉 <b>You're connected!</b> This bot now only listens to you.\n\nNext: send /setup and answer a few questions about her.`);
  }
  if (owner.telegram_user_id !== userId) return send(env, chatId, "🔒 This is a private bot.");
  if (!text) return send(env, chatId, "I only understand text messages here. /help");

  const command = text.match(/^\/(\w+)/)?.[1]?.toLowerCase();
  const mode = await getMode(env, owner.id);

  // Answering a /setup or /settings question?
  if (mode && (mode.mode === "setup" || mode.mode === "edit") && mode.field) {
    if (command === "cancel") {
      await clearMode(env, owner.id);
      return send(env, chatId, "OK, stopped. Nothing else changed. /settings to see everything.");
    }
    if (mode.field.startsWith("price:") && !command) return answerPrice(env, owner, mode.field.slice(6), text);
    if (!command || command === "skip" || command === "keep") return answer(env, owner, mode.mode, mode.field, text, command);
  }

  switch (command) {
    case "start":
    case "help":
      return send(env, chatId, HELP);
    case "setup":
      return startSetup(env, owner);
    case "settings":
      await clearMode(env, owner.id);
      return showSettings(env, owner);
    case "chat":
      return startChat(env, owner);
    case "simulate":
      return chooseSimulation(env, owner);
    case "stop":
      return stopAll(env, owner);
    case "reset":
      return resetChat(env, owner);
    case "status":
      return status(env, owner);
    case "fanvue":
      return showFanvue(env, owner, origin);
    case "catalog":
      return showCatalog(env, owner);
    case "cancel":
      await clearMode(env, owner.id);
      return send(env, chatId, "Nothing to cancel. /help");
  }

  if (command) return send(env, chatId, `I don't know /${esc(command)}.\n\n${HELP}`);
  if (mode?.mode === "fan") return chatAsFan(env, owner, text);
  return send(env, chatId, `To text her as a fan, send /chat first.\n\n${HELP}`);
}

// ── /setup and /settings ─────────────────────────────────────────────────

async function startSetup(env: Env, owner: Member): Promise<void> {
  await send(env, owner.telegram_chat_id, `Let's set her up: ${FIELDS.length} quick questions, one at a time.\nYou can change anything later with /settings. /cancel stops.`);
  await ask(env, owner, "setup", FIELDS[0]);
}

async function ask(env: Env, owner: Member, mode: "setup" | "edit", field: Field): Promise<void> {
  await setMode(env, owner.id, mode, field.key);
  const settings = await getSettings(env, owner.id);
  const current = settings[field.key];
  const step = mode === "setup" ? `<b>${FIELDS.indexOf(field) + 1}/${FIELDS.length} · ${esc(field.label)}</b>\n` : `<b>${esc(field.label)}</b>\n`;
  let html = step + esc(field.question);
  if (field.key === "persona") {
    // The example (or her current persona) comes as its own message so it's easy to copy.
    await send(env, owner.telegram_chat_id, html);
    await sendPlain(env, owner.telegram_chat_id, current || field.example || "");
    html = current ? "☝️ That's her current persona. Copy it, change it, send it back." : "☝️ Copy it, change it, send it back.";
  } else {
    if (field.example) html += `\nExample: <code>${esc(field.example)}</code>`;
    if (current) html += `\nNow: <code>${esc(current)}</code>`;
  }
  const hints = [current ? "/keep to keep it" : "", field.optional ? "/skip for now" : "", "/cancel to stop"].filter(Boolean);
  await send(env, owner.telegram_chat_id, `${html}\n\n<i>${hints.join(" · ")}</i>`);
}

async function answer(env: Env, owner: Member, mode: string, key: string, text: string, command?: string): Promise<void> {
  const chatId = owner.telegram_chat_id;
  const field = fieldByKey(key)!;
  const settings = await getSettings(env, owner.id);

  if (command === "skip" && !field.optional) return send(env, chatId, "This one is needed. Send an answer, or /cancel.");
  if (command === "keep" && !settings[key]) return send(env, chatId, "There's nothing saved yet. Send an answer.");

  if (!command) {
    const result = await field.validate(text, env);
    if ("error" in result) return send(env, chatId, result.error);
    await setSetting(env, owner.id, key, result.value);
    await send(env, chatId, result.note ?? "✅ Saved.");
  }

  if (mode === "edit") {
    await clearMode(env, owner.id);
    return showSettings(env, owner);
  }

  const next = FIELDS[FIELDS.indexOf(field) + 1];
  if (next) return ask(env, owner, "setup", next);

  await clearMode(env, owner.id);
  await showSettings(env, owner);
  const missing = missingForChat(await getSettings(env, owner.id));
  await send(
    env,
    chatId,
    missing.length
      ? `Almost there. Still needed: ${missing.map((f) => f.label).join(", ")}.`
      : "🎉 <b>Setup done!</b>\nTry it: /chat to text her yourself, or /simulate to watch her with an AI fan.",
  );
}

async function showSettings(env: Env, owner: Member): Promise<void> {
  const settings = await getSettings(env, owner.id);
  const lines = FIELDS.map((f) => {
    const v = settings[f.key];
    let shown = v ? `<code>${esc(v)}</code>` : f.optional ? "– (later)" : "❗ not set";
    if (f.key === "persona" && v) shown = `${v.length} characters, tap ✏️ Persona to read or change`;
    if (f.key === "lora_url" && v) shown = "saved ✅";
    return `<b>${esc(f.label)}:</b> ${shown}`;
  });
  const buttons: Button[][] = [];
  for (let i = 0; i < FIELDS.length; i += 2) {
    buttons.push(FIELDS.slice(i, i + 2).map((f) => ({ text: `✏️ ${f.label.replace(/ \(.*\)/, "")}`, callback_data: `edit:${f.key}` })));
  }
  await send(env, owner.telegram_chat_id, `⚙️ <b>Settings</b>\n\n${lines.join("\n")}`, buttons);
}

// ── /chat, /simulate, /stop, /reset ──────────────────────────────────────

const testFanId = (owner: Member) => `test:${owner.telegram_user_id}`;

function fanChat(env: Env, owner: Member, which: "test" | "sim") {
  const name = which === "test" ? `${owner.id}:${testFanId(owner)}` : `${owner.id}:sim`;
  const ns = env.FAN_CHAT;
  return ns.get(ns.idFromName(name));
}

async function readyToChat(env: Env, owner: Member): Promise<boolean> {
  const missing = missingForChat(await getSettings(env, owner.id));
  if (!missing.length) return true;
  await send(env, owner.telegram_chat_id, `First finish setting her up. Missing: ${missing.map((f) => f.label).join(", ")}.\nSend /setup.`);
  return false;
}

async function startChat(env: Env, owner: Member): Promise<void> {
  if (!(await readyToChat(env, owner))) return;
  await setMode(env, owner.id, "fan");
  const name = (await getSettings(env, owner.id)).name;
  await send(
    env,
    owner.telegram_chat_id,
    `👤 <b>You're a fan now.</b> Text ${esc(name)} anything. Her replies start with 💋.\nShe takes a few seconds to read and type, like a person. If her brain is asleep, the first reply takes a few minutes.\n\n/stop to stop · /reset to start over as a new fan`,
  );
}

async function chatAsFan(env: Env, owner: Member, text: string): Promise<void> {
  await fanChat(env, owner, "test").receive(owner.id, testFanId(owner), "test", owner.telegram_chat_id, text);
}

async function chooseSimulation(env: Env, owner: Member): Promise<void> {
  if (!(await readyToChat(env, owner))) return;
  const types = Object.entries(FAN_TYPES);
  const buttons: Button[][] = [];
  for (let i = 0; i < types.length; i += 2) {
    buttons.push(types.slice(i, i + 2).map(([key, t]) => ({ text: t.label, callback_data: `sim:${key}` })));
  }
  await send(env, owner.telegram_chat_id, "🎭 Which kind of fan should she talk to?", buttons);
}

async function stopAll(env: Env, owner: Member): Promise<void> {
  const mode = await getMode(env, owner.id);
  await clearMode(env, owner.id);
  const simWasRunning = await fanChat(env, owner, "sim").stop();
  if (mode?.mode === "fan") return send(env, owner.telegram_chat_id, "👋 You're not a fan anymore. /chat to go back to her (she'll remember you), /reset to start over.");
  if (!simWasRunning) return send(env, owner.telegram_chat_id, "Nothing was running. /help");
}

async function resetChat(env: Env, owner: Member): Promise<void> {
  await fanChat(env, owner, "test").reset();
  await deleteFan(env, owner.id, testFanId(owner));
  await send(env, owner.telegram_chat_id, "🧹 Done. She's forgotten your test chat. /chat to start fresh as a new fan.");
}

async function status(env: Env, owner: Member): Promise<void> {
  const settings = await getSettings(env, owner.id);
  const missing = missingForChat(settings);
  const lines = [missing.length ? `❗ Setup incomplete: ${missing.map((f) => f.label).join(", ")}` : "✅ Setup complete"];
  if (settings.llm_endpoint_id) {
    const h = await health(env, settings.llm_endpoint_id);
    lines.push(!h.ok ? `❌ Chat brain: ${esc(h.reason)}` : h.awake ? "🧠 Chat brain: awake" : "💤 Chat brain: asleep (first reply takes a few minutes)");
  }
  const mode = await getMode(env, owner.id);
  if (mode?.mode === "fan") lines.push("👤 You're in fan mode (/stop to leave)");
  lines.push(await fanvueStatusLine(env, owner.id));
  await send(env, owner.telegram_chat_id, lines.join("\n"));
}

// ── buttons ──────────────────────────────────────────────────────────────

async function onButton(env: Env, query: any, origin: string): Promise<void> {
  await tg(env, "answerCallbackQuery", { callback_query_id: query.id });
  const owner = await getOwner(env);
  if (!owner || String(query.from?.id) !== owner.telegram_user_id) return;
  const [kind, ...rest] = String(query.data ?? "").split(":");
  const value = rest.join(":");

  if (kind === "fv") return onFanvueButton(env, owner, value, origin);
  if (kind === "cat") return onCatalogButton(env, owner, value);
  if (kind === "gen") {
    const [decision, id] = value.split(":");
    return send(env, owner.telegram_chat_id, await review(env, Number(id), decision === "ok"));
  }

  if (kind === "edit") {
    const field = fieldByKey(value);
    if (field) await ask(env, owner, "edit", field);
  } else if (kind === "sim" && FAN_TYPES[value]) {
    if (!(await readyToChat(env, owner))) return;
    await fanChat(env, owner, "sim").simulate(owner.id, owner.telegram_chat_id, value);
  }
}
