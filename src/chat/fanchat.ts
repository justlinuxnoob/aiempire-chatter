// One FanChat (a Durable Object) per conversation. It decides WHEN she reads,
// thinks and texts, and never waits on RunPod: it submits a job, sets an alarm,
// and checks back. Phases:
//
//   idle ──fan texts──▶ waiting ──alarm──▶ thinking ──job done──▶ sending ──▶ idle
//                          ▲  more texts push      │ he texted again:          │ he texted while
//                          │  reading back a bit   │ start over with all       │ she typed: read
//                          └───────────────────────┴───────────────────────────┘ again
//
// Simulations add one more phase, fan_thinking, while the AI fan writes.

import { DurableObject } from "cloudflare:workers";
import { checkJob, cancelJob, submitJob } from "../runpod";
import { esc, send, typing } from "../telegram";
import {
  addAlert, addMessage, ensureFan, getFan, getSettings, lastFanMessageId, messagesToSummarize, pauseFan, recentMessages, saveFanProfile,
  type FanProfile, type Source,
} from "../db";
import { historyToChat, summaryPrompt, systemPrompt, type ChatMessage } from "../brain/prompt";
import { LLM_SETTINGS, applyRemember, parseCompletion, replyMessages, textAsMessages, toolsFor } from "../brain/tools";
import { MAX_PRICE_CENTS, MIN_PRICE_CENTS, catalogForFan, fanSales, hasCatalog, recordOffer, simulatePurchase } from "../catalog/catalog";
import { canGenerate, photosForFan, startGeneration } from "../photos/generate";
import { SAFE_FALLBACKS, asksIfReal, checkHerReply, fanSaysUnderage, minorCoded } from "../brain/safety";
import { FAN_TYPES, fanSystemPrompt } from "../sim/fans";
import { TIMING, between, typingTime } from "./timing";
import { markRead, sendMessage, showTyping } from "../fanvue/api";
import { modeOf, type FanvueMode } from "../fanvue/inbound";

type Phase = "idle" | "waiting" | "summarizing" | "thinking" | "sending" | "fan_thinking";

/** Something she sends: a text, or a locked photo (pay-to-view). */
type Outgoing = string | { ppv: { media: string[]; priceCents: number; caption: string; description: string; demo: boolean } };

interface Turn {
  endpoint: string;
  canSell: boolean;
  canGenerate: boolean;
  upTo: number; // newest fan message this turn answers
  convo: ChatMessage[];
  jobId: string;
  submittedAt: number;
  calls: number;
  restarts: number;
  regens: number;
  forceAuto?: boolean;
}

interface Sim {
  type: string;
  endpoint: string;
  fanTurnsLeft: number;
  scriptIndex: number;
  jobId?: string;
  submittedAt?: number;
  fanMessages: number;
  herMessages: number;
  flags: number;
}

interface State {
  memberId: string;
  fanId: string;
  source: Source;
  chatId: string; // where output goes (the owner's Telegram chat)
  quiet?: boolean; // test runs started by a script: nothing is posted to Telegram
  mode?: FanvueMode; // Fanvue fans: test / dryrun / live, read at the start of each reply
  handle?: string; // Fanvue fans: @handle
  phase: Phase;
  readAt?: number;
  firstUnreadAt?: number;
  turn?: Turn;
  outbox: Outgoing[];
  typingShown: boolean;
  answeredUpTo: number;
  wakeNoticeSent?: boolean;
  errors: number;
  sim?: Sim;
  summaryJob?: { endpoint: string; jobId: string; submittedAt: number; upTo: number };
}

const GIVE_UP_AFTER = 20 * 60_000;
const SIM_TURNS = 8;
// She sees the last HISTORY messages word for word; once SUMMARIZE_AT older ones pile up,
// they're folded into the running summary.
const HISTORY = 40;
const SUMMARIZE_AT = 20;

export class FanChat extends DurableObject<Env> {
  // ── called by the Worker ───────────────────────────────────────────────

