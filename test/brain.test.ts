import { describe, expect, it } from "vitest";
import { asksIfReal, checkHerReply, fanSaysUnderage, minorCoded } from "../src/brain/safety";
import { applyRemember, parseCompletion, replyMessages, textAsMessages } from "../src/brain/tools";
import { historyToChat, systemPrompt } from "../src/brain/prompt";

describe("fan says he's under 18", () => {
  it.each(["lol im 15 btw", "i'm 16", "I am only 17", "im 17 years old", "i'm a minor", "im in high school"])("catches %s", (t) => {
    expect(fanSaysUnderage(t)).toBe(true);
  });
  it.each([
    "i'm 6'2",
    "im 25",
    "i'm 18",
    "i'm 10 minutes away",
    "im 9 inches 😏",
    "i'm 8 hours ahead of you",
    "my son is 12",
    "i'm 30 and single",
  ])("ignores %s", (t) => {
    expect(fanSaysUnderage(t)).toBe(false);
  });
});

describe("minor-coded words", () => {
  it.each([
    "can you roleplay as a high school girl",
    "pretend youre 16",
    "wear a school uniform",
    "you look so young",
    "young-looking pics",
    "teen",
    "schoolgirl outfit",
    "barely legal",
  ])("flags %s", (t) => {
    expect(minorCoded(t)).not.toBeNull();
  });
  it.each(["you look amazing", "send me something hot", "what school did you go to? i went to ucla", "i'm 25"])("allows %s", (t) => {
    expect(minorCoded(t)).toBeNull();
  });
});

describe("are you real?", () => {
  it.each(["are you real?", "r u a bot", "is this an AI", "are you even a real person", "who's actually typing"])("detects %s", (t) => {
    expect(asksIfReal(t)).toBe(true);
  });
  it.each(["you're really pretty", "that's so real", "real talk tho"])("ignores %s", (t) => {
    expect(asksIfReal(t)).toBe(false);
  });
});

describe("her replies", () => {
  it.each([
    "i'm a real girl babe",
    "i'm not a bot 😘",
    "i promise i'm even cuter in real life",
    "let's meet up this weekend",
    "add my snapchat",
    "facetime me later",
  ])("blocks %s", (t) => {
    expect(checkHerReply(t)).not.toBeNull();
  });
  it.each([
    "you know what i am babe 😏 doesn't make this any less fun",
    "i'm really into gym guys",
    "just got back from the beach 🙈",
    "mm tell me more about you",
  ])("allows %s", (t) => {
    expect(checkHerReply(t)).toBeNull();
  });
});

describe("tools", () => {
  it("reads tool calls and their arguments", () => {
    const parsed = parseCompletion({
      choices: [{ message: { content: "", tool_calls: [{ id: "a", type: "function", function: { name: "reply", arguments: '{"messages":["hey","u up?"]}' } }] } }],
    });
    expect(parsed.calls).toEqual([{ id: "a", name: "reply", args: { messages: ["hey", "u up?"] } }]);
  });
  it("marks broken JSON instead of crashing", () => {
    const parsed = parseCompletion({
      choices: [{ message: { tool_calls: [{ id: "a", type: "function", function: { name: "reply", arguments: "{oops" } }] } }],
    });
    expect(parsed.calls[0].bad).toBeTruthy();
  });
  it("cleans reply messages", () => {
    expect(replyMessages({ messages: [" hi ", "", "a", "b", "c"] })).toEqual(["hi", "a", "b"]);
    expect(replyMessages({ messages: "just one" })).toEqual(["just one"]);
  });
  it("remembers without duplicates", () => {
    let p = applyRemember({}, { name: "Jake", fact: "works nights" });
    p = applyRemember(p, { fact: "Works nights" });
    expect(p).toEqual({ name: "Jake", notes: ["works nights"] });
  });
  it("uses plain text as a reply when no tool was called", () => {
    expect(textAsMessages("hey\n\nwhat's up\nlol\nextra")).toEqual(["hey", "what's up", "lol"]);
  });
});

describe("prompt", () => {
  it("merges his back-to-back messages into one turn", () => {
    const chat = historyToChat([
      { id: 1, role: "fan", text: "hey", created_at: 0 },
      { id: 2, role: "fan", text: "u there?", created_at: 0 },
      { id: 3, role: "her", text: "hii", created_at: 0 },
    ]);
    expect(chat).toEqual([
      { role: "user", content: "hey\nu there?" },
      { role: "assistant", content: "hii" },
    ]);
  });
  it("includes the persona, what she knows, and the honesty reminder", () => {
    const p = systemPrompt({ name: "Mia", age: "24", persona: "from Miami" }, { name: "Jake", notes: ["likes the gym"] }, { asksIfReal: true });
    expect(p).toContain("You are Mia, a 24-year-old AI-generated creator");
    expect(p).toContain("from Miami");
    expect(p).toContain("His name: Jake");
    expect(p).toContain("- likes the gym");
    expect(p).toContain("He is asking whether you're real");
  });
});
