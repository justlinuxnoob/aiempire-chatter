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
