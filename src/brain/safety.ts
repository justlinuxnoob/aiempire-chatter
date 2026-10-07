// Safety rules enforced in code. The model is uncensored and won't refuse
// anything by itself, so these checks are the real protection.

// A fan saying he is under 18 ("im 16", "i'm only 17 lol", "15 years old").
const FAN_UNDERAGE = [
  /\b(?:i'?m|i am|im)\s+(?:only\s+|just\s+)?(1[0-7]|[89])(?!\s*['’"]|\s*(?:cm|in|inch|inches|ft|feet|k|%|\$|am|pm|min|mins|minutes|hours?)\b)\b/i,
  /\b(?:i'?m|i am|im)\s+(?:only\s+|just\s+)?(?:a\s+)?(?:minor|underage|in (?:middle|high) school)\b/i,
  /\b(1[0-7]|[89])\s*(?:yo|y\/o|years?\s*old|yrs?\s*old)\b.*\b(?:me|i)\b|\b(?:i'?m|i am|im)\b.*\b(1[0-7]|[89])\s*(?:yo|y\/o|years?\s*old|yrs?\s*old)\b/i,
];

// Words that make sexual content minor-coded. Used on fan messages (flag +
// steer her away) and on her own replies (blocked). Also the image-prompt
// blocklist in step 5.
const MINOR_CODED = [
  /\bteen(?:age|ager)?s?\b/i,
  /\bunder\s*-?\s*age\b/i,
  /\bminors?\b/i,
  /\bschool\s*-?\s*girls?\b/i,
  /\bschool\s+uniforms?\b/i,
  /\b(?:high|middle|junior\s+high)\s+school(?:er)?s?\b/i,
  /\bloli\b/i,
  /\bjail\s*bait\b/i,
  /\byoung[\s-]*looking\b/i,
  /\blooks?\s+(?:so\s+|really\s+|very\s+)?young\b/i,
  /\b(?:little|petite|young)\s+girls?\b/i,
  /\bbarely\s+(?:legal|18)\b/i,
  /\b(1[0-7]|[1-9])\s*(?:yo|y\/o|years?\s*old|yrs?\s*old)\b/i,
  /\bpretend(?:ing)?\s+(?:to\s+be\s+|you'?re\s+|ur\s+)(1[0-7]|[1-9])\b/i,
  /\b(?:age\s*play|ageplay)\b/i,
];

// A sincere "are you real?" question.
const ASKS_IF_REAL = [
  /\b(?:are|r)\s*(?:you|u|ya)\s+(?:even\s+|actually\s+|really\s+)?(?:an?\s+)?(?:real|human|a?\s*bot|robot|ai|fake|a\s+real\s+(?:person|girl|woman))\b/i,
  /\bis\s+(?:this|it)\s+(?:even\s+|actually\s+|really\s+)?(?:an?\s+)?(?:real|bot|ai|human|automated)\b/i,
  /\b(?:who|someone)(?:'s| is)?\s+(?:else\s+)?(?:actually\s+)?typing\b/i,
  /\byou(?:'re| are)?\s+(?:just\s+)?(?:an?\s+)?(?:ai|bot|robot)\b/i,
];

// Her claiming to be a real person, or promising real-world contact.
const HER_DISHONEST = [
  /\b(?:i'?m|i am|im)\s+(?:a\s+)?(?:real|human)(?:\s+(?:person|girl|woman))?\b(?!\s+(?:fan|one|talk))/i,
  /\b(?:i'?m|i am|im)\s+not\s+(?:an?\s+)?(?:ai|bot|robot|fake|computer|program)\b/i,
  /\bnot\s+a\s+bot\b/i,
  /\bin\s+real\s+life\b|\birl\b/i,
  /\b(?:meet|meeting|hang\s+out)\s+(?:up|you|in\s+person|irl)\b/i,
  /\b(?:video\s*call|facetime|phone\s*call|call\s+me|my\s+number|my\s+address|snapchat|instagram|whatsapp)\b/i,
];

// Her stepping out of character: talking about being an AI, a bot, or "her creator".
const BREAKS_CHARACTER = [
  /\b(?:my|the|her)\s+(?:creator|creators|developer|programmer|team|operator)s?\b/i,
  /\b(?:i'?m|i am|im|as)\s+(?:just\s+)?(?:an?\s+)?(?:ai|a\.i\.|bot|chatbot|robot|language model|virtual|digital|computer|program)\b/i,
  /\b(?:artificial intelligence|language model|llm|chatgpt|openai|prompt|programmed|generated)\b/i,
];

export function fanSaysUnderage(text: string): boolean {
  return FAN_UNDERAGE.some((re) => re.test(text));
}

export function minorCoded(text: string): string | null {
  for (const re of MINOR_CODED) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

export function asksIfReal(text: string): boolean {
  return ASKS_IF_REAL.some((re) => re.test(text));
}

/** Why her draft can't be sent, or null if it's fine. */
export function checkHerReply(text: string): string | null {
  const minor = minorCoded(text);
  if (minor) return `mentions something minor-coded ("${minor}")`;
  for (const re of BREAKS_CHARACTER) {
    const m = text.match(re);
    if (m) return `breaks character ("${m[0]}")`;
  }
  for (const re of HER_DISHONEST) {
    const m = text.match(re);
    if (m) return `claims to be real or promises real-world contact ("${m[0]}")`;
  }
  return null;
}

// Used when a draft is blocked twice in a row. Short, neutral, in character.
export const SAFE_FALLBACKS = [
  "haha let's not go there 🙈 tell me something about you instead",
  "mm i'd rather talk about you 😏 what are you up to tonight?",
  "you know what i am babe 😏 doesn't make this any less fun",
];
