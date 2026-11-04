import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { keyId } from "../core/model";
import { importTsLocales } from "../tssource/import";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { planExport } from "../workspace/export";
import { mergeBaseline, planFigmaExport } from "./export";
import { linkToKey } from "./link";
import { syncFromFigma } from "./sync";
import { parseTokens } from "./tokens";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");
const ENG = readFileSync(`${FIX}/ENG.tokens.json`, "utf8");
const TH = readFileSync(`${FIX}/TH.tokens.json`, "utf8");
const WARRANTY = keyId("figma-ALL", "ข้อมูลการรับประกัน");
const SAVE = keyId("button", "button_save");
const OUT = "/out";

async function setup() {
  const w = await openFixtureWorkspace();
  await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/ENG.tokens.json`, ENG);
  await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/TH.tokens.json`, TH);
  w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {} } });
  await syncFromFigma(w.session);
  const fileOf = (plan: Awaited<ReturnType<typeof planFigmaExport>>, name: string) =>
    plan.files.find((f) => f.path === `${OUT}/ALL/${name}`)?.text;
  return { ...w, fileOf };
}

const changedLines = (a: string, b: string) => {
  const x = a.split("\n");
  const y = b.split("\n");
  return x.flatMap((l, i) => (l === y[i] ? [] : [y[i]]));
};

describe("Figma export", () => {
  it("figma export with no edits writes byte-identical files", async () => {
    const w = await setup();
    const plan = await planFigmaExport(w.session, OUT);
    expect(plan.files.map((f) => f.path).sort()).toEqual([`${OUT}/ALL/ENG.tokens.json`, `${OUT}/ALL/TH.tokens.json`]);
    expect(w.fileOf(plan, "ENG.tokens.json")).toBe(ENG);
    expect(w.fileOf(plan, "TH.tokens.json")).toBe(TH);
    expect(plan.warnings).toEqual([]);
  });

  it("figma export after one edit changes only that $value", async () => {
    const w = await setup();
    w.session.setText(WARRANTY, "th", "ข้อมูลประกัน");
    const plan = await planFigmaExport(w.session, OUT);
    expect(w.fileOf(plan, "ENG.tokens.json")).toBe(ENG);
    expect(changedLines(TH, w.fileOf(plan, "TH.tokens.json")!)).toEqual(['    "$value": "ข้อมูลประกัน",']);
  });

  it("a linked row exports its code text to the Figma variable", async () => {
    const w = await setup();
    w.session.setText(SAVE, "th", "ข้อมูลการรับประกัน");
    w.session.setText(SAVE, "en", "Warranty details");
    linkToKey(w.session, WARRANTY, SAVE); // en differs: a conflict the caller would show; the code text stays
    const plan = await planFigmaExport(w.session, OUT);
    const eng = parseTokens(w.fileOf(plan, "ENG.tokens.json")!);
    expect(eng.ok && eng.vars.find((v) => v.id === "VariableID:3084:181892")?.value).toBe("Warranty details");
  });

  it("an untranslated cell keeps the file's value", async () => {
    const w = await setup();
    w.session.setText(WARRANTY, "en", null);
    const plan = await planFigmaExport(w.session, OUT);
    expect(w.fileOf(plan, "ENG.tokens.json")).toBe(ENG);
  });

  it("a new language becomes a new mode file and warns about base-text fallbacks", async () => {
    const w = await setup();
    w.session.addLanguage("ja");
    w.session.setText(WARRANTY, "ja", "保証情報");
    const plan = await planFigmaExport(w.session, OUT);
    const ja = w.fileOf(plan, "JA.tokens.json")!;
    const parsed = parseTokens(ja);
    expect(parsed.ok && parsed.mode).toBe("JA");
    const vals = parsed.ok ? Object.fromEntries(parsed.vars.map((v) => [v.name, v.value])) : {};
    expect(vals["ข้อมูลการรับประกัน"]).toBe("保証情報");
    expect(vals["เลือกไฮไลต์เซนเซอร์"]).toBe("เลือกไฮไลต์เซนเซอร์"); // base (th) text
    expect(plan.warnings).toEqual([expect.stringMatching(/^New mode JA: 2 strings use the th text: /)]);
  });

  it("non-string variables pass through", async () => {
    const w = await setup();
    const d = JSON.parse(ENG);
    d.Brand = {
      $type: "color", $value: "#ff0000",
      $extensions: { "com.figma.variableId": "V:color", "com.figma.scopes": ["ALL_SCOPES"], "com.figma.type": "color" },
    };
    const withColor = JSON.stringify(d, null, 2);
    await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/ENG.tokens.json`, withColor);
    await syncFromFigma(w.session);
    w.session.setText(WARRANTY, "en", "Warranty");
    const plan = await planFigmaExport(w.session, OUT);
    expect(changedLines(withColor, w.fileOf(plan, "ENG.tokens.json")!)).toEqual(['    "$value": "Warranty",']);
  });

  it("write-back never writes a Figma group", async () => {
    const w = await setup();
    await w.session.save();
    const src = await importTsLocales(w.fs, w.root, w.localesDir, "th");
    const plan = await planExport(w.session, { kind: "ts-writeback" }, src);
    expect(plan.blocked).toBeUndefined();
    expect(plan.files.some((f) => f.path.includes("figma"))).toBe(false);
  });

  it("i18next-json export includes unmapped Figma rows keyed by their Figma names", async () => {
    const w = await setup();
    const plan = await planExport(w.session, { kind: "i18next-json", dir: OUT, namespaces: "per-group" });
    const en = plan.files.find((f) => f.path === `${OUT}/en/figma-ALL.json`);
    expect(JSON.parse(en!.text)["ข้อมูลการรับประกัน"]).toBe("Warranty info");
  });
});

describe("review fixes", () => {
  it("a new mode file's base-text fallbacks don't come back as translations", async () => {
    const w = await setup();
    w.session.addLanguage("ja");
    const plan = await planFigmaExport(w.session, `${w.root}/design/figma`);
    for (const f of plan.files) await w.fs.writeTextAtomic(f.path, f.text);
    const f = w.session.workspace!.figma!;
    w.session.setWorkspaceMeta({
      figma: { ...f, modes: { ...f.modes, ...plan.figmaModes }, baseline: mergeBaseline(f.baseline, plan.figmaBaseline ?? {}) },
    });
    await syncFromFigma(w.session);
    expect(w.session.value(WARRANTY, "ja")).toBeUndefined();
  });

  it("an existing file for an unmapped mode is never overwritten", async () => {
    const w = await setup();
    w.session.addLanguage("ja");
    const ja = TH.replace('"com.figma.modeName": "TH"', '"com.figma.modeName": "JA"');
    await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/JA.tokens.json`, ja);
    const plan = await planFigmaExport(w.session, OUT);
    expect(w.fileOf(plan, "JA.tokens.json")).toBeUndefined();
    expect(plan.warnings).toEqual([expect.stringContaining("JA")]);
  });
});
