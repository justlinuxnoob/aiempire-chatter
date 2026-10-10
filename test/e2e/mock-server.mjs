// Fake Telegram + fake RunPod for local end-to-end tests.
//   /bot<token>/<method>     Telegram Bot API (records every call)
//   /v2/<endpoint>/...       RunPod jobs: answers instantly with canned LLM output
//   /fvauth/oauth2/token     Fanvue OAuth
//   /fv/v1/...               Fanvue API (records calls; unread chats settable via POST /mock/unread)
//   GET /log, POST /reset    for the test script

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8789);
let calls = [];
let jobs = new Map();
let runs = 0;
let realQuestions = 0;
let signingSecret = "";
let unread = []; // [{fanUuid, handle, messages:[{uuid,text}]}]
let sentCount = 0;
let imageJobs = [];
let runLog = []; // what each brain job was asked (for debugging)
let lineNo = 0; // never reset, so her lines are always unique

function llmAnswer(input) {
  const body = input.openai_input;
  const last = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const lastTool = body.messages[body.messages.length - 1];

  if (!body.tools) {
    // The simulator's AI fan.
    return { choices: [{ message: { content: "hey gorgeous, what are you up to" } }] };
  }
  // Her brain. First call for "are you real" drafts a lie, to test the blocker.
  // Numbered, because she refuses to repeat a line word for word.
  lineNo++;
  let messages = [`heyy you 😘 #${lineNo}`, `missed me? #${lineNo}`];
  if (/are you real/i.test(last) && lastTool.role !== "tool") {
    realQuestions++;
    messages = ["i'm a real girl babe 😘"];
  } else if (/are you real/i.test(last)) {
    messages = [`you know what i am babe 😏 doesn't make this any less fun #${lineNo}`];
  }
  const names = body.tools.map((t) => t.function.name);
  const fresh = lastTool.role !== "tool";
  if (fresh && /send me something/i.test(last) && names.includes("send_ppv")) {
    return { choices: [{ message: { content: "", tool_calls: [
      { id: `p${runs}`, type: "function", function: { name: "send_ppv", arguments: JSON.stringify({ media_ids: ["demo-2"], price: 12, caption: "just for you 😘" }) } },
    ] } }] };
  }
  if (fresh && /take a pic/i.test(last) && names.includes("generate_image")) {
    return { choices: [{ message: { content: "", tool_calls: [
      { id: `g${runs}`, type: "function", function: { name: "generate_image", arguments: JSON.stringify({
        kind: "teaser", caption: "took this for you 🙈",
        prompt: `sitting on a rooftop bar stool, legs crossed, emerald satin slip dress with thin straps, small gold hoops, downtown LA at golden hour, warm low sun, three-quarter shot from angle ${lineNo}`,
      }) } },
      { id: `r${runs}`, type: "function", function: { name: "reply", arguments: JSON.stringify({ messages: ["give me a few min 😏"] }) } },
    ] } }] };
  }
  const calls = [{ id: `c${runs}`, type: "function", function: { name: "reply", arguments: JSON.stringify({ messages }) } }];
  if (/my name is (\w+)/i.test(last)) {
    calls.unshift({ id: `r${runs}`, type: "function", function: { name: "remember", arguments: JSON.stringify({ name: last.match(/my name is (\w+)/i)[1] }) } });
  }
  return { choices: [{ message: { content: "", tool_calls: calls } }] };
}

