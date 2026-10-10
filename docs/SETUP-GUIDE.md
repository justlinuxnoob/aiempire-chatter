# Setup guide: from zero to a working AI chatter

Every click, in order. About **30–40 minutes** the first time, most of it waiting for
things to start. No coding, no terminal.

> **Tip:** open a notes app and keep the **values sheet** below filled in as you go.
> Every value is copied somewhere later.

## Values sheet

| # | Value | Where you get it | Looks like |
|---|---|---|---|
| 1 | RunPod API key | Part 1.2 | `rpa_…` (long) |
| 2 | Chat brain endpoint ID | Part 1.3 | `anupss918yyguy` |
| 3 | Image endpoint ID (NSFW) | Part 1.4 | `telfcvc5va06j2` |
| 4 | *(optional)* SFW image endpoint ID | Part 1.5 | short code |
| 5 | Telegram bot token | Part 2 | `123456789:AA…` |
| 6 | Your Cloudflare workers.dev subdomain | Part 3.2 | `yourname.workers.dev` |
| 7 | Fanvue Client ID | Part 4 | `8d23b691-…` |
| 8 | Fanvue Client Secret | Part 4 | long, **shown once** |
| 9 | LoRA download link | you already have it | `https://www.dropbox.com/…` |
| 10 | Trigger word + hair & eyes | you already have them | `zvx woman` · `long wavy dark brown hair, hazel eyes` |

Accounts you need: **RunPod** (with ~$10 credit), **Telegram**, **Cloudflare** (free),
**GitHub** (free), and her **Fanvue creator account** with ID verification (KYC) done.

---

## Part 1 · RunPod (her brain and her camera)

