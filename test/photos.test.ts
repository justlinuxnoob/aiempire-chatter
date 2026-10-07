import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/photos/generate";
import { parseDescription } from "../src/catalog/catalog";

const settings = { trigger_word: "zvx woman", hair_eyes: "long wavy dark brown hair, hazel eyes" };
const scene =
  "sitting on a rooftop bar stool, legs crossed, holding a glass of rosé, emerald satin slip dress with thin straps, small gold hoops, downtown LA at golden hour, warm low sun, three-quarter shot";

describe("image prompts", () => {
  it("puts the exact trigger word and hair/eyes first and adds the smartphone look", () => {
    const r = buildPrompt(settings, scene);
    expect("prompt" in r && r.prompt).toBe(`zvx woman, long wavy dark brown hair, hazel eyes, ${scene}, candid smartphone photo, natural skin texture`);
  });
  it("doesn't duplicate the trigger word if she already wrote it", () => {
    const r = buildPrompt(settings, `zvx woman, long wavy dark brown hair, hazel eyes, ${scene}, candid smartphone photo, natural skin texture`);
    expect("prompt" in r && r.prompt.match(/zvx woman/g)?.length).toBe(1);
  });
  it.each(["school uniform", "teen", "young-looking", "petite girl", "pigtails and braces", "childlike face"])("blocks %s", (bad) => {
    const r = buildPrompt(settings, `${scene}, ${bad}`);
    expect("error" in r && r.blocked).toBeTruthy();
  });
  it("asks for more detail when the description is too short", () => {
    expect("error" in buildPrompt(settings, "selfie in bed")).toBe(true);
  });
});

describe("vision descriptions", () => {
  it("reads the JSON and clamps the price", () => {
    expect(parseDescription('{"description":"red lace set on the bed","level":"spicy","price":12}')).toEqual({
      description: "red lace set on the bed", level: "spicy", price_cents: 1200,
    });
    expect(parseDescription('Sure! {"description":"nude in the shower","level":"explicit","price":999}')?.price_cents).toBe(5000);
    expect(parseDescription("no json here")).toBeNull();
  });
});
