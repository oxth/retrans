import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { keyId } from "../core/model";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { linkToKey, setCodeKey, suggestLinks } from "./link";
import { resolveFigmaConflict, syncFromFigma } from "./sync";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");
const ENG = readFileSync(`${FIX}/ENG.tokens.json`, "utf8");
const TH = readFileSync(`${FIX}/TH.tokens.json`, "utf8");
const V_WARRANTY = "VariableID:3084:181892";
const WARRANTY = keyId("figma-ALL", "ข้อมูลการรับประกัน");
const SENSOR = keyId("figma-ALL", "เลือกไฮไลต์เซนเซอร์");
const SAVE = keyId("button", "button_save");
const text = (t: string) => ({ kind: "text", text: t });

async function setup() {
  const w = await openFixtureWorkspace();
  const dir = `${w.root}/design/figma/ALL`;
  await w.fs.writeTextAtomic(`${dir}/ENG.tokens.json`, ENG);
  await w.fs.writeTextAtomic(`${dir}/TH.tokens.json`, TH);
  w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {} } });
  await syncFromFigma(w.session);
  return { ...w, dir };
}

describe("suggestLinks", () => {
  it("ranks the exact base-text match first and ignores Figma rows", async () => {
    const w = await setup();
    w.session.setText(SAVE, "th", "ข้อมูลการรับประกัน"); // same base (th) text as the Figma string
    const s = suggestLinks(w.session, WARRANTY);
    expect(s[0]).toBe(SAVE);
    expect(s.every((id) => !id.startsWith("figma-"))).toBe(true);
    expect(s.length).toBeLessThanOrEqual(5);
  });

  it("suggests nothing when no text is close", async () => {
    const w = await setup();
    expect(suggestLinks(w.session, SENSOR)).toEqual([]);
  });
});

describe("setCodeKey", () => {
  it("moves the row into a code group and keeps the link", async () => {
    const w = await setup();
    const to = setCodeKey(w.session, WARRANTY, keyId("button", "warranty_info"));
    expect(to).toBe(keyId("button", "warranty_info"));
    expect(w.session.data.keyOrder).not.toContain(WARRANTY);
    expect(w.session.value(to, "en")).toEqual(text("Warranty info"));
    expect(w.session.workspace!.figma!.vars[V_WARRANTY].row).toBe(to);
  });

  it("refuses a Figma group as the target", async () => {
    const w = await setup();
    expect(() => setCodeKey(w.session, WARRANTY, keyId("figma-ALL", "x"))).toThrow();
  });
});

describe("linkToKey", () => {
  it("link: differing languages become conflicts, equal ones merge", async () => {
    const w = await setup();
    w.session.setText(SAVE, "th", "ข้อมูลการรับประกัน"); // equal to Figma TH
    // SAVE en is "Save" in code, Figma EN is "Warranty info": differs.
    const conflicts = linkToKey(w.session, WARRANTY, SAVE);
    expect(conflicts).toEqual([
      { id: SAVE, locale: "en", mine: text("Save"), theirs: text("Warranty info"), base: text("Warranty info"), varId: V_WARRANTY },
    ]);
    expect(w.session.data.keyOrder).not.toContain(WARRANTY);
    expect(w.session.workspace!.figma!.vars[V_WARRANTY].row).toBe(SAVE);
    expect(w.session.value(SAVE, "en")).toEqual(text("Save")); // kept until the conflict is resolved
  });

  it("link: a language missing in code takes the Figma text", async () => {
    const w = await setup();
    w.session.setText(SAVE, "en", null);
    w.session.setText(SAVE, "th", "ข้อมูลการรับประกัน");
    expect(linkToKey(w.session, WARRANTY, SAVE)).toEqual([]);
    expect(w.session.value(SAVE, "en")).toEqual(text("Warranty info"));
  });

  it("after linking, the next Figma sync updates the linked row, not a new Figma row", async () => {
    const w = await setup();
    w.session.setText(SAVE, "th", "ข้อมูลการรับประกัน");
    w.session.setText(SAVE, "en", "Warranty info");
    expect(linkToKey(w.session, WARRANTY, SAVE)).toEqual([]);
    const t = await w.fs.readText(`${w.dir}/ENG.tokens.json`);
    await w.fs.writeTextAtomic(`${w.dir}/ENG.tokens.json`, t.replace('"Warranty info"', '"Warranty"'));
    const r = await syncFromFigma(w.session);
    expect(r.added).toEqual([]);
    expect(w.session.data.keyOrder).not.toContain(WARRANTY);
    expect(w.session.value(SAVE, "en")).toEqual(text("Warranty"));
  });
});

describe("review fixes", () => {
  it("link conflicts are reported again by the next sync until resolved, then settle", async () => {
    const w = await setup();
    w.session.setText(SAVE, "th", "ข้อมูลการรับประกัน");
    const [c] = linkToKey(w.session, WARRANTY, SAVE);
    expect(c).toMatchObject({ id: SAVE, locale: "en", varId: V_WARRANTY });
    const again = await syncFromFigma(w.session);
    expect(again.conflicts).toEqual([expect.objectContaining({ id: SAVE, locale: "en", varId: V_WARRANTY })]);
    resolveFigmaConflict(w.session, again.conflicts[0], "mine");
    expect((await syncFromFigma(w.session)).conflicts).toEqual([]);
  });

  it("resolving a link conflict before any sync still settles it", async () => {
    const w = await setup();
    w.session.setText(SAVE, "th", "ข้อมูลการรับประกัน");
    const [c] = linkToKey(w.session, WARRANTY, SAVE);
    resolveFigmaConflict(w.session, c, "mine");
    expect((await syncFromFigma(w.session)).conflicts).toEqual([]);
  });

  it("two Figma strings linked to one code key: each conflict settles its own variable", async () => {
    const w = await setup();
    w.session.setText(SAVE, "th", "ข้อมูลการรับประกัน");
    linkToKey(w.session, WARRANTY, SAVE);
    linkToKey(w.session, SENSOR, SAVE);
    let r = await syncFromFigma(w.session);
    for (let i = 0; i < 4 && r.conflicts.length; i++) {
      for (const c of r.conflicts) resolveFigmaConflict(w.session, c, "mine");
      r = await syncFromFigma(w.session);
    }
    expect(r.conflicts).toEqual([]);
  });
});
