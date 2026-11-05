import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { keyId } from "../core/model";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import type { FigmaSource } from "../workspace/meta";
import { resolveFigmaConflict, syncFromFigma } from "./sync";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");
const ENG = readFileSync(`${FIX}/ENG.tokens.json`, "utf8");
const TH = readFileSync(`${FIX}/TH.tokens.json`, "utf8");
const V_SENSOR = "VariableID:3058:129318";
const V_WARRANTY = "VariableID:3084:181892";
const SENSOR = keyId("figma-ALL", "เลือกไฮไลต์เซนเซอร์");
const WARRANTY = keyId("figma-ALL", "ข้อมูลการรับประกัน");
const text = (t: string) => ({ kind: "text", text: t });

async function setup(figma: Partial<FigmaSource> = {}) {
  const w = await openFixtureWorkspace();
  const dir = `${w.root}/design/figma/ALL`;
  await w.fs.writeTextAtomic(`${dir}/ENG.tokens.json`, ENG);
  await w.fs.writeTextAtomic(`${dir}/TH.tokens.json`, TH);
  w.session.setWorkspaceMeta({
    figma: { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {}, ...figma },
  });
  /** Replaces `from` (must occur once) in a Figma file. */
  const edit = async (file: string, from: string, to: string) => {
    const t = await w.fs.readText(`${dir}/${file}`);
    expect(t.split(from).length - 1).toBe(1);
    await w.fs.writeTextAtomic(`${dir}/${file}`, t.replace(from, to));
  };
  return { ...w, dir, edit };
}