### 1.1 Account
Sign up at [runpod.io](https://runpod.io?ref=9s65jq8z) and add credit (Billing → add $10).
You only pay while she's actually thinking or taking a photo.

### 1.2 API key → value #1
1. Left menu → **Settings** → **API Keys** → **Create API Key**.
2. Name: `chatter`. Permissions: **All** (read/write).
3. **Create** → copy the key. It's shown only once.

### 1.3 The chat brain → value #2
1. Left menu → **Serverless** → **New Endpoint**.
2. **Import from Docker Registry**.
3. **Container Image:**
   ```
   ghcr.io/justlinuxnoob/aiempire-chatter-llm:v2.28.0
   ```
   → **Next**.
4. **Endpoint Name:** `chatter-brain`
5. **GPU Configuration:** tick the **48 GB** cards (L40S, RTX 6000 Ada, L40, RTX A6000, A40).
6. **Active workers:** `0` · **Max workers:** `1`
7. **Idle timeout:** `120` seconds · **FlashBoot:** on
8. **Container disk:** `60` GB
9. If you see a **CUDA version** filter (advanced settings): allow **13.0 and newer**.
10. **Environment variables:** none, they're built into the image.
11. **Deploy Endpoint**. Copy the **Endpoint ID** at the top of the endpoint page.

### 1.4 The image generator → value #3
Same steps, different values:
- **Container Image:** `ghcr.io/justlinuxnoob/krea2-nsfw-serverless:latest`
- **Endpoint Name:** `chatter-images`
- **GPU:** **24 GB** (RTX 4090, 3090, A5000, L4). Out-of-memory errors later? Add 48 GB cards.
- **Max workers** `1` · **Idle timeout** `30` · **FlashBoot** on · **Container disk** `30` GB
- No environment variables.

This one endpoint does both her free teasers and her paid photos: a prompt with
clothes gives a clothed photo.

### 1.5 *(Optional)* a separate SFW generator → value #4
Skip this unless you specifically want a different model for free teasers.
New Endpoint → **GitHub repo** → `justlinuxnoob/ai-empire-telegram-bot` → 24 GB GPU, max
workers 1, idle 30, FlashBoot, container disk 30 GB. RunPod builds it the first time
(can take a while).

---

## Part 2 · Telegram (your control panel) → value #5

1. In Telegram, open **@BotFather** → send `/newbot`.
2. Pick a display name (e.g. `Luna Control`) and a username ending in `bot` (e.g. `luna_control_bot`).
3. Copy the **token** BotFather sends.

Make a new bot just for this; don't reuse another bot.

---

## Part 3 · Cloudflare (where the chatter runs)

### 3.1 Account
Sign up free at [dash.cloudflare.com](https://dash.cloudflare.com).

### 3.2 Your workers.dev address → value #6
Left menu → **Compute** → **Workers & Pages**. Your subdomain is shown there
(`something.workers.dev`); on a new account it may ask you to pick one, so do that.

Your chatter's address will be:
```
https://aiempire-chatter.SOMETHING.workers.dev
```

---

## Part 4 · Fanvue app (lets the chatter use her account) → values #7, #8

1. Log in to Fanvue **as her** (the creator account).
2. Open [fanvue.com/developers/apps](https://www.fanvue.com/developers/apps) → **Create app**. Name: anything, e.g. `chatter`.
3. **App type** tab: **Off Platform App**, URL `https://aiempire-chatter.SOMETHING.workers.dev` → **Save**.
4. **Authentication** tab:
   - Copy the **Client ID** (value #7) and the **Client secret** (value #8). The secret is
     shown only once. If you missed it, regenerate it.
   - **Redirects → Add redirect:**
     ```
     https://aiempire-chatter.SOMETHING.workers.dev/fanvue/callback
     ```
   - **Define permissions:** tick `read:self`, `read:chat`, `write:chat`, `read:fan`,
     `read:media`, `write:media`, `read:insights`, `read:creator` → save.

You don't need **Publish app**: a private app works for your own account, no review.

---

## Part 5 · Deploy (one button)

1. Open [github.com/justlinuxnoob/aiempire-chatter](https://github.com/justlinuxnoob/aiempire-chatter) → click **Deploy to Cloudflare**.
2. **Git account:** connect your GitHub (authorize Cloudflare). Keep **Create private Git repository** ticked.
3. **Project name:** keep `aiempire-chatter`. If you change it, change it in the two Fanvue addresses too.
4. **D1 database:** leave it on **new**.
5. Paste the four values:
   | Field | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | #5 |
   | `RUNPOD_API_KEY` | #1 |
   | `FANVUE_CLIENT_ID` | #7 |
   | `FANVUE_CLIENT_SECRET` | #8 |
6. Leave the build/deploy commands as they are → **Deploy**. Takes ~2–3 minutes.

---

## Part 6 · Connect your Telegram

1. Open `https://aiempire-chatter.SOMETHING.workers.dev/setup` in your browser.
2. You should see **"✅ Your control bot … is connected"** and, at the bottom, "✅ Fanvue app keys found".
3. Tap **Open in Telegram** → **Start**. The bot says **"🎉 You're connected!"** and now only listens to you.

---

## Part 7 · Set her up (in Telegram)

Send `/setup`. It asks one question at a time:

| Question | Answer |
|---|---|
| Her name | `Luna` |
| Her age (18+) | `24` |
| Persona | copy the example it shows and change it: where she's from, what she's into, how she texts, what she won't talk about |
| Chat brain | value #2 |
| Trigger word | value #10 |
| Hair & eyes | value #10 |
| LoRA link | value #9 |
| NSFW image endpoint | value #3 |
| SFW image endpoint | value #4, or `/skip` |

Everything can be changed later with `/settings`.

---

## Part 8 · Test everything

Send `/test`. Within a few minutes you get:
- ✅ Setup complete
- ✅ Chat brain answered (her first reply after a long sleep takes ~5 minutes while it wakes up)
- ✅ a **test photo of her** from your image endpoint
- ➖ Fanvue: not connected yet (that's next)

Then try her:
- `/chat`: you text her as a fan. `/stop` to stop.
- `/simulate`: pick a fan type and watch a whole conversation.

---

## Part 9 · Connect Fanvue and test with a real chat

1. `/fanvue` → **🔗 Connect Fanvue** → log in as **her** → approve.
   The page says **"Fanvue connected"** and Telegram confirms.
2. She starts in **🧪 Test mode**: she answers **only your test fan account**; real fans are ignored.
3. `/fanvue` → **➕ Add my test fan account**. The bot gives you a code like `test-k3p9q`.
4. In another browser (or private window), log in with a **fan** account that subscribes to her,
   open her chat and send that code. Telegram says **"✅ @… is now your test fan"**.
5. Chat with her from that fan account. Within a minute or two she opens the chat, types and replies.
6. Ask for a photo ("send me a pic of what you're wearing"). She takes a new one and sends it
   a few minutes later. Ask for something spicier and she sends one **locked**, with a price.

---

## Part 10 · Your selling settings (optional)

- `/sales`: price range for new paid photos (default $15–30), how low she haggles (70%),
  free teasers per fan per day (1), new photos per fan per day (4), reply speed
  (natural/fast). Photos are sent **automatically**; you can switch on approval here if you
  want to see each photo first.
- `/catalog`: photos in her Fanvue **vault** she can sell. Each one gets an AI description
  and a suggested price you can change. Photos she takes for fans also land in the vault.

---

## Part 11 · Go live

1. *(Recommended)* `/fanvue` → **👀 Dry-run** for a day: she reads real fans and shows you in
   Telegram what she *would* reply. Nothing is sent.
2. `/fanvue` → **🟢 Live** → **Yes, go live**. Messages older than 24 hours are ignored, so she
   doesn't answer an old backlog.

To pause her any time: `/fanvue` → **🧪 Test**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `/setup` page: "Missing in Cloudflare" | Cloudflare → Workers & Pages → aiempire-chatter → **Settings → Variables and Secrets** → add the missing value as type **Secret** → open the page again |
| `/setup` page: "Telegram doesn't accept the bot token" | Wrong `TELEGRAM_BOT_TOKEN`: copy it again from @BotFather |
| Bot doesn't answer in Telegram | Open the `/setup` page once more (it reconnects the bot) |
| `/test`: "RunPod rejected the API key" | Wrong `RUNPOD_API_KEY`, or it's read-only. Make a new key with All permissions |
| `/test`: "can't find that endpoint ID" | Copy the endpoint ID again from RunPod into `/settings` |
| First reply or photo takes ~5 minutes | Normal after a quiet spell: the GPU is waking up |
| Brain never answers, RunPod shows errors about CUDA | Allow only CUDA 13.0+ hosts in the brain endpoint's settings |
| Image endpoint: out of memory | Add 48 GB GPUs to the image endpoint |
| "Fanvue said: Login session does not match" | You're logged in to Fanvue as another account in that browser. Use the **Log in to Fanvue again** button on that page |
| Fanvue "redirect" / "scope" error | Check Part 4: the redirect must match exactly, all 8 permissions ticked |
| Test fan code does nothing | It's valid 15 minutes; send it as a normal message from the fan account, exactly as shown |
| She doesn't answer a real fan | Mode is 🧪 Test (only test fans) or the message is older than 24 h |
| Deploy: "name already in use" | You already have a Worker called `aiempire-chatter`: pick another project name, and use that name in both Fanvue addresses (Part 4) |
| Brain stuck "initializing" for 20+ minutes | In RunPod, check the endpoint's **Logs**/workers; terminate the worker so a new machine is picked, or add more 48 GB GPU types |

## What it costs

- **Cloudflare, Telegram, GitHub:** free.
- **RunPod:** only while working. The brain bills per second while answering (a 48 GB GPU, a few
  cents per active minute) and stays awake 2 minutes after each reply. Each photo is ~40 seconds
  of a 24 GB GPU. A cold start (first message after a quiet spell) adds a few minutes once.