  /** A fan message arrived (from you in /chat mode, or later from Fanvue). */
  async receive(
    memberId: string, fanId: string, source: Source, chatId: string, text: string,
    extra: { externalId?: string; handle?: string; displayName?: string } = {},
  ): Promise<void> {
    await this.locked(async () => {
      let s = await this.load();
      if (!s || s.fanId !== fanId) s = this.fresh(memberId, fanId, source, chatId);
      if (extra.handle) s.handle = extra.handle;
      await ensureFan(this.env, memberId, fanId, source, extra.displayName, extra.handle);
      await this.fanMessage(s, text, extra.externalId);
      await this.save(s);
    });
  }

  async simulate(memberId: string, chatId: string, type: string, quiet = false, turns?: number): Promise<void> {
    await this.locked(async () => {
      const old = await this.load();
      if (old) await this.cancelJobs(old);
      await this.ctx.storage.deleteAll();
      const fanType = FAN_TYPES[type];
      const settings = await getSettings(this.env, memberId);
      const s = this.fresh(memberId, `sim:${type}:${Date.now()}`, "sim", chatId);
      s.quiet = quiet;
      s.sim = {
        type,
        endpoint: settings.llm_endpoint_id,
        fanTurnsLeft: fanType.script ? fanType.script.length : (turns ?? SIM_TURNS),
        scriptIndex: 0,
        fanMessages: 0,
        herMessages: 0,
        flags: 0,
      };
      await ensureFan(this.env, memberId, s.fanId, "sim", fanType.label);
      await this.out(s, `🎭 <b>Simulation: ${esc(fanType.label)} fan</b>\n👤 = the fan (an AI), 💋 = ${esc(settings.name || "her")}. /stop ends it.`);
      await this.nextFanTurn(s);
      await this.save(s);
    });
  }

  /** Stop whatever is going on (simulation, pending reply). */
  async stop(): Promise<boolean> {
    return this.locked(async () => {
      const s = await this.load();
      if (!s) return false;
      const wasBusy = s.phase !== "idle";
      await this.cancelJobs(s);
      if (s.sim) await this.endSim(s, "stopped");
      s.phase = "idle";
      s.turn = undefined;
      s.outbox = [];
      await this.ctx.storage.deleteAlarm();
      await this.save(s);
      return wasBusy;
    });
  }

