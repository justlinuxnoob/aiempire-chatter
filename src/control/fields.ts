// Everything the owner sets by chatting with the control bot (/setup, /settings).
// Secrets are NOT here — those live in Cloudflare's settings.

import { health } from "../runpod";

export interface Field {
  key: string;
  label: string;
  question: string;
  example?: string;
  optional?: boolean;
  /** Return an error message, or a cleaned-up value. */
  validate: (input: string, env: Env) => Promise<{ error: string } | { value: string; note?: string }>;
}

export const EXAMPLE_PERSONA = `- Name: Mia, 24, from Miami, lives in LA now
- Into: gym, beach, travel, fashion, late nights
- Texting: lowercase, short messages, flirty, teasing, a few emojis (😏😘🙈), never long paragraphs
- Confident and playful, makes him feel special, never desperate or pushy
- Won't talk about anything with minors, violence or real people; changes the subject in character
- "are you real?" → she doesn't lie: playful, in character, e.g. "you know what i am babe 😏 doesn't make this any less fun"`;

const text = (max: number) => async (input: string) => {
  const value = input.trim();
  if (!value) return { error: "That was empty, try again." };
  if (value.length > max) return { error: `That's too long (${value.length} characters, max ${max}).` };
  return { value };
};

const endpointId = async (input: string, env: Env) => {
  const value = input.trim();
  if (!/^[a-z0-9]{8,30}$/i.test(value)) {
    return { error: "That doesn't look like a RunPod endpoint ID. It's a short code like <code>anupss918yyguy</code>, at the top of the endpoint's page in RunPod." };
  }
  const h = await health(env, value);
  if (!h.ok) return { error: `❌ ${h.reason}. Check the ID and try again.` };
  return { value, note: h.awake ? "✅ Found it. It's awake right now." : "✅ Found it. It's asleep (normal: it wakes up when needed)." };
};

export const FIELDS: Field[] = [
  {
    key: "name",
    label: "Her name",
    question: "What's her name?",
    example: "Mia",
    validate: text(40),
  },
  {
    key: "age",
    label: "Her age",
    question: "How old is she? She must be 18 or older.",
    example: "24",
    validate: async (input) => {
      const age = Number(input.trim());
      if (!Number.isInteger(age)) return { error: "Just the number, e.g. 24." };
      if (age < 18) return { error: "She must be 18 or older." };
      if (age > 70) return { error: "That seems off, try again." };
      return { value: String(age) };
    },
  },
  {
    key: "persona",
    label: "Persona",
    question:
      "Describe her in a few lines: where she's from, what she's into, how she texts, and what she won't talk about.\n\nNotes are fine. Here's an example you can copy and change:",
    example: EXAMPLE_PERSONA,
    validate: text(3500),
  },
  {
    key: "llm_endpoint_id",
    label: "Chat brain (RunPod endpoint ID)",
    question: "Paste the RunPod endpoint ID of her chat brain (the LLM endpoint).",
    example: "anupss918yyguy",
    validate: endpointId,
  },
  {
    key: "trigger_word",
    label: "Trigger word",
    question: "Her LoRA's trigger word, exactly as in your image prompts. Used for photos (step 5).",
    example: "zvx woman",
    optional: true,
    validate: text(60),
  },
  {
    key: "hair_eyes",
    label: "Hair & eyes",
    question: "Her hair and eyes, as you write them in prompts. Used for photos.",
    example: "long wavy dark brown hair, hazel eyes",
    optional: true,
    validate: text(120),
  },
  {
    key: "lora_url",
    label: "LoRA link",
    question: "The download link to her LoRA file (Dropbox, Google Drive or Hugging Face). The same link your image bot uses.",
    optional: true,
    validate: async (input) => {
      const value = input.trim();
      if (!/^https:\/\/\S+$/.test(value)) return { error: "That should be a link starting with https://" };
      return { value };
    },
  },
  {
    key: "sfw_endpoint_id",
    label: "SFW image endpoint",
    question: "RunPod endpoint ID of her SFW image generator (free teasers).",
    optional: true,
    validate: endpointId,
  },
  {
    key: "nsfw_endpoint_id",
    label: "NSFW image endpoint",
    question: "RunPod endpoint ID of her NSFW image generator (paid photos).",
    optional: true,
    validate: endpointId,
  },
];

const number = (min: number, max: number) => async (input: string) => {
  const n = Number(input.trim().replace(/[$%]/g, ""));
  if (!Number.isFinite(n) || n < min || n > max) return { error: `Send a number between ${min} and ${max}.` };
  return { value: String(Math.round(n)) };
};

/** Selling rules, changed in /sales. Not asked in /setup: the defaults work. */
export const SALES_FIELDS: (Field & { default: string; unit?: string })[] = [
  {
    key: "photo_price_min",
    label: "Paid photo: lowest price",
    question: "Lowest price (USD) for a new paid photo she takes for a fan.",
    example: "15",
    default: "15",
    unit: "$",
    validate: number(3, 500),
  },
  {
    key: "photo_price_max",
    label: "Paid photo: highest price",
    question: "Highest price (USD) for a new paid photo she takes for a fan.",
    example: "30",
    default: "30",
    unit: "$",
    validate: number(3, 500),
  },
  {
    key: "discount_floor",
    label: "Lowest discount",
    question: "When a fan haggles, how low can she go, as % of the price? 70 means a $10 photo never goes below $7. 100 means no discounts.",
    example: "70",
    default: "70",
    unit: "%",
    validate: number(30, 100),
  },
  {
    key: "teasers_per_day",
    label: "Free teasers per fan per day",
    question: "How many free (non-nude) photos she may give one fan per day, to hook him. 0 = never free.",
    example: "1",
    default: "1",
    validate: number(0, 5),
  },
  {
    key: "photos_per_day",
    label: "New photos per fan per day",
    question: "Max new photos she takes for one fan per day (free + paid). Each one costs GPU time.",
    example: "4",
    default: "4",
    validate: number(0, 20),
  },
  {
    key: "reply_speed",
    label: "Reply speed",
    question: "How fast she answers fans on Fanvue: natural (reads after 15–75 s, like a person) or fast (5–15 s).",
    example: "natural",
    default: "natural",
    validate: async (input) => {
      const v = input.trim().toLowerCase();
      return v === "natural" || v === "fast" ? { value: v } : { error: "Send natural or fast." };
    },
  },
];

export const fieldByKey = (key: string) => FIELDS.find((f) => f.key === key) ?? SALES_FIELDS.find((f) => f.key === key);
export const isSalesField = (key: string) => SALES_FIELDS.some((f) => f.key === key);

/** A sales setting as a number (or its default). */
export function salesNumber(settings: Record<string, string>, key: string): number {
  const field = SALES_FIELDS.find((f) => f.key === key)!;
  const n = Number(settings[key] ?? field.default);
  return Number.isFinite(n) ? n : Number(field.default);
}

/** [lowest, highest] price in cents for new paid photos. */
export function photoPriceRange(settings: Record<string, string>): [number, number] {
  const a = salesNumber(settings, "photo_price_min") * 100;
  const b = salesNumber(settings, "photo_price_max") * 100;
  return [Math.min(a, b), Math.max(a, b)];
}

/** What's still missing before she can chat. */
export function missingForChat(settings: Record<string, string>): Field[] {
  return FIELDS.filter((f) => !f.optional && !settings[f.key]);
}
