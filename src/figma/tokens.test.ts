import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { newModeFile, parseTokens, rewriteTokens, suggestLocale } from "./tokens";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");

const readFixture = (name: string) => readFileSync(resolve(FIX, name), "utf8");

describe("parseTokens", () => {
  it("parses the owner's ENG file", () => {
    const parsed = parseTokens(readFixture("ENG.tokens.json"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.mode).toBe("ENG");
    expect(parsed.vars).toHaveLength(3);
    expect(parsed.vars[0]).toEqual({
      id: "VariableID:3058:129318",
      path: ["เลือกไฮไลต์เซนเซอร์"],
      name: "เลือกไฮไลต์เซนเซอร์",
      type: "string",
      value: "Select Highlight Sensors",
    });
  });

  it("joins nested groups with dots and skips $ keys", () => {
    const parsed = parseTokens(JSON.stringify({
      Button: {
        Save: {
          $type: "string",
          $value: "Save",
          $extensions: { "com.figma.variableId": "v-1" },
        },
      },
      $extensions: { "com.figma.modeName": "ENG" },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.vars).toHaveLength(1);
    expect(parsed.vars[0].name).toBe("Button.Save");
    expect(parsed.vars[0].path).toEqual(["Button", "Save"]);
  });

  it("keeps non-string variables", () => {
    const parsed = parseTokens(JSON.stringify({
      Brand: {
        Primary: {
          $type: "color",
          $value: "#ffffff",
          $extensions: { "com.figma.variableId": "v-color" },
        },
      },
      $extensions: { "com.figma.modeName": "ENG" },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.vars[0]).toEqual(expect.objectContaining({
      id: "v-color",
      type: "color",
      value: "#ffffff",
    }));
  });

  it("rejects bad JSON without throwing", () => {
    expect(parseTokens("{")).toEqual(expect.objectContaining({ ok: false }));
  });
});

describe("rewriteTokens", () => {
  it("round-trips both fixture files byte-identical", () => {
    for (const name of ["ENG.tokens.json", "TH.tokens.json"]) {
      const text = readFixture(name);
      expect(rewriteTokens(text, new Map())).toBe(text);
      const parsed = parseTokens(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const current = new Map(
        parsed.vars
          .filter((v) => v.type === "string" && typeof v.value === "string")
          .map((v) => [v.id, v.value as string]),
      );
      expect(rewriteTokens(text, current)).toBe(text);
    }
  });

  it("one edit changes only that $value", () => {
    const text = readFixture("ENG.tokens.json");
    const out = rewriteTokens(text, new Map([["VariableID:3084:181892", "Warranty"]]));
    const before = text.split("\n");
    const after = out.split("\n");
    const changed = before.map((line, i) => ({ line, i })).filter(({ line, i }) => line !== after[i]);
    expect(changed).toHaveLength(1);
    expect(after[changed[0].i]).toContain("\"$value\": \"Warranty\"");
  });

  it("special characters round-trip in $value", () => {
    const id = "VariableID:3058:129318";
    const base = readFixture("ENG.tokens.json");
    const samples = ["He said \"hi\"\\n", "a\\b", "line1\nline2", "🎉", "ภาษาไทย"];
    for (const sample of samples) {
      const out = rewriteTokens(base, new Map([[id, sample]]));
      const parsed = parseTokens(out);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const v = parsed.vars.find((x) => x.id === id);
      expect(v?.value).toBe(sample);
      const before = base.split("\n");
      const after = out.split("\n");
      const changed = before.map((_, i) => i).filter((i) => before[i] !== after[i]);
      expect(changed).toHaveLength(1);
      expect(after[changed[0]]).toContain("\"$value\":");
    }
  });

  it("keeps a trailing newline when the file had one", () => {
    const withNewline = readFixture("ENG.tokens.json") + "\n";
    const out = rewriteTokens(withNewline, new Map([["VariableID:3084:181892", "Warranty"]]));
    expect(out.endsWith("\n")).toBe(true);
  });
});

describe("newModeFile", () => {
  it("copies structure, sets modeName and string values", () => {
    const template = readFixture("ENG.tokens.json");
    const out = newModeFile(template, "JA", new Map([["VariableID:3058:129318", "ハイライトを選択"]]));
    const parsed = parseTokens(out);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.mode).toBe("JA");
    expect(parsed.vars.find((v) => v.id === "VariableID:3058:129318")?.value).toBe("ハイライトを選択");
    expect(parsed.vars.find((v) => v.id === "VariableID:3084:181892")?.value).toBe("Warranty info");
  });
});

describe("suggestLocale", () => {
  it("suggests locales", () => {
    expect(suggestLocale("ENG")).toBe("en");
    expect(suggestLocale("th")).toBe("th");
    expect(suggestLocale("ไทย")).toBe("th");
    expect(suggestLocale("pt-BR")).toBe("pt-BR");
    expect(suggestLocale("Brand A")).toBeNull();
  });
});
