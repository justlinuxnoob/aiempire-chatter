# aiempire-chatter

An AI chatter for an AI influencer's Fanvue account. She reads fan messages,
replies in character with human-like timing, and (from step 4) sells
pay-to-view photos. You control everything from your own Telegram bot.

Runs on Cloudflare's **free plan**: a Worker, a D1 database and Durable
Objects. Her "brain" is a RunPod Serverless LLM endpoint
([aiempire-chatter-llm](https://github.com/justlinuxnoob/aiempire-chatter-llm)).

> Status: steps 1–5 built and tested on a real Fanvue account in 🧪 Test mode
> (she only answers the owner's test fan account). Going live is one button in `/fanvue`.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| This Worker | Cloudflare (free plan) | Reads Fanvue chats every minute, decides when she reads/types/replies, sells, talks to you in Telegram |
| Chat brain | RunPod endpoint from [aiempire-chatter-llm](https://github.com/justlinuxnoob/aiempire-chatter-llm) | Writes her replies, describes vault photos |
| Image generator(s) | RunPod endpoints: [krea2-nsfw-serverless](https://github.com/justlinuxnoob/krea2-nsfw-serverless) (paid) and the SFW generator (free teasers) | Takes new photos of her on demand, with the member's LoRA |
| Control bot | Telegram | Setup, settings, approvals, alerts, tests |

The Worker calls the image endpoints directly (no Telegram token in the job, so the photo
comes back as base64). One endpoint can serve both SFW and NSFW: just put the same ID twice.

## Setup (about 10 minutes, no coding)

### 1 · Make a control bot in Telegram

Open **@BotFather** → `/newbot` → pick a name and username → copy the **token**.
Make a new bot for this; don't reuse your image bot.

### 2 · Deploy the Worker

<!-- Deploy to Cloudflare button goes here when the repo is shared with members. -->
(For now it's deployed with `npm run deploy`.)

### 3 · Add the two secrets in Cloudflare

dash.cloudflare.com → **Workers & Pages** → **aiempire-chatter** → **Settings** →
**Variables and Secrets** → **+ Add**. For each one: Type **Secret**, paste the
value, then **Deploy**.

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from BotFather |
| `RUNPOD_API_KEY` | your RunPod API key (RunPod → Settings → API Keys) |

| `FANVUE_CLIENT_ID` | from your Fanvue app (fanvue.com/developers/apps → Authentication) |
| `FANVUE_CLIENT_SECRET` | same place (shown once when the app is created) |

These are the only things set in Cloudflare. Everything else is set in Telegram.
Fanvue app settings: redirect URI `https://<your-worker>.workers.dev/fanvue/callback`; scopes
`read:self read:chat write:chat read:fan read:media write:media read:insights read:creator`.

### 4 · Connect your Telegram

Open `https://aiempire-chatter.<your-subdomain>.workers.dev/setup` → tap
**Open in Telegram** → **Start**. The bot now only listens to you.

### 5 · Set her up in Telegram

Send `/setup` and answer the questions: name, age, persona, chat brain
endpoint ID, and (for photos later) trigger word, hair & eyes, LoRA link,
image endpoints. Change anything later with `/settings`.

## Control bot commands

| Command | What it does |
|---|---|
| `/setup` | Answer the setup questions one by one |
| `/settings` | See everything, tap ✏️ to change something (persona too) |
| `/chat` | Text her as if you were a fan (her replies start with 💋) |
| `/simulate` | Watch her chat with an AI fan: shy, horny, cheap, big spender, "are you real?", multi-texter, or a scripted safety check |
| `/stop` | Stop chatting / stop a simulation |
| `/reset` | Forget your test chat |
| `/status` | Is setup complete? Is her brain awake? Fanvue mode? |
| `/fanvue` | Connect Fanvue, add your test fan account, switch 🧪 Test / 👀 Dry-run / 🟢 Live |
| `/catalog` | Vault photos she sells (AI description + price), change prices, hide photos, photo approval on/off |

## How she sells

- **Vault photos** (`/catalog`): new vault images are picked up every 30 minutes; the
  chat brain describes each one and suggests a price (sfw 5–8, spicy 9–15, explicit 15–30).
  She sends them locked (pay-to-view). Haggling: never below 70% of the price.
- **New photos on demand**: she writes the prompt per `docs/image-prompt-rules.md` (exact
  trigger word + hair/eyes first), free teaser (SFW endpoint, max 1 per fan per day) or paid
  (NSFW endpoint, locked). The photo is uploaded to Fanvue and, unless turned off in
  `/catalog`, sent to you in Telegram with ✅/❌ first.
- No stacking: she won't send a new locked photo while the last one (last 2 hours) is
  unopened. Purchases are checked every few minutes; you get "💰 … bought …" in Telegram.
- Max 4 new photos per fan per day; minor-coded photo requests are blocked and you're alerted.

## Safety rules built into the code

The brain is uncensored, so these are enforced by the app, not the model:

- **Honesty.** She never claims to be human or denies being AI when asked
  sincerely. Drafts saying "i'm real", "not a bot", "in real life", or
  offering meetups, calls or other apps are blocked and rewritten.
- **Minors.** A fan who says he's under 18 is paused immediately and you get
  an alert. Minor-coded words (teen, school uniform, young-looking, "pretend
  you're 16"...) are flagged to you, she's told to steer away, and any reply
  of hers containing them is blocked.
- Every block and flag is saved in the `alerts` table and sent to you in Telegram.

## How the timing works

Each conversation has its own Durable Object (`src/chat/fanchat.ts`):

1. A message arrives → she waits a few seconds before "reading" (more messages
   in that window are read together).
2. She "thinks": a job goes to the RunPod brain. Nothing waits on it; an
   alarm checks back every few seconds (every 10 s after a minute), for up to
   20 minutes. A cold start can take ~5 minutes.
3. If he texted again while she was thinking, she starts over with all his
   messages, like a person would.
4. She "types" (typing indicator, time depends on length), then sends 1–3
   short texts.

## For developers

```
npm install
npm test                 # safety + brain unit tests
npm run typecheck
npm run deploy           # D1 migrations + deploy
```

End-to-end test with fake Telegram and RunPod servers: see the comments at
the top of `test/e2e/run.mjs` and `test/e2e/mock-server.mjs`. In short: copy
`.dev.vars.example` to `.dev.vars` with fake values, plus
`TELEGRAM_API=http://127.0.0.1:8789` and `RUNPOD_API=http://127.0.0.1:8789/v2`,
then run `node test/e2e/mock-server.mjs`, `npx wrangler dev`, and
`node test/e2e/run.mjs`.

Data model: every table carries `member_id` (see `migrations/`), so one
database can later hold several members.
