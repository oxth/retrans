import { buildPrompt, cleanOutput, languageName } from "./prompt";
import { expect, it } from "vitest";

it("builds the exact TranslateGemma prompt", () => {
  expect(buildPrompt("translategemma", "en", "th", "Hello [[0]]")).toEqual({
    prompt:
      "<start_of_turn>user\nYou are a professional English (en) to Thai (th) translator. Your goal is to accurately convey the meaning and nuances of the original English text while adhering to Thai grammar, vocabulary, and cultural sensitivities.\nProduce only the Thai translation, without any additional explanations or commentary. Please translate the following English text into Thai:\n\n\nHello [[0]]<end_of_turn>\n<start_of_turn>model\n",
    addBos: true,
    stop: ["<end_of_turn>"],
  });
});
it("builds the Qwen3 prompt with thinking disabled", () => {
  const r = buildPrompt("qwen3", "th", "en_US", "สวัสดี");
  expect(r.addBos).toBe(false);
  expect(r.stop).toEqual(["<|im_end|>"]);
  expect(r.prompt).toContain("from Thai (th) to American English (en-US)");
  expect(r.prompt.endsWith("<|im_start|>assistant\n<think>\n\n</think>\n\n")).toBe(true);
});
it("qwen prompt carries instructions, translategemma ignores them", () => {
  const qwen = buildPrompt("qwen3", "en", "th", "Hello [[0]]", "Keep product names in English.");
  expect(qwen.prompt).toContain("Follow these additional instructions:\nKeep product names in English.");

  const gemma = buildPrompt("translategemma", "en", "th", "Hello [[0]]", "Do not use slang.");
  expect(gemma.prompt).not.toContain("Do not use slang.");
});
it("names odd locales without throwing", () => {
  expect(languageName("th")).toBe("Thai");
  expect(languageName("pt-BR")).toBe("Brazilian Portuguese");
  expect(languageName("not a locale!")).toBe("not a locale!");
});
it("cleans model output", () => {
  expect(cleanOutput("สวัสดี<end_of_turn>junk")).toBe("สวัสดี");
  expect(cleanOutput("<think>\nhmm\n</think>\n\n“Hello”<|im_end|>")).toBe("Hello");
  expect(cleanOutput('  "He said \\"hi\\""  ')).toBe('He said \\"hi\\"');
});
it("keeps wrapping quotes when the source is wrapped in the same pair", () => {
  expect(cleanOutput('"Zitiert"', '"Quoted"')).toBe('"Zitiert"');
  expect(cleanOutput("“Zitiert”", "“Quoted”")).toBe("“Zitiert”");
  expect(cleanOutput('"Zitiert"', "Quoted")).toBe("Zitiert");
  expect(cleanOutput('"Zitiert"', "“Quoted”")).toBe("Zitiert");
});