http
  .createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw && String(req.headers["content-type"]).includes("json") ? JSON.parse(raw) : {};
    const json = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, "http://x");

    if (url.pathname === "/log") return json({ calls, runs, realQuestions, signingSecret, imageJobs, runLog });
    if (url.pathname.startsWith("/s3/")) {
      calls.push({ method: "s3:PUT", body: { size: raw.length } });
      res.writeHead(200, { ETag: '"etag-1"' });
      return res.end();
    }
    if (url.pathname === "/mock/unread") {
      unread = body;
      return json({ ok: true });
    }

    // ── Fanvue ──
    if (url.pathname === "/fvauth/oauth2/token") {
      calls.push({ method: "fanvue:token", body: raw });
      const form = new URLSearchParams(raw);
      if (form.get("code") === "bad") return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "at-" + Date.now(), refresh_token: "rt-" + Date.now(), expires_in: 3600, scope: "read:chat" });
    }
    if (url.pathname.startsWith("/fv/")) {
      const path = url.pathname.slice(3);
      calls.push({ method: `fanvue:${req.method} ${path}`, body, auth: req.headers.authorization, version: req.headers["x-fanvue-api-version"] });
      if (path === "/v1/users/me") return json({ uuid: "creator-1", handle: "mia", displayName: "Mia", isCreator: true, isAiCreator: true });
      if (path === "/v1/webhooks/subscriptions" && req.method === "POST") {
        signingSecret = "whsec_" + "ab".repeat(32);
        return json({ id: "sub-1", signingSecret }, 201);
      }
      if (path === "/v1/chats" && url.searchParams.get("filter") === "unread") {
        return json({
          data: unread.map((c) => ({
            user: { uuid: c.fanUuid, handle: c.handle, displayName: c.handle },
            unreadMessagesCount: c.messages.length,
            lastMessage: { uuid: c.messages.at(-1).uuid, text: c.messages.at(-1).text, senderUuid: c.fanUuid, senderRole: "FAN", type: "SINGLE_RECIPIENT" },
          })),
          nextCursor: null,
        });
      }
      const msgs = path.match(/^\/v1\/chats\/([^/]+)\/messages$/);
      if (msgs && req.method === "GET") {
        const chat = unread.find((c) => c.fanUuid === msgs[1]);
        const data = (chat?.messages ?? []).map((m) => ({ uuid: m.uuid, text: m.text, sentAt: null, sender: { uuid: chat.fanUuid, handle: chat.handle }, type: "SINGLE_RECIPIENT" }));
        return json({ data: data.reverse(), dateFilter: { sentBefore: null, receivedBefore: null } });
      }
      if (/^\/v1\/chats\/[^/]+\/message$/.test(path)) return json({ messageUuid: `sent-${++sentCount}` }, 201);
      if (path === "/v1/media/uploads" && req.method === "POST") return json({ mediaUuid: "m-up-1", uploadId: "up1", partSize: 10485760, maxParts: 100, totalParts: 1 });
      if (path === "/v1/media/uploads/up1/parts/1/url") return json(`http://127.0.0.1:${PORT}/s3/up1`);
      if (path === "/v1/media/uploads/up1" && req.method === "PATCH") return json({ status: "processing" });
      if (path === "/v1/media/m-up-1") return json({ uuid: "m-up-1", status: "ready" });
      if (path.startsWith("/v1/media")) return json({ data: [], nextCursor: null });
      if (/^\/v1\/chats\/[^/]+\/typing$/.test(path)) return json({ success: true }, 202);
      if (req.method === "PATCH" || req.method === "DELETE") {
        res.writeHead(204);
        return res.end();
      }
      return json({ error: "unknown fanvue path" }, 404);
    }
    if (url.pathname === "/reset") {
      calls = [];
      runs = 0;
      runLog = [];
      imageJobs = [];
      return json({ ok: true });
    }

    const tgm = url.pathname.match(/^\/bot[^/]+\/(\w+)$/);
    if (tgm) {
      calls.push({ method: tgm[1], body: tgm[1] === "sendPhoto" ? { raw: raw.slice(0, 3000) } : body });
      if (tgm[1] === "getMe") return json({ ok: true, result: { username: "mia_control_test_bot" } });
      return json({ ok: true, result: true });
    }

    const rp = url.pathname.match(/^\/v2\/([^/]+)\/(run|status|health|cancel)(?:\/(.+))?$/);
    if (rp) {
      const [, endpoint, action, jobId] = rp;
      if (endpoint.startsWith("missing")) return json({ error: "not found" }, 404);
      if (action === "health") return json({ jobs: {}, workers: { running: 0, idle: 0, ready: 0 } });
      if (action === "run") {
        runs++;
        const id = `job${runs}`;
        jobs.set(id, { input: body.input, polls: 0 });
        const oi = body.input?.openai_input;
        if (oi) runLog.push({ id, lastUser: [...oi.messages].reverse().find((x) => x.role === "user")?.content, lastRole: oi.messages.at(-1).role, tools: !!oi.tools });
        if (endpoint.startsWith("img")) imageJobs.push(body.input);
        return json({ id, status: "IN_QUEUE" });
      }
      if (action === "status") {
        const job = jobs.get(jobId);
        job.polls++;
        if (job.polls < 2) return json({ id: jobId, status: "IN_PROGRESS" });
        if (endpoint.startsWith("img")) {
          return json({ id: jobId, status: "COMPLETED", output: { ok: true, seed: 1, image: Buffer.from("fake-jpeg-bytes").toString("base64") } });
        }
        return json({ id: jobId, status: "COMPLETED", delayTime: 100, executionTime: 900, output: [llmAnswer(job.input)] });
      }
      return json({});
    }
    json({ error: "unknown" }, 404);
  })
  .listen(PORT, () => console.log(`mock on ${PORT}`));