describe("syncFromFigma", () => {
  it("first sync adds one row per string variable in group figma-ALL with both languages", async () => {
    const w = await setup();
    const r = await syncFromFigma(w.session);
    expect(r.available).toBe(true);
    expect(r.added).toHaveLength(3);
    expect(r.conflicts).toEqual([]);
    expect(w.session.data.namespaces).toContain("figma-ALL");
    expect(w.session.value(SENSOR, "en")).toEqual(text("Select Highlight Sensors"));
    expect(w.session.value(SENSOR, "th")).toEqual(text("เลือกไฮไลต์เซนเซอร์"));
    const f = w.session.workspace!.figma!;
    expect(f.vars[V_SENSOR]).toEqual({ collection: "ALL", name: "เลือกไฮไลต์เซนเซอร์", row: SENSOR });
    expect(f.baseline[V_SENSOR]).toEqual({ en: "Select Highlight Sensors", th: "เลือกไฮไลต์เซนเซอร์" });
    // A second sync with nothing changed does nothing.
    const again = await syncFromFigma(w.session);
    expect([again.added, again.updated, again.conflicts, again.removed]).toEqual([[], [], [], []]);
  });

  it("a changed value with no local edit is taken", async () => {
    const w = await setup();
    await syncFromFigma(w.session);
    await w.edit("ENG.tokens.json", '"Warranty info"', '"Warranty information"');
    const r = await syncFromFigma(w.session);
    expect(r.updated).toEqual([WARRANTY]);
    expect(w.session.value(WARRANTY, "en")).toEqual(text("Warranty information"));
    expect(w.session.workspace!.figma!.baseline[V_WARRANTY].en).toBe("Warranty information");
  });

  it("a value changed in Figma and in Retrans becomes a conflict with base, and the next sync after resolving reports nothing", async () => {
    const w = await setup();
    await syncFromFigma(w.session);
    w.session.setText(WARRANTY, "en", "Guarantee");
    await w.edit("ENG.tokens.json", '"Warranty info"', '"Warranty details"');
    const r = await syncFromFigma(w.session);
    expect(r.conflicts).toEqual([
      { id: WARRANTY, locale: "en", mine: text("Guarantee"), theirs: text("Warranty details"), base: text("Warranty info"), varId: V_WARRANTY },
    ]);
    expect(w.session.value(WARRANTY, "en")).toEqual(text("Guarantee"));
    resolveFigmaConflict(w.session, r.conflicts[0], "theirs");
    expect(w.session.value(WARRANTY, "en")).toEqual(text("Warranty details"));
    const again = await syncFromFigma(w.session);
    expect(again.conflicts).toEqual([]);
  });

  it("resolving 'mine' keeps the Retrans value and settles the baseline", async () => {
    const w = await setup();
    await syncFromFigma(w.session);
    w.session.setText(WARRANTY, "en", "Guarantee");
    await w.edit("ENG.tokens.json", '"Warranty info"', '"Warranty details"');
    const r = await syncFromFigma(w.session);
    resolveFigmaConflict(w.session, r.conflicts[0], "mine");
    expect(w.session.value(WARRANTY, "en")).toEqual(text("Guarantee"));
    expect((await syncFromFigma(w.session)).conflicts).toEqual([]);
  });

  it("renamed in Figma: unmapped row is renamed, values kept", async () => {
    const w = await setup();
    await syncFromFigma(w.session);
    w.session.setText(WARRANTY, "th", "ข้อมูลประกัน (แก้)");
    for (const f of ["ENG.tokens.json", "TH.tokens.json"]) await w.edit(f, '"ข้อมูลการรับประกัน": {', '"การรับประกัน": {');
    const r = await syncFromFigma(w.session);
    const renamed = keyId("figma-ALL", "การรับประกัน");
    expect(r.renamed).toEqual([{ from: WARRANTY, to: renamed }]);
    expect(r.added).toEqual([]);
    expect(w.session.data.keyOrder).not.toContain(WARRANTY);
    expect(w.session.value(renamed, "th")).toEqual(text("ข้อมูลประกัน (แก้)"));
    expect(w.session.workspace!.figma!.vars[V_WARRANTY]).toEqual({ collection: "ALL", name: "การรับประกัน", row: renamed });
  });

  it("renamed in Figma: a row with a code key keeps its key", async () => {
    const w = await setup();
    await syncFromFigma(w.session);
    const coded = w.session.moveKey(WARRANTY, keyId("button", "warranty_info"));
    const f = w.session.workspace!.figma!;
    w.session.setWorkspaceMeta({ figma: { ...f, vars: { ...f.vars, [V_WARRANTY]: { ...f.vars[V_WARRANTY], row: coded } } } });
    for (const file of ["ENG.tokens.json", "TH.tokens.json"]) await w.edit(file, '"ข้อมูลการรับประกัน": {', '"การรับประกัน": {');
    await w.edit("ENG.tokens.json", '"Warranty info"', '"Warranty"');
    const r = await syncFromFigma(w.session);
    expect(r.renamed).toEqual([]);
    expect(w.session.value(coded, "en")).toEqual(text("Warranty"));
    expect(w.session.workspace!.figma!.vars[V_WARRANTY]).toEqual({ collection: "ALL", name: "การรับประกัน", row: coded });
  });

  it("deleted in Figma: unmapped row is marked removed in source", async () => {
    const w = await setup();
    await syncFromFigma(w.session);
    for (const file of ["ENG.tokens.json", "TH.tokens.json"]) {
      const d = JSON.parse(await w.fs.readText(`${w.dir}/${file}`));
      delete d["ข้อมูลการรับประกัน"];
      await w.fs.writeTextAtomic(`${w.dir}/${file}`, JSON.stringify(d, null, 2));
    }
    const r = await syncFromFigma(w.session);
    expect(r.removed).toEqual([WARRANTY]);
    expect(w.session.workspace!.removedInSource).toContain(WARRANTY);
    expect(w.session.data.keyOrder).toContain(WARRANTY);
    // Reported once.
    expect((await syncFromFigma(w.session)).removed).toEqual([]);
  });

  it("an unreadable mode file is skipped and its variables are not marked removed", async () => {
    const w = await setup();
    await syncFromFigma(w.session);
    await w.fs.writeTextAtomic(`${w.dir}/ENG.tokens.json`, "{ not json");
    const r = await syncFromFigma(w.session);
    expect(r.warnings).toEqual([expect.stringContaining("design/figma/ALL/ENG.tokens.json")]);
    expect(r.removed).toEqual([]);
    expect(w.session.workspace!.removedInSource).not.toContain(WARRANTY);
    expect(w.session.value(WARRANTY, "en")).toEqual(text("Warranty info"));
  });

  it("unmapped modes are reported, not guessed", async () => {
    const w = await setup({ modes: { TH: "th" } });
    const r = await syncFromFigma(w.session);
    expect(r.unmappedModes).toEqual(["ENG"]);
    expect(w.session.value(SENSOR, "th")).toEqual(text("เลือกไฮไลต์เซนเซอร์"));
    expect(w.session.value(SENSOR, "en")).toBeUndefined();
  });

  it("same leaf name in different groups gives two rows", async () => {
    const w = await setup();
    const v = (id: string, value: string) => ({
      $type: "string", $value: value,
      $extensions: { "com.figma.variableId": id, "com.figma.scopes": ["ALL_SCOPES"], "com.figma.type": "string" },
    });
    const file = (mode: string, a: string, b: string) =>
      JSON.stringify({ Button: { Save: v("V:1", a) }, Dialog: { Save: v("V:2", b) }, $extensions: { "com.figma.modeName": mode } }, null, 2);
    await w.fs.writeTextAtomic(`${w.root}/design/figma/UI/ENG.tokens.json`, file("ENG", "Save", "Save changes"));
    const r = await syncFromFigma(w.session);
    expect(r.added).toEqual(expect.arrayContaining([keyId("figma-UI", "Button.Save"), keyId("figma-UI", "Dialog.Save")]));
    expect(w.session.value(keyId("figma-UI", "Dialog.Save"), "en")).toEqual(text("Save changes"));
  });

  it("non-string variables never become rows", async () => {
    const w = await setup();
    const d = JSON.parse(ENG);
    d.Brand = {
      $type: "color", $value: "#ff0000",
      $extensions: { "com.figma.variableId": "V:color", "com.figma.scopes": ["ALL_SCOPES"], "com.figma.type": "color" },
    };
    await w.fs.writeTextAtomic(`${w.dir}/ENG.tokens.json`, JSON.stringify(d, null, 2));
    await syncFromFigma(w.session);
    expect(w.session.data.keyOrder).not.toContain(keyId("figma-ALL", "Brand"));
    expect(w.session.workspace!.figma!.vars["V:color"]).toBeUndefined();
  });

  it("no meta.figma or missing folder → available false and nothing changes", async () => {
    const w = await openFixtureWorkspace();
    const before = [...w.session.data.keyOrder];
    expect((await syncFromFigma(w.session)).available).toBe(false);
    w.session.setWorkspaceMeta({ figma: { dir: "design/nothing", modes: {}, vars: {}, baseline: {} } });
    expect((await syncFromFigma(w.session)).available).toBe(false);
    expect(w.session.data.keyOrder).toEqual(before);
  });
});

