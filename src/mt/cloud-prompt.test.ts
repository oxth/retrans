import { expect, it } from "vitest";
import { buildBatchPrompt, combineInstructions, parseBatchReply } from "./cloud-prompt";

it("buildBatchPrompt includes key, group, base, others and instructions", () => {
  const r = buildBatchPrompt({
    src: "en",
    targets: ["th", "ja"],
    instructions: "Use formal tone.",
    strings: [{
      id: "common::hello",
      key: "hello",
      group: "common",
      masked: "Hello [[0]]",
      base: "Hello {{name}}",
      others: { fr: "Bonjour {{name}}" },
    }],
  });
  expect(r.system).toContain("Retrans");
  expect(r.system).toContain("Keep every placeholder token like [[0]] exactly as written");
  expect(r.system).toContain("Use formal tone.");

  const payload = JSON.parse(r.user);
  expect(payload).toEqual({
    source: "en",
    targets: ["th", "ja"],
    strings: [{
      id: "common::hello",
      key: "hello",
      group: "common",
      text: "Hello [[0]]",
      base: "Hello {{name}}",
      others: { fr: "Bonjour {{name}}" },
    }],
  });
});

it("parseBatchReply tolerates fences and prose, reports missing ids", () => {
  const text = `Here you go:
\`\`\`json
{
  "common::hello": { "th": "สวัสดี [[0]]", "xx": "ignored" },
  "extra::id": { "th": "ignored" }
}
\`\`\`
Thanks!`;
  const r = parseBatchReply(text, ["common::hello", "common::bye"], ["th", "ja"]);
  expect(r.values.get("common::hello")?.get("th")).toBe("สวัสดี [[0]]");
  expect(r.values.get("common::hello")?.has("xx")).toBe(false);
  expect(r.values.has("extra::id")).toBe(false);
  expect(r.missing).toEqual([
    { id: "common::hello", locale: "ja" },
    { id: "common::bye", locale: "th" },
    { id: "common::bye", locale: "ja" },
  ]);
});

it("parseBatchReply on garbage returns everything missing", () => {
  const r = parseBatchReply("not json at all", ["a::one", "a::two"], ["th"]);
  expect(r.values.size).toBe(0);
  expect(r.missing).toEqual([
    { id: "a::one", locale: "th" },
    { id: "a::two", locale: "th" },
  ]);
});

it("combineInstructions orders global, project, language and skips blanks", () => {
  expect(combineInstructions(" Global ", "  ", "\nLocale\n")).toBe("Global\n\nLocale");
  expect(combineInstructions("all", "project", "locale")).toBe("all\n\nproject\n\nlocale");
  expect(combineInstructions(undefined, "", undefined)).toBe("");
});
