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
| Image endpoint | RunPod Serverless, your Krea 2 generator (+ optional SFW one) | only while a photo renders (24 GB GPU) |
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

**Follow [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md)**: every click, with a values sheet and
troubleshooting. The short version:

1. **RunPod:** API key + two endpoints (Serverless → New Endpoint → Import from Docker Registry):
   - chat brain: `ghcr.io/justlinuxnoob/aiempire-chatter-llm:v2.28.0` (48 GB, no settings needed)
   - images: `ghcr.io/justlinuxnoob/krea2-nsfw-serverless:latest` (24 GB): paid photos *and* free teasers
   - *(optional)* a separate SFW generator from `justlinuxnoob/ai-empire-telegram-bot`
2. **Telegram:** @BotFather → `/newbot` → token.
3. **Fanvue:** [create an app](https://www.fanvue.com/developers/apps) on her account: redirect
   `https://aiempire-chatter.<you>.workers.dev/fanvue/callback`, 8 permissions, copy Client ID + Secret.
4. **Deploy to Cloudflare** (button above) with the 4 secrets.
5. Open `https://aiempire-chatter.<you>.workers.dev/setup` → **Open in Telegram** → **Start**.
6. In Telegram: `/setup`, then `/test`, then `/fanvue` → connect → test fan → go live.

## Telegram commands

| Command | What it does |
|---|---|
| `/setup` | The setup questions, one by one |
| `/settings` | See and change everything (persona too) |
| `/sales` | Prices for new photos, how low she haggles, free teasers per day, photos per day, reply speed, optional photo approval |
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
  Photos go to the fan **automatically**. Want to see each one first? Switch on approval in `/sales`.
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

## Ask an AI about this project

The docs are written so an AI assistant can work with this repo:
[AGENTS.md](AGENTS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [llms.txt](llms.txt).
Connect any MCP-capable assistant (Claude, Cursor, …) to **`https://gitmcp.io/justlinuxnoob/aiempire-chatter`**
to give it these docs as a tool.

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