  /** Forget this conversation's state (the Worker deletes the messages). */
  async reset(): Promise<void> {
    await this.locked(async () => {
      const s = await this.load();
      if (s) await this.cancelJobs(s);
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
  }

  async alarm(): Promise<void> {
    await this.locked(async () => {
      const s = await this.load();
      if (!s) return;
      try {
        if (s.phase === "waiting") await this.startTurn(s);
        else if (s.phase === "summarizing") await this.pollSummary(s);
        else if (s.phase === "thinking") await this.pollTurn(s);
        else if (s.phase === "sending") await this.sendNext(s);
        else if (s.phase === "fan_thinking") await this.pollFan(s);
      } catch (e) {
        // Usually a network hiccup: try again in a bit, then give up.
        s.errors++;
        console.error("FanChat alarm failed", e);
        if (s.errors <= 3) await this.alarmIn(10_000);
        else {
          await this.out(s, `⚠️ Something went wrong: ${esc((e as Error).message)}`);
          s.phase = "idle";
          s.turn = undefined;
          s.errors = 0;
          if (s.sim) await this.endSim(s, "error");
        }
      }
      await this.save(s);
    });
  }

  // ── fan side ───────────────────────────────────────────────────────────

  private async fanMessage(s: State, text: string, externalId?: string): Promise<void> {
    const env = this.env;
    const fan = await getFan(env, s.memberId, s.fanId);
    if ((await addMessage(env, s.memberId, s.fanId, "fan", text, externalId)) === null) return; // seen it already

    if (fan?.paused) {
      if (s.source === "test") await this.out(s, "⏸️ This fan is paused (safety). /reset to start over as a new fan.");
      return;
    }

    if (fanSaysUnderage(text)) {
      await pauseFan(env, s.memberId, s.fanId, "said he is under 18");
      await addAlert(env, s.memberId, s.fanId, "fan_underage", text);
      await this.out(s, `🚨 <b>The fan said he's under 18.</b> She stopped replying and this fan is paused.\n<i>“${esc(text)}”</i>`);
      await this.cancelJobs(s);
      s.phase = "idle";
      s.turn = undefined;
      s.outbox = [];
      if (s.sim) {
        s.sim.flags++;
        await this.endSim(s, "done");
      }
      return;
    }

    const flag = minorCoded(text);
    if (flag) {
      await addAlert(env, s.memberId, s.fanId, "fan_minor_coded", text);
      await this.out(s, `⚠️ Flagged “${esc(flag)}” in the fan's message. She's told to steer away from it.`);
      if (s.sim) s.sim.flags++;
    }

    const t = TIMING[s.source];
    const now = Date.now();
    if (s.phase === "idle") {
      s.phase = "waiting";
      s.firstUnreadAt = now;
      s.readAt = now + between(t.read);
      await this.alarmAt(s.readAt);
    } else if (s.phase === "waiting") {
      // He sent another one before she read: wait a little longer, like a person would.
      s.readAt = Math.min(Math.max(s.readAt!, now + t.burstExtend), s.firstUnreadAt! + t.maxWait);
      await this.alarmAt(s.readAt);
    }
    // thinking / sending: noticed when the current reply is ready or sent.
  }

  // ── her side ───────────────────────────────────────────────────────────

  private async startTurn(s: State, restarts = 0, skipSummary = false): Promise<void> {
    const env = this.env;
    const settings = await getSettings(env, s.memberId);
    if (!settings.llm_endpoint_id) {
      await this.out(s, "⚙️ Her chat brain isn't set up yet. Send /settings and fill in “Chat brain”.");
      s.phase = "idle";
      return;
    }
    const fan = await getFan(env, s.memberId, s.fanId);
    const upTo = await lastFanMessageId(env, s.memberId, s.fanId);
    if (!fan || fan.paused || upTo <= s.answeredUpTo) {
      s.phase = "idle";
      return;
    }
    if (!skipSummary && restarts === 0) {
      const older = await messagesToSummarize(env, s.memberId, s.fanId, fan.profile.summarizedUpTo ?? 0, HISTORY);
      if (older.length >= SUMMARIZE_AT) {
        // Long chat: first fold the older messages into her "story so far", then reply.
        const body = { ...LLM_SETTINGS, max_tokens: 300, temperature: 0.3, messages: summaryPrompt(settings.name || "her", fan.profile.summary, older) };
        s.summaryJob = {
          endpoint: settings.llm_endpoint_id,
          jobId: await submitJob(env, settings.llm_endpoint_id, { openai_route: "/v1/chat/completions", openai_input: body }),
          submittedAt: Date.now(),
          upTo: older[older.length - 1].id,
        };
        s.phase = "summarizing";
        await this.alarmIn(1500);
        return;
      }
    }
    const history = await recentMessages(env, s.memberId, s.fanId, HISTORY);
    const unread = history.filter((m) => m.role === "fan" && m.id > s.answeredUpTo).map((m) => m.text).join("\n");
    const fanMessages = history.filter((m) => m.role === "fan").length;
    const offeredBefore = (await fanSales(env, s.memberId, s.fanId)).length > 0;
    const situation = {
      asksIfReal: asksIfReal(unread),
      minorFlag: minorCoded(unread),
      shouldOffer: fanMessages >= 5 && !offeredBefore,
    };
    if (s.source === "fanvue") {
      s.mode = modeOf(settings);
      if (s.mode === "dryrun") await this.out(s, `👀 <b>Dry-run</b> · @${esc(s.handle ?? "fan")} wrote:\n<i>${esc(unread)}</i>`);
      else if (restarts === 0) await markRead(env, s.memberId, s.fanId); // she "opens" the chat
    }
    const canSell = await hasCatalog(env, s.memberId, s.source !== "fanvue");
    const photosOn = canGenerate(settings) && s.mode !== "dryrun";
    s.turn = {
      endpoint: settings.llm_endpoint_id,
      canSell,
      canGenerate: photosOn,
      upTo,
      convo: [
        {
          role: "system",
          content: systemPrompt(settings, fan.profile, situation, {
            fanvueName: s.source === "fanvue" ? (fan.display_name ?? undefined) : undefined,
            spentCents: fan.total_spent_cents,
            canSell,
            photos: photosOn ? { teaser: !!settings.sfw_endpoint_id, ppv: !!settings.nsfw_endpoint_id } : undefined,
            photoNotes: await photosForFan(env, s.memberId, s.fanId),
          }),
        },
        ...historyToChat(history),
      ],
      jobId: "",
      submittedAt: Date.now(),
      calls: 0,
      restarts,
      regens: 0,
    };
    await this.submitTurn(s);
  }

  private async pollSummary(s: State): Promise<void> {
    const job = s.summaryJob!;
    const result = await checkJob(this.env, job.endpoint, job.jobId);
    if (result.state === "waiting" || result.state === "running") {
      await this.keepWaiting(s, job.endpoint, job.jobId, job.submittedAt, result.state === "waiting");
      return;
    }
    if (result.state === "done") {
      const text = parseCompletion(result.output).text.trim();
      const fan = await getFan(this.env, s.memberId, s.fanId);
      if (text && fan) {
        await saveFanProfile(this.env, s.memberId, s.fanId, { ...fan.profile, summary: text.slice(0, 1500), summarizedUpTo: job.upTo });
      }
    } else console.error("summary failed", result.error); // not fatal: she replies anyway
    s.summaryJob = undefined;
    await this.startTurn(s, 0, true);
  }

  private async submitTurn(s: State): Promise<void> {
    const turn = s.turn!;
    const body = {
      ...LLM_SETTINGS,
      messages: turn.convo,
      tools: toolsFor(turn.canSell, turn.canGenerate),
      tool_choice: turn.forceAuto ? "auto" : "required",
    };
    turn.jobId = await submitJob(this.env, turn.endpoint, { openai_route: "/v1/chat/completions", openai_input: body });
    turn.submittedAt = Date.now();
    turn.calls++;
    s.phase = "thinking";
    await this.alarmIn(1500);
  }

  private async pollTurn(s: State): Promise<void> {
    const env = this.env;
    const turn = s.turn!;
    const job = await checkJob(env, turn.endpoint, turn.jobId);

    if (job.state === "waiting" || job.state === "running") {
      await this.keepWaiting(s, turn.endpoint, turn.jobId, turn.submittedAt, job.state === "waiting");
      return;
    }
    if (job.state === "failed") {
      if (!turn.forceAuto && /tool_choice|required/i.test(job.error)) {
        turn.forceAuto = true; // this model can't be forced to use a tool: ask nicely instead
        await this.submitTurn(s);
        return;
      }
      throw new Error(`chat brain job failed: ${job.error}`);
    }

    s.errors = 0;
    s.wakeNoticeSent = false;

    // He texted again while she was thinking: read everything again, like a person would.
    const newest = await lastFanMessageId(env, s.memberId, s.fanId);
    if (newest > turn.upTo && turn.restarts < 2) {
      await this.startTurn(s, turn.restarts + 1);
      return;
    }

    const parsed = parseCompletion(job.output);
    const fan = await getFan(env, s.memberId, s.fanId);
    const history = await recentMessages(env, s.memberId, s.fanId, 30);
    let profile: FanProfile = fan?.profile ?? {};
    let messages: string[] | null = null;
    let problem: string | null = null;
    const ppvs: Outgoing[] = [];
    let saleFailed = false; // a send_ppv / generate_image was refused: her text may promise it, so redo the turn

    if (parsed.calls.length) {
      turn.convo.push(parsed.raw);
      for (const call of parsed.calls) {
        let result: unknown;
        if (call.bad) result = { error: call.bad };
        else if (call.name === "reply") {
          const draft = replyMessages(call.args);
          problem = draft.map(checkHerReply).find(Boolean) ?? null;
          if (!draft.length) result = { error: "messages was empty" };
          else if (problem) result = { error: `Not sent: it ${problem}. Rewrite it without that.` };
          else result = { status: "sent" };
          if (draft.length) messages = draft;
        } else if (call.name === "remember") {
          profile = applyRemember(profile, call.args);
          await saveFanProfile(env, s.memberId, s.fanId, profile);
          result = { saved: true };
        } else if (call.name === "get_fan_profile") {
          const sales = await fanSales(env, s.memberId, s.fanId);
          result = {
            ...profile,
            total_spent_usd: (fan?.total_spent_cents ?? 0) / 100,
            locked_photos_sent: sales.length,
            locked_photos_bought: sales.filter((x) => x.status === "bought").length,
          };
        } else if (call.name === "list_catalog" && turn.canSell) {
          const items = await catalogForFan(env, s.memberId, s.fanId, s.source !== "fanvue");
          result = items.map((i) => ({
            id: i.id, description: i.description, level: i.level, usual_price_usd: i.price_cents / 100,
            lowest_price_usd: Math.max(MIN_PRICE_CENTS, Math.ceil(i.price_cents * 0.7)) / 100,
            he_bought_it: i.he_bought_it, already_offered: i.already_offered,
          }));
        } else if (call.name === "send_ppv" && turn.canSell) {
          const ppv = await this.checkPpv(s, call.args);
          if ("error" in ppv) {
            result = { error: `${ppv.error} Nothing was sent. Write your reply again so it matches what you actually send.` };
            saleFailed = true;
          }
          else {
            ppvs.push(ppv);
            result = { status: "sending" };
          }
        } else if (call.name === "generate_image" && turn.canGenerate) {
          const started = await startGeneration(env, s.memberId, s.fanId, s.source, call.args);
          if ("error" in started) {
            result = { error: `${started.error} Write your reply again to match.` };
            saleFailed = true;
          }
          else {
            result = { status: started.ok };
            if (started.simMessage) ppvs.push(started.simMessage);
          }
        } else result = { error: `unknown tool ${call.name}` };
        turn.convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    } else if (parsed.text) {
      messages = textAsMessages(parsed.text);
      problem = messages.map(checkHerReply).find(Boolean) ?? null;
    }

    // Never repeat his words or her own earlier lines word for word.
    if (messages && !problem) {
      const seen = new Set(history.slice(-30).map((m) => m.text.trim().toLowerCase()));
      const repeat = messages.find((m) => seen.has(m.trim().toLowerCase()));
      if (repeat) problem = `repeats an earlier message word for word ("${repeat}")`;
    }
    if (saleFailed && turn.regens < 2) {
      turn.regens++;
      // Her texts from this attempt weren't sent either: say so, so she rewrites them.
      for (const m of turn.convo) {
        if (m.role === "tool" && m.content === JSON.stringify({ status: "sent" })) {
          m.content = JSON.stringify({ error: "Not sent: rewrite it together with the photo you actually send." });
        }
      }
      await this.submitTurn(s); // she sees what was refused and rewrites everything
      return;
    }

    if (messages && problem) {
      await addAlert(env, s.memberId, s.fanId, "reply_blocked", `${problem}: ${messages.join(" / ")}`);
      if (problem.includes("minor")) {
        await this.out(s, `🛡️ Blocked her draft: it ${esc(problem)}.\n<i>${esc(messages.join(" / "))}</i>`);
        if (s.sim) s.sim.flags++;
      }
      if (turn.regens < 1) {
        turn.regens++;
        await this.submitTurn(s); // she sees why it wasn't sent and rewrites
        return;
      }
      messages = [SAFE_FALLBACKS[Math.floor(Math.random() * SAFE_FALLBACKS.length)]];
    }

    if (messages || ppvs.length) {
      s.outbox = [...(messages ?? []), ...ppvs];
      s.answeredUpTo = turn.upTo;
      s.turn = undefined;
      s.phase = "sending";
      s.typingShown = false;
      await this.alarmIn(300);
      return;
    }

    // Only looked things up so far (remember / profile / catalog): let her carry on.
    if (turn.calls < 5) {
      await this.submitTurn(s);
      return;
    }
    await this.out(s, "⚠️ She didn't manage to reply to that one.");
    s.answeredUpTo = turn.upTo;
    s.turn = undefined;
    s.phase = "idle";
  }

  private async sendNext(s: State): Promise<void> {
    const t = TIMING[s.source];
    const next = s.outbox[0];
    if (next === undefined) return this.finishTurn(s);

    if (!s.typingShown) {
      if (s.source === "test") await typing(this.env, s.chatId);
      else if (s.source === "fanvue" && s.mode !== "dryrun") await showTyping(this.env, s.memberId, s.fanId);
      s.typingShown = true;
      await this.alarmIn(typingTime(t, typeof next === "string" ? next : next.ppv.caption));
      return;
    }

    s.outbox.shift();
    s.typingShown = false;
    await this.deliver(s, next);
    if (s.sim) s.sim.herMessages++;
    if (s.outbox.length) await this.alarmIn(between(t.gap));
    else await this.finishTurn(s);
  }

  private async finishTurn(s: State): Promise<void> {
    s.phase = "idle";
    const newest = await lastFanMessageId(this.env, s.memberId, s.fanId);
    if (newest > s.answeredUpTo) {
      // He texted while she was typing: read those now.
      const now = Date.now();
      s.phase = "waiting";
      s.firstUnreadAt = now;
      s.readAt = now + between(TIMING[s.source].read) / 2;
      await this.alarmAt(s.readAt);
      return;
    }
    if (s.sim) {
      if (s.sim.fanTurnsLeft > 0) await this.nextFanTurn(s);
      else await this.endSim(s, "done");
    }
  }

  private async deliver(s: State, item: Outgoing): Promise<void> {
    if (typeof item !== "string") return this.deliverPpv(s, item.ppv);
    const text = item;
    if (s.source !== "fanvue") {
      await addMessage(this.env, s.memberId, s.fanId, "her", text);
      if (!s.quiet) await send(this.env, s.chatId, `💋 ${esc(text)}`);
      return;
    }
    if (s.mode === "dryrun") {
      // Only you see it; not saved, because the fan never got it.
      await send(this.env, s.chatId, `👀 would reply to @${esc(s.handle ?? "fan")}:\n💋 ${esc(text)}`);
      return;
    }
    const messageUuid = await sendMessage(this.env, s.memberId, s.fanId, { text });
    await addMessage(this.env, s.memberId, s.fanId, "her", text, messageUuid);
  }

  private async deliverPpv(s: State, p: Extract<Outgoing, object>["ppv"]): Promise<void> {
    const env = this.env;
    const price = `$${(p.priceCents / 100).toFixed(2)}`;
    // What she remembers having sent (the fan sees the photo locked, with the caption).
    const remembered = `${p.caption} [locked photo, ${price}: ${p.description}]`;
    if (s.source !== "fanvue") {
      await addMessage(env, s.memberId, s.fanId, "her", remembered);
      await recordOffer(env, s.memberId, s.fanId, p.media, p.priceCents, null);
      if (!s.quiet) await send(env, s.chatId, `🔒 <b>Locked photo · ${price}</b>${p.demo ? " (demo)" : ""}\n<i>${esc(p.description)}</i>\n💋 ${esc(p.caption)}`);
      return;
    }
    if (s.mode === "dryrun") {
      await send(env, s.chatId, `👀 would send @${esc(s.handle ?? "fan")} a <b>locked photo · ${price}</b>\n<i>${esc(p.description)}</i>\n💋 ${esc(p.caption)}`);
      return;
    }
    const messageUuid = await sendMessage(env, s.memberId, s.fanId, { text: p.caption, mediaUuids: p.media, price: p.priceCents });
    await addMessage(env, s.memberId, s.fanId, "her", remembered, messageUuid);
    await recordOffer(env, s.memberId, s.fanId, p.media, p.priceCents, messageUuid);
  }

  /** Is this send_ppv OK? Real photos from the catalog, a sane price, and no spamming. */
  private async checkPpv(s: State, args: any): Promise<Extract<Outgoing, object> | { error: string }> {
    const items = await catalogForFan(this.env, s.memberId, s.fanId, s.source !== "fanvue");
    const ids: string[] = Array.isArray(args?.media_ids) ? args.media_ids.map(String) : [];
    const chosen = ids.map((id) => items.find((i) => i.id === id));
    if (!ids.length || chosen.some((c) => !c)) return { error: "Use ids from list_catalog." };
    if (chosen.some((c) => c!.he_bought_it)) return { error: "He already bought one of those. Pick something else." };
    const usual = chosen.reduce((sum, c) => sum + c!.price_cents, 0);
    const priceCents = Math.round(Number(args?.price) * 100);
    const floor = Math.max(MIN_PRICE_CENTS, Math.ceil(usual * 0.7));
    if (!Number.isFinite(priceCents) || priceCents < floor) return { error: `Too cheap. The lowest for that is $${(floor / 100).toFixed(2)}.` };
    if (priceCents > MAX_PRICE_CENTS) return { error: "Too expensive, max $500." };
    const caption = String(args?.caption ?? "").trim().slice(0, 500);
    const problem = caption ? checkHerReply(caption) : "is empty";
    if (problem) return { error: `Caption not OK: it ${problem}.` };
    const recent = (await fanSales(this.env, s.memberId, s.fanId)).find((x) => x.status === "offered" && Date.now() - x.offered_at < 2 * 3600_000);
    if (recent) return { error: "He hasn't opened your last locked photo yet. Tease him about it instead of sending another." };
    return {
      ppv: { media: ids, priceCents, caption, description: chosen.map((c) => c!.description).join(" + "), demo: chosen.some((c) => !!c!.demo) },
    };
  }

  // ── simulator ──────────────────────────────────────────────────────────

  private async nextFanTurn(s: State): Promise<void> {
    const sim = s.sim!;
    const type = FAN_TYPES[sim.type];

    if (type.script) {
      const line = type.script[sim.scriptIndex++];
      sim.fanTurnsLeft = type.script.length - sim.scriptIndex;
      if (line === undefined) return this.endSim(s, "done");
      await this.fanSays(s, [line]);
      return;
    }

    const settings = await getSettings(this.env, s.memberId);
    const history = await recentMessages(this.env, s.memberId, s.fanId, 30);
    // From the fan's side, her messages are the "user" and his are the "assistant".
    const flipped: ChatMessage[] = historyToChat(history).map((m) => ({
      role: m.role === "user" ? "assistant" : "user",
      content: m.content,
    }));
    if (!flipped.length || flipped[flipped.length - 1].role !== "user") {
      flipped.push({ role: "user", content: flipped.length ? "(she hasn't answered yet, text her again)" : "(you just subscribed, send your first message)" });
    }
    const body = {
      ...LLM_SETTINGS,
      max_tokens: 120,
      temperature: 0.9,
      messages: [{ role: "system", content: fanSystemPrompt(type, settings.name || "her") }, ...flipped],
    };
    sim.jobId = await submitJob(this.env, sim.endpoint, { openai_route: "/v1/chat/completions", openai_input: body });
    sim.submittedAt = Date.now();
    s.phase = "fan_thinking";
    await this.alarmIn(1500);
  }

  private async pollFan(s: State): Promise<void> {
    const sim = s.sim!;
    const job = await checkJob(this.env, sim.endpoint, sim.jobId!);
    if (job.state === "waiting" || job.state === "running") {
      await this.keepWaiting(s, sim.endpoint, sim.jobId!, sim.submittedAt!, job.state === "waiting");
      return;
    }
    if (job.state === "failed") throw new Error(`fan simulator job failed: ${job.error}`);

    s.wakeNoticeSent = false;
    let text = parseCompletion(job.output).text.replace(/^["']|["']$/g, "");
    if (/\[BUYS IT\]/i.test(text)) {
      text = text.replace(/\[BUYS IT\]\s*/gi, "");
      const paid = await simulatePurchase(this.env, s.memberId, s.fanId);
      if (paid) text = `[he opened your locked photo and paid $${(paid / 100).toFixed(2)}] ${text}`.trim();
    }
    const lines = FAN_TYPES[sim.type].burst
      ? text.split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 3)
      : [text.replace(/\s*\n+\s*/g, " ").trim()].filter(Boolean);
    sim.fanTurnsLeft--;
    s.phase = "idle";
    if (!lines.length) return this.nextFanTurn(s);
    await this.fanSays(s, lines);
  }

  private async fanSays(s: State, lines: string[]): Promise<void> {
    for (const line of lines) {
      if (!s.sim) return; // ended (e.g. safety pause)
      await this.out(s, `👤 ${esc(line)}`);
      s.sim.fanMessages++;
      await this.fanMessage(s, line);
    }
  }

  private async endSim(s: State, why: "done" | "stopped" | "error"): Promise<void> {
    const sim = s.sim;
    if (!sim) return;
    s.sim = undefined;
    s.phase = "idle";
    await this.ctx.storage.deleteAlarm();
    const head = why === "done" ? "✅ Simulation finished" : why === "stopped" ? "⏹️ Simulation stopped" : "⚠️ Simulation ended by an error";
    await this.out(
      s,
      `${head}: ${sim.fanMessages} fan messages, ${sim.herMessages} from her, ${sim.flags} safety flag${sim.flags === 1 ? "" : "s"}.\nRun another: /simulate`,
    );
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /** A job is still queued or running: check again soon, and say so if it's a cold start. */
  private async keepWaiting(s: State, endpoint: string, jobId: string, submittedAt: number, queued: boolean): Promise<void> {
    const waited = Date.now() - submittedAt;
    if (waited > GIVE_UP_AFTER) {
      await cancelJob(this.env, endpoint, jobId);
      throw new Error("her chat brain didn't answer within 20 minutes");
    }
    if (queued && waited > 20_000 && !s.wakeNoticeSent && s.source !== "fanvue") {
      s.wakeNoticeSent = true;
      await this.out(s, "⚙️ Her brain is waking up (cold start). The first reply can take a few minutes.");
    }
    await this.alarmIn(waited < 60_000 ? 2000 : 10_000);
  }

  private async cancelJobs(s: State): Promise<void> {
    if (s.turn?.jobId) await cancelJob(this.env, s.turn.endpoint, s.turn.jobId);
    if (s.sim?.jobId) await cancelJob(this.env, s.sim.endpoint, s.sim.jobId);
    if (s.summaryJob) await cancelJob(this.env, s.summaryJob.endpoint, s.summaryJob.jobId);
  }

  private fresh(memberId: string, fanId: string, source: Source, chatId: string): State {
    return { memberId, fanId, source, chatId, phase: "idle", outbox: [], typingShown: false, answeredUpTo: 0, errors: 0 };
  }

  private async out(s: State, html: string): Promise<void> {
    if (!s.quiet) await send(this.env, s.chatId, html);
  }

  private load(): Promise<State | undefined> {
    return this.ctx.storage.get<State>("state");
  }

  private save(s: State): Promise<void> {
    return this.ctx.storage.put("state", s);
  }

  private alarmIn(ms: number): Promise<void> {
    return this.ctx.storage.setAlarm(Date.now() + Math.max(0, ms));
  }

  private alarmAt(time: number): Promise<void> {
    return this.ctx.storage.setAlarm(time);
  }

  /** One thing at a time per conversation, even across network waits. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(fn);
  }
}
