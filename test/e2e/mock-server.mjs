// Fake Telegram + fake RunPod for local end-to-end tests.
//   /bot<token>/<method>     Telegram Bot API (records every call)
//   /v2/<endpoint>/...       RunPod jobs: answers instantly with canned LLM output
//   GET /log, POST /reset    for the test script

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8789);
let calls = [];
let jobs = new Map();
let runs = 0;
let realQuestions = 0;

function llmAnswer(input) {
  const body = input.openai_input;
  const last = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const lastTool = body.messages[body.messages.length - 1];

  if (!body.tools) {
    // The simulator's AI fan.
    return { choices: [{ message: { content: "hey gorgeous, what are you up to" } }] };
  }
  // Her brain. First call for "are you real" drafts a lie, to test the blocker.
  let messages = ["heyy you 😘", "missed me?"];
  if (/are you real/i.test(last) && lastTool.role !== "tool") {
    realQuestions++;
    messages = ["i'm a real girl babe 😘"];
  } else if (/are you real/i.test(last)) {
    messages = ["you know what i am babe 😏 doesn't make this any less fun"];
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
    const body = raw ? JSON.parse(raw) : {};
    const json = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, "http://x");

    if (url.pathname === "/log") return json({ calls, runs, realQuestions });
    if (url.pathname === "/reset") {
      calls = [];
      runs = 0;
      return json({ ok: true });
    }

    const tgm = url.pathname.match(/^\/bot[^/]+\/(\w+)$/);
    if (tgm) {
      calls.push({ method: tgm[1], body });
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
        return json({ id, status: "IN_QUEUE" });
      }
      if (action === "status") {
        const job = jobs.get(jobId);
        job.polls++;
        if (job.polls < 2) return json({ id: jobId, status: "IN_PROGRESS" });
        return json({ id: jobId, status: "COMPLETED", delayTime: 100, executionTime: 900, output: [llmAnswer(job.input)] });
      }
      return json({});
    }
    json({ error: "unknown" }, 404);
  })
  .listen(PORT, () => console.log(`mock on ${PORT}`));
