# AI Empire · Fanvue AI Chatter

Your AI influencer answers her Fanvue chats by herself, in character, like a real
creator would: she reads, waits, types, flirts, remembers every fan, and sells:
locked photos from your vault, and brand-new photos of her taken on demand with
your LoRA.

You control everything from your own Telegram bot. No coding.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/justlinuxnoob/aiempire-chatter)

**▶ Guides and the full course: [joinaiempire.com](https://joinaiempire.com)**

---

## How it fits together

```
Fan writes on Fanvue
   ↓  (checked every minute)
Your Cloudflare Worker  ── this repo, free plan
   ↓
Chat brain on RunPod  ── decides: just chat, sell a vault photo, or take a new one
   ├─ free teaser  → your SFW image endpoint  ─┐
   └─ paid photo   → your NSFW image endpoint ─┴→ uploaded to Fanvue → your ✅ in Telegram → sent to the fan
```

| Piece | Where | Cost |
|---|---|---|
| This Worker | Cloudflare | free plan |
| Chat brain | RunPod Serverless, from [aiempire-chatter-llm](https://github.com/justlinuxnoob/aiempire-chatter-llm) | only while she's thinking (48 GB GPU) |
| Image endpoint(s) | RunPod Serverless, your Krea 2 generators | only while a photo renders (24 GB GPU) |
| Control bot | Telegram | free |

Everything scales to zero: no fans writing, no cost. The first reply after a quiet
spell takes a few minutes while her brain wakes up; fans don't notice, because
she waits before "reading" anyway.

## What you need

- A **Fanvue creator account** with ID verification (KYC) done, marked as an AI creator.
- A **RunPod** account with a little credit ([sign up](https://runpod.io?ref=9s65jq8z)).
- A free **Cloudflare** account and a **GitHub** account.
- **Telegram**.
- Your character **LoRA** (Krea 2) as a download link, plus its **trigger word**.

About 20 minutes, once.

---

## Setup

### 1 · RunPod: three endpoints

RunPod → **Settings → API Keys** → create a key (Read/Write). Keep it for step 4.

Then **Serverless → New Endpoint** three times. For each one, copy its **Endpoint ID**
(the short code at the top of its page).

| Endpoint | Deploy from | GPU | Max workers | Idle timeout |
|---|---|---|---|---|
| **Chat brain** | GitHub repo `justlinuxnoob/aiempire-chatter-llm` (or Docker image `runpod/worker-v1-vllm:v2.28.0` with the settings from its README) | 48 GB | 1 | 120 s |
| **SFW images** | GitHub repo `justlinuxnoob/ai-empire-telegram-bot` | 24 GB | 1 | 30 s |
| **NSFW images** | Docker image `ghcr.io/justlinuxnoob/krea2-nsfw-serverless:latest` | 24 GB | 1 | 30 s |

FlashBoot on for all three. No environment variables needed.

> Short on time? One NSFW endpoint can do both: put the same ID as SFW and NSFW
> in step 6. A prompt with clothes gives a clothed photo.

### 2 · Telegram: your control bot

Open **@BotFather** → `/newbot` → pick a name and username → copy the **token**.
Make a new bot for this.

### 3 · Fanvue: your app

1. Cloudflare first: dash.cloudflare.com → **Workers & Pages**. Note your
   **workers.dev subdomain** (e.g. `yourname.workers.dev`). Your chatter's address
   will be `https://aiempire-chatter.yourname.workers.dev`.
2. Log in to Fanvue as **her** → [fanvue.com/developers/apps](https://www.fanvue.com/developers/apps) → **Create app**.
3. **App type:** Off Platform App, URL: `https://aiempire-chatter.yourname.workers.dev`
4. **Authentication:**
   - **Add redirect:** `https://aiempire-chatter.yourname.workers.dev/fanvue/callback`
   - **Permissions:** `read:self` `read:chat` `write:chat` `read:fan` `read:media` `write:media` `read:insights` `read:creator`
5. Copy the **Client ID** and **Client Secret**. ⚠️ The secret is shown only once.

You don't need to publish the app: a private app works for your own account.

### 4 · Cloudflare: deploy

Click **Deploy to Cloudflare** at the top of this page. Connect GitHub when asked;
Cloudflare copies this repo, creates the database and deploys. It asks for four values:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from step 2 |
| `RUNPOD_API_KEY` | your RunPod key from step 1 |
| `FANVUE_CLIENT_ID` | from step 3 |
| `FANVUE_CLIENT_SECRET` | from step 3 |

Keep the name `aiempire-chatter` (it must match the address in step 3).

### 5 · Connect your Telegram

Open `https://aiempire-chatter.yourname.workers.dev/setup` in a browser → tap
**Open in Telegram** → **Start**. The bot now only listens to you.

### 6 · Set her up (in Telegram)

Send `/setup` and answer: her name, age, persona, chat brain ID, trigger word,
hair & eyes, LoRA link, SFW endpoint ID, NSFW endpoint ID. Change anything later
with `/settings`.

### 7 · Test everything

Send `/test`. It checks Telegram, your settings, Fanvue, her brain (a real question)
and each image endpoint (a real test photo of her, sent to you). The first run can
take ~5 minutes while the endpoints wake up.

Then:
- `/chat`: text her yourself, as a fan.
- `/simulate`: watch her chat with an AI fan (shy, horny, cheap, big spender, girlfriend
  experience, time-waster, multi-texter, safety check).

### 8 · Connect Fanvue and test with a real chat

1. `/fanvue` → **Connect Fanvue** → log in as her → approve.
2. She starts in **🧪 Test mode**: she only answers your own test fan account, real
   fans are ignored. Tap **➕ Add my test fan account**, then from a *fan* account that
   follows/subscribes to her, send her the code the bot gives you.
3. Chat with her from that fan account. Ask for a photo.

### 9 · Go live

`/fanvue` → **🟢 Live** → confirm. Messages older than 24 hours are ignored, so she
doesn't suddenly answer an old backlog.

---

## Telegram commands

| Command | What it does |
|---|---|
| `/setup` | The setup questions, one by one |
| `/settings` | See and change everything (persona too) |
| `/sales` | Prices for new photos, how low she haggles, free teasers per day, photos per day, reply speed, photo approval |
| `/catalog` | Vault photos she sells: AI description + price per photo, change prices, hide photos |
| `/fanvue` | Connect Fanvue, add your test fan account, 🧪 Test / 👀 Dry-run / 🟢 Live |
| `/test` | Check that everything works |
| `/chat` | Text her as a fan (replies start with 💋) |
| `/simulate` | Watch her with an AI fan |
| `/status` | Quick overview |
| `/stop` · `/reset` | Stop chatting or a simulation · forget your test chat |

### Modes

- **🧪 Test**: she only answers your test fan account(s). Start here.
- **👀 Dry-run**: she reads real fans and shows you in Telegram what she *would* reply. Nothing is sent.
- **🟢 Live**: she answers every fan.

## How she sells

- **Warms up first**, finds out what he likes, then offers one photo that fits him,
  usually within his first 5–6 messages (something soft for shy guys).
- **Escalates** with buyers: after a purchase, a bit of chat, then something spicier.
- **Haggling:** she can come down once, never below your floor (`/sales`, default 70%).
- **No spam:** no new locked photo while the last one is unopened; never re-sells what he bought.
- **Vault photos** (`/catalog`): new vault images are picked up every 30 minutes and
  described by the AI with a suggested price, which you can change.
- **New photos on demand:** she writes the prompt with your exact trigger word and
  hair/eyes first, following [docs/image-prompt-rules.md](docs/image-prompt-rules.md).
  Free teasers (default max 1 per fan per day) or paid locked photos (your price range).
  Each photo goes to your Telegram with ✅ / ❌ first, unless you switch approval off.
- You get **💰 @fan bought…** in Telegram for every purchase.

## Built-in rules

The chat brain is uncensored, so these are enforced by the app itself:

- **She stays in character** as a real girl texting. Lines that mention AI, bots or "her
  creator" are caught and rewritten before a fan sees them. If a fan seriously asks
  whether she's real, she teases ("you know what i am babe 😏") without claiming to be
  human; the AI badge on her profile does the disclosure.
- **No real-world promises:** no meetups, calls, addresses or other apps.
- **Minors:** a fan who says he's under 18 is paused immediately and you're alerted.
  Minor-coded requests (teen, school uniform, young-looking, "pretend you're 16"…) are
  flagged, she steers away, and photo prompts with them are blocked.
- **No fake sales:** she never claims to have sent something she didn't, and never trades
  photos for tips.
- Fanvue tokens are stored encrypted. Only the permissions listed in step 3 are requested.

---

## For developers

```
npm install
npm test                 # unit tests (safety, prompts, photos, Fanvue crypto)
npm run typecheck
npm run deploy           # D1 migrations + deploy
scripts/e2e.sh           # full flow against fake Telegram, RunPod and Fanvue (see test/e2e/run.mjs)
scripts/eval.sh 12 shy horny cheap whale   # parallel AI-fan simulations on your deployment (needs ADMIN_KEY)
```

`scripts/admin.sh` and `scripts/eval.sh` need `WORKER_URL` and `ADMIN_KEY` in a local
`secrets.env` (never committed) and the same `ADMIN_KEY` as a Worker secret.

Every table carries `member_id` (see `migrations/`), so one database can hold several creators.
