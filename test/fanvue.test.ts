import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, pkce } from "../src/crypto";
import { validSignature } from "../src/fanvue/inbound";

const env = { FANVUE_CLIENT_SECRET: "client-secret-123" } as Env;

describe("token encryption", () => {
  it("round-trips and never stores the plain token", async () => {
    const stored = await encrypt(env, "access-token-xyz");
    expect(stored).not.toContain("access-token-xyz");
    expect(await decrypt(env, stored)).toBe("access-token-xyz");
  });
  it("can't be read with a different client secret", async () => {
    const stored = await encrypt(env, "access-token-xyz");
    await expect(decrypt({ FANVUE_CLIENT_SECRET: "other" } as Env, stored)).rejects.toThrow();
  });
});

describe("PKCE", () => {
  it("makes a 43–128 char verifier and a base64url challenge", async () => {
    const { verifier, challenge } = await pkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_" + "ab".repeat(32);
  const body = '{"type":"creator.message.received"}';
  const now = Math.floor(Date.now() / 1000);
  const sign = (key: string | Buffer, t: number) => createHmac("sha256", key).update(`${t}.${body}`).digest("hex");

  it("accepts the secret used as-is", async () => {
    expect(await validSignature(secret, body, `t=${now},v0=${sign(secret, now)}`)).toBe(true);
  });
  it("accepts the hex-key form", async () => {
    const key = Buffer.from("ab".repeat(32), "hex");
    expect(await validSignature(secret, body, `t=${now},v0=${sign(key, now)}`)).toBe(true);
  });
  it("rejects a wrong signature, a changed body, or an old timestamp", async () => {
    expect(await validSignature(secret, body, `t=${now},v0=${sign("other", now)}`)).toBe(false);
    expect(await validSignature(secret, body + " ", `t=${now},v0=${sign(secret, now)}`)).toBe(false);
    expect(await validSignature(secret, body, `t=${now - 600},v0=${sign(secret, now - 600)}`)).toBe(false);
    expect(await validSignature(secret, body, "")).toBe(false);
  });
});