describe("review fixes", () => {
  it("a collection whose modes are all unmapped is not marked removed", async () => {
    const w = await setup();
    await syncFromFigma(w.session);
    w.session.setWorkspaceMeta({ figma: { ...w.session.workspace!.figma!, modes: {} } });
    const r = await syncFromFigma(w.session);
    expect(r.removed).toEqual([]);
    expect(w.session.workspace!.removedInSource).not.toContain(WARRANTY);
  });

  it("a rename that collides keeps the row, warns, and the sync still finishes", async () => {
    const w = await setup();
    await syncFromFigma(w.session);
    // Figma renames "ข้อมูลการรับประกัน" to the name another variable already has.
    for (const f of ["ENG.tokens.json", "TH.tokens.json"]) {
      const d = JSON.parse(await w.fs.readText(`${w.dir}/${f}`));
      const v = d["ข้อมูลการรับประกัน"];
      delete d["ข้อมูลการรับประกัน"];
      d["เลือกไฮไลต์เซนเซอร์"] = { ...d["เลือกไฮไลต์เซนเซอร์"] };
      d["เลือกไฮไลต์เซนเซอร์.x"] = v; // a prefix collision with the existing row
      await w.fs.writeTextAtomic(`${w.dir}/${f}`, JSON.stringify(d, null, 2));
    }
    const r = await syncFromFigma(w.session);
    expect(r.warnings).toEqual([expect.stringContaining("Couldn't rename")]);
    expect(w.session.data.keyOrder).toContain(WARRANTY);
  });

  it("a variable recreated in Figma under the same name takes over its row and drops the old id", async () => {
    const w = await setup();
    await syncFromFigma(w.session);
    for (const f of ["ENG.tokens.json", "TH.tokens.json"]) {
      const t = await w.fs.readText(`${w.dir}/${f}`);
      await w.fs.writeTextAtomic(`${w.dir}/${f}`, t.replace(V_WARRANTY, "VariableID:9999:1"));
    }
    const r = await syncFromFigma(w.session);
    expect(r.removed).toEqual([]);
    const vars = w.session.workspace!.figma!.vars;
    expect(vars[V_WARRANTY]).toBeUndefined();
    expect(vars["VariableID:9999:1"].row).toBe(WARRANTY);
    expect(w.session.workspace!.removedInSource).not.toContain(WARRANTY);
    expect(r.conflicts).toEqual([]);
  });
});
