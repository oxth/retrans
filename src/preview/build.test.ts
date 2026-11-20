import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hashValue } from "../core/hash";
import { keyId } from "../core/model";
import { syncFromFigma } from "../figma/sync";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { buildPreviewBundle } from "./build";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");
const ENG = readFileSync(`${FIX}/ENG.tokens.json`, "utf8");
const TH = readFileSync(`${FIX}/TH.tokens.json`, "utf8");
const V_WARRANTY = "VariableID:3084:181892";
const WARRANTY = keyId("figma-ALL", "ข้อมูลการรับประกัน");
const SENSOR = keyId("figma-ALL", "เลือกไฮไลต์เซนเซอร์");
const SAVE = keyId("button", "button_save");
const NOW = new Date("2026-11-20T10:00:00.000Z");

async function setup() {
  const w = await openFixtureWorkspace();
  const dir = `${w.root}/design/figma/ALL`;
  await w.fs.writeTextAtomic(`${dir}/ENG.tokens.json`, ENG);
  await w.fs.writeTextAtomic(`${dir}/TH.tokens.json`, TH);
  w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {} } });
  await syncFromFigma(w.session);
  w.session.setProjectSetting({ id: "proj-1" });
  return w;
}

const keys = (b: ReturnType<typeof buildPreviewBundle>) => b.bundle.strings.map((s) => s.key);

describe("buildPreviewBundle", () => {
  it("includes an unreviewed draft linked to a Figma variable", async () => {
    const { session } = await setup();
    session.setText(WARRANTY, "en", "Warranty information", { machine: true });
    const { bundle } = buildPreviewBundle(session, "en", { includeReviewed: false, now: NOW });
    expect(bundle).toMatchObject({ retransPreview: 1, sourceProjectId: "proj-1", exportedAt: NOW.toISOString(), baseLocale: "th", locale: "en" });
    expect(bundle.strings.find((s) => s.key === WARRANTY)).toEqual({
      key: WARRANTY,
      figmaVariableId: V_WARRANTY,
      base: "ข้อมูลการรับประกัน",
      text: "Warranty information",
      hash: hashValue({ kind: "text", text: "Warranty information" }),
      status: "translated",
      machine: true,
    });
  });

  it("leaves out reviewed cells unless asked", async () => {
    const { session } = await setup();
    session.markReviewed(WARRANTY, "en");
    expect(keys(buildPreviewBundle(session, "en", { includeReviewed: false }))).not.toContain(WARRANTY);
    const withReviewed = buildPreviewBundle(session, "en", { includeReviewed: true });
    expect(withReviewed.bundle.strings.find((s) => s.key === WARRANTY)?.status).toBe("reviewed");
  });

  it("counts rows with no Figma variable and complex values as left out", async () => {
    const { session } = await setup();
    session.setText(SAVE, "en", "Save");
    session.setComplex(SENSOR, "en", { one: "a", other: "b" });
    const built = buildPreviewBundle(session, "en", { includeReviewed: false });
    expect(keys(built)).not.toContain(SAVE);
    expect(keys(built)).not.toContain(SENSOR);
    expect(built.leftOut.noVariable).toBeGreaterThanOrEqual(1);
    expect(built.leftOut.complex).toBe(1);
  });

  it("never includes empty cells and keeps key order", async () => {
    const { session } = await setup();
    session.setText(WARRANTY, "en", null);
    const built = buildPreviewBundle(session, "en", { includeReviewed: true });
    expect(keys(built)).not.toContain(WARRANTY);
    const order = session.data.keyOrder.filter((id) => keys(built).includes(id));
    expect(keys(built)).toEqual(order);
  });

  it("returns no strings when nothing is left to preview", async () => {
    const { session } = await setup();
    for (const id of session.data.keyOrder) if (session.meta(id, "en").status === "translated") session.markReviewed(id, "en");
    expect(buildPreviewBundle(session, "en", { includeReviewed: false }).bundle.strings).toEqual([]);
  });

  it("refuses the base language and a project without an id", async () => {
    const { session } = await setup();
    expect(() => buildPreviewBundle(session, "th", { includeReviewed: false })).toThrow();
    delete session.state.project.id;
    expect(() => buildPreviewBundle(session, "en", { includeReviewed: false })).toThrow("Save your changes first.");
  });
});
