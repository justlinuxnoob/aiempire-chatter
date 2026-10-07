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

export const fieldByKey = (key: string) => FIELDS.find((f) => f.key === key);

/** What's still missing before she can chat. */
export function missingForChat(settings: Record<string, string>): Field[] {
  return FIELDS.filter((f) => !f.optional && !settings[f.key]);
}
