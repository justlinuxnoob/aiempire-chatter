// Encryption at rest for Fanvue tokens, plus PKCE and webhook-signature helpers.
//
// The encryption key is derived from FANVUE_CLIENT_SECRET, so members don't
// need an extra secret. If that secret is ever regenerated, stored tokens can't
// be read anymore and the bot asks to reconnect Fanvue (which is correct: the
// old secret is dead then anyway).

const enc = new TextEncoder();

async function tokenKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(env.FANVUE_CLIENT_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("aiempire-chatter"), info: enc.encode("fanvue-tokens-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(env), enc.encode(plain)));
  const out = new Uint8Array(iv.length + data.length);
  out.set(iv);
  out.set(data, iv.length);
  return "v1:" + toBase64(out);
}

export async function decrypt(env: Env, stored: string): Promise<string> {
  const bytes = fromBase64(stored.replace(/^v1:/, ""));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await tokenKey(env), bytes.slice(12));
  return new TextDecoder().decode(plain);
}

/** PKCE: a random verifier and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return { verifier, challenge: toBase64Url(hash) };
}

export function randomToken(bytes = 24): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hmacHex(key: string | Uint8Array, message: string): Promise<string> {
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
