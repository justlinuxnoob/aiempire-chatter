# AGENTS.md: guide for AI assistants working on this repo

You're looking at **aiempire-chatter**: an AI chatter for a creator's Fanvue account. It
reads fan messages, answers in character with human-like timing, remembers each fan, and
sells: locked (pay-to-view) photos from the vault and new photos generated on demand.
The owner controls it from a private Telegram bot. It's sold as part of the AI Empire
course; every member self-hosts their own copy.

Read in this order: this file → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) →
[docs/FANVUE-API-NOTES.md](docs/FANVUE-API-NOTES.md). User-facing setup:
[docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md).

## The system (3 repos, 1 Worker)

| Piece | Repo / image | Runs on |
|---|---|---|
| **This Worker** (TypeScript) | this repo | Cloudflare Workers, free plan: D1 + Durable Objects + cron |
| **Chat brain** (LLM) | [aiempire-chatter-llm](https://github.com/justlinuxnoob/aiempire-chatter-llm), image `ghcr.io/justlinuxnoob/aiempire-chatter-llm:v2.28.0` | RunPod Serverless, 48 GB. Qwen3.6-27B abliterated AWQ on vLLM 0.30, OpenAI-compatible tool calling |
| **Image generator(s)** | `ghcr.io/justlinuxnoob/krea2-nsfw-serverless:latest` (NSFW, also used for teasers) and optionally `justlinuxnoob/ai-empire-telegram-bot` (SFW) | RunPod Serverless, 24 GB. Krea 2 + the member's LoRA |
| **Control panel** | Telegram bot (any token from @BotFather) | Telegram webhook → this Worker |

Everything talks over HTTPS; nothing is long-running. RunPod is always called with
`/run` + `/status` polling (never blocking), because cold starts take minutes.

## File map

```
src/
  index.ts              routes: /, /setup, /telegram, /fanvue/callback, /fanvue/webhook, /admin/*; cron → scheduled()
  env.ts                secrets/bindings typing
  db.ts                 D1 helpers (members, settings, control_state, fans, messages, alerts)
  telegram.ts           Bot API: send (HTML), sendPhoto (multipart), typing, webhook secret
  runpod.ts             submitJob / checkJob / cancelJob / health
  crypto.ts             AES-GCM token encryption (key = HKDF(FANVUE_CLIENT_SECRET)), PKCE, HMAC
  chat/fanchat.ts       ★ FanChat Durable Object: one per conversation, the whole reply state machine
  chat/timing.ts        human-like delays per source (test / sim / fanvue / fanvueFast)
  brain/prompt.ts       system prompt (persona + fixed rules + selling + photo rules), history → chat, summary prompt
  brain/tools.ts        tool schemas (reply, remember, get_fan_profile, list_catalog, send_ppv, generate_image), parsing
  brain/safety.ts       regex guards: under-18, minor-coded words, out-of-character, real-world contact
  catalog/catalog.ts    vault sync, vision descriptions, sales table, purchase checks, demo catalog
  photos/generate.ts    generate_image: prompt building/blocklist/limits → RunPod → Fanvue upload → (optional approval) → send
  fanvue/auth.ts        OAuth 2.0 + PKCE connect, encrypted tokens, rotating refresh under a D1 lock
  fanvue/api.ts         Fanvue REST wrapper (X-Fanvue-API-Version, retries, plain-text bodies)
  fanvue/inbound.ts     webhook (signed) + every-minute poll of unread chats → route() → FanChat
  fanvue/connect.ts     OAuth callback page, webhook subscription
  control/bot.ts        Telegram command router: /setup /settings /chat /simulate /stop /reset /status /fanvue /catalog /sales /test
  control/fields.ts     /setup questions (FIELDS) and /sales settings (SALES_FIELDS) with validation + defaults
  control/*-panel.ts    /fanvue, /catalog, /sales screens and buttons
  control/selftest.ts   /test: checks settings, Fanvue, brain (real job), image endpoints (real photo)
  sim/fans.ts           AI fan personas for /simulate and scripts/eval.sh
migrations/             D1 schema, applied in order by `npm run deploy`
test/*.test.ts          vitest unit tests (pure functions)
test/e2e/               fake Telegram + RunPod + Fanvue server and a 90-check end-to-end script
scripts/                e2e.sh (local full flow), eval.sh (parallel AI-fan simulations), admin.sh (admin routes)
docs/                   SETUP-GUIDE, ARCHITECTURE, FANVUE-API-NOTES, image-prompt-rules
```

## Commands

```bash
npm install
npm test              # unit tests
npm run typecheck     # tsc --noEmit (src only)
npm run deploy        # wrangler d1 migrations apply DB --remote && wrangler deploy
scripts/e2e.sh        # full local flow against fakes (needs .dev.vars with fake values, see test/e2e/run.mjs header)
scripts/eval.sh 12 shy horny cheap whale burst gfe timewaster   # live simulations (needs ADMIN_KEY + WORKER_URL in secrets.env)
scripts/admin.sh simulate shy | say "hey" | transcript | selftest | fv '{"path":"/v1/users/me"}'
```

## Secrets (Cloudflare → Worker → Settings → Variables and Secrets)

| Name | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | control bot |
| `RUNPOD_API_KEY` | yes | read/write |
| `FANVUE_CLIENT_ID`, `FANVUE_CLIENT_SECRET` | for Fanvue | the secret is also the encryption key base: rotating it means reconnecting Fanvue |
| `ADMIN_KEY` | no | enables `/admin/*` routes for scripts; without it they 404 |

Everything else (name, persona, endpoint IDs, LoRA link, prices…) lives in the D1
`settings` table, set through Telegram.

## Conventions

- Plain, friendly user-facing text (the owner and course members aren't developers). Telegram messages use `parse_mode: HTML`: always `esc()` user/model text.
- Every table has `member_id`. A deployment has one owner (first to claim via `/setup`), but queries stay member-scoped.
- Money is stored in **cents** (`price_cents`, `total_spent_cents`); the model sees USD.
- Nothing blocks on RunPod: submit a job, set an alarm (DO) or let the cron poll, check back.
- Safety is enforced in code, not trusted to the (uncensored) model: see `brain/safety.ts`, `checkPpv`, `buildPrompt`.
- Comments explain *why*; keep them short.

## Gotchas (learned the hard way)

- **Fanvue webhook subscriptions return 400** for this kind of app, so new messages arrive via the **every-minute cron poll** (`pollUnread`). The webhook path is kept for when it works.
- Fanvue's upload part-URL endpoint returns a **plain-text** URL, not JSON (`fv()` handles it).
- Fanvue v1 `GET /chats/{uuid}/messages` defaults `markAsRead=false`; the bot marks read itself when she "opens" the chat (not in dry-run).
- Fanvue prices are **cents**, minimum 300; the send endpoint doesn't enforce the $500 max, so the code does.
- Refresh tokens rotate and are single-use (30 s grace): refresh happens under a D1 row lock (`refreshing_until`).
- Generated photos are uploaded to Fanvue media, so they appear in her **vault**; `syncVault` skips media uuids found in `generations` so they're never resold.
- Free plan: **50 outgoing requests per invocation**. That's why the cron is split (`* * * * *` messages/photos, `*/5 * * * *` catalog/purchases), the poll handles ≤15 chats and ≤2 photos per run, and POSTs to Fanvue aren't retried on 5xx (could double-send).
- Photo rows are claimed with conditional `UPDATE … WHERE status = ?` (`claim()` in `photos/generate.ts`) so overlapping runs or a double ✅ can't send twice.
- The model refuses to repeat itself: identical lines (vs the last 30 messages) are dropped in `pollTurn`. Fake/mocked LLMs must vary their lines.
- `wrangler d1 execute --json` output may include non-JSON warnings on stderr; redirect `2>/dev/null`.
- In scripts, never `pkill -f` a pattern that appears in your own command line (it kills your shell); `scripts/e2e.sh` uses `[m]ock-server` style patterns.
- `runpod/worker-v1-vllm` tags appear on GitHub before Docker Hub; check Docker Hub before bumping.

## How to…

- **Change her behaviour:** `brain/prompt.ts` (fixed rules) or the owner's persona via `/settings`. Then run `scripts/eval.sh` and read the transcripts.
- **Add a tool:** schema in `brain/tools.ts` (+ `toolsFor`), handling in `FanChat.pollTurn`, guidance in `prompt.ts`, a case in `test/e2e/mock-server.mjs` if the e2e should exercise it.
- **Add a setting:** a `Field` in `control/fields.ts` (`FIELDS` = asked in /setup, `SALES_FIELDS` = /sales with a default), read it with `getSettings` / `salesNumber`.
- **Change the schema:** new `migrations/000N_*.sql` (never edit applied ones); `npm run deploy` applies it.
