import { describe, expect, it } from "vitest";
import { nextReqId, translateText, type GenerateRequest, type MtEngine } from "./translate";

const model = { path: "/m/x.gguf", template: "translategemma" as const };
const fake = (out: string | Error) => {
  const calls: GenerateRequest[] = [];
  const engine: MtEngine = {
    generate: async (r) => {
      calls.push(r);
      if (out instanceof Error) throw out;
      return out;
    },
    cancel: async () => {},
  };
  return { engine, calls };
};

describe("translateText", () => {
  it("masks, prompts, cleans and restores", async () => {
    const { engine, calls } = fake("สวัสดี [[0]]<end_of_turn>");
    const r = await translateText(engine, model, "next-i18next", "en", "th", " Hello {{name}}", 7);
    expect(r).toEqual({ ok: true, text: " สวัสดี {{name}}" });
    expect(calls[0]).toMatchObject({ reqId: 7, modelPath: "/m/x.gguf", addBos: true, stop: ["<end_of_turn>"] });
    expect(calls[0].prompt).toContain("Hello [[0]]<end_of_turn>");
    expect(calls[0].maxTokens).toBe(64 + "Hello [[0]]".length * 4);
  });

  it("caps maxTokens at 1024", async () => {
    const { engine, calls } = fake("x");
    await translateText(engine, model, "paraglide", "en", "th", "a".repeat(2000));
    expect(calls[0].maxTokens).toBe(1024);
  });

  it("reports a lost placeholder as unsafe", async () => {
    expect(await translateText(fake("สวัสดี").engine, model, "next-i18next", "en", "th", "Hi {{name}}")).toEqual({
      ok: false,
      reason: "unsafe",
    });
  });

  it("maps engine errors", async () => {
    expect(await translateText(fake(new Error("cancelled")).engine, model, "paraglide", "en", "th", "Hi")).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(
      await translateText(fake(new Error("Text is too long to translate")).engine, model, "paraglide", "en", "th", "Hi"),
    ).toEqual({ ok: false, reason: "error", message: "Text is too long to translate" });
  });

  it("keeps quotes the source text is wrapped in", async () => {
    expect(await translateText(fake('"คำพูด"').engine, model, "paraglide", "en", "th", ' "Quoted"')).toEqual({ ok: true, text: ' "คำพูด"' });
    expect(await translateText(fake('"คำพูด"').engine, model, "paraglide", "en", "th", "Quoted")).toEqual({ ok: true, text: "คำพูด" });
  });

  it("nextReqId increments", () => {
    const a = nextReqId();
    expect(nextReqId()).toBe(a + 1);
  });
});
