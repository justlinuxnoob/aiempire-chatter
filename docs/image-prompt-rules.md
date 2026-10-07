# Image prompt rules (used by the generate_image tool)

> Status: saved for step 5, not built yet.
> Before step 5: read justlinuxnoob/krea2-nsfw-serverless and the SFW endpoint,
> confirm how the trigger word, LoRA link and prompt are actually passed, and
> adjust these rules to match.

## Per-account settings

`TRIGGER_WORD`, `HAIR_EYES`, `LORA_URL` (Dropbox link), `SFW_ENDPOINT_ID`, `NSFW_ENDPOINT_ID`.
These are the only things a member sets.

## What the chatter decides from the conversation

- Free teaser or tease → SFW endpoint
- Paid PPV → NSFW endpoint

She doesn't robotically ask "what picture do you want". She reads what the fan
asked for, and if it's unclear she asks in character.

## SFW prompt order (40–60 words)

trigger word, hair and eyes, shot and pose, outfit, place, light, framing,
candid smartphone photo, natural skin texture

- Outfits very specific (colour, fabric, cut) + small accessories
- Places real and specific, light real and specific
- Mix framings: close-up, upper body, cowboy shot, three-quarter, full body

## NSFW prompt order (45–75 words)

trigger word, hair and eyes, pose and action, what is visible, place, lighting,
candid smartphone photo, natural skin texture

## Rules for both

- Always the exact trigger word and hair/eyes. Never change them
- Never describe her face, skin tone or body shape — the LoRA knows them
- Specific, natural, like a real private smartphone photo
- Repeat requests ("another", "more") → same idea, different angle, pose detail or lighting
- Send only the finished prompt to the tool
- Minor-coded terms (school uniform, teen, young-looking, petite girl, etc.) are
  blocked — rewrite the request or decline in character, and alert me in Discord

---

## Confirmed from the code (7 Oct 2026)

Read from justlinuxnoob/ai-empire-telegram-bot (`cloudflare/worker.js`, `handler.py`):

- The bot sends a RunPod `/run` job with
  `{"input": {"prompt", "lora_url", "lora_strength": 0.9, "width": 1024, "height": 1536, "telegram_token", "chat_id"}}`.
- With `telegram_token` + `chat_id` the generator posts the photo to Telegram itself.
  **Without them it returns `{"ok": true, "seed", "image": "<base64 JPEG>"}`.** The chatter uses this
  mode: same input minus the Telegram fields, then uploads the image to Fanvue.
- The trigger word is not a separate field: it is simply the start of `prompt`
  (e.g. `zvx woman, long wavy dark brown hair, hazel eyes, ...`).
- `lora_url` accepts Dropbox (`dl=0` → `dl=1` is done by the generator), Google Drive and Hugging Face links.
- The bot appends "candid smartphone photo, natural skin texture" if missing; the chatter's rules already include it.

Read from justlinuxnoob/krea2-nsfw-serverless (`serverless/handler.py`, `cloudflare/worker.js`):

- NSFW job input: `{"input": {"prompt", "lora_url", "seed"?}}`. No width/height/strength
  (the workflow fixes them; the character LoRA goes in slot 3 at strength 1.0).
- Same output as SFW: without Telegram fields → `{"ok": true, "seed", "image": "<base64 JPEG>"}`;
  on failure `{"error": "..."}`.
- First photo after a break: 1–3 minutes (README); the owner has seen ~10 minutes.

So the chatter sends:

| | SFW endpoint | NSFW endpoint |
|---|---|---|
| input | prompt, lora_url, lora_strength 0.9, width 1024, height 1536 | prompt, lora_url |
| prompt | built per the SFW rules above | built per the NSFW rules above |

## Change of plan

Alerts and the ✅/❌ approval queue go to a **Telegram control-panel bot** (owner's choice, 7 Oct 2026),
not Discord.
