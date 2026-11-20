import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hashValue } from "../core/hash";
import { keyId } from "../core/model";
import { syncFromFigma } from "../figma/sync";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import type { PreviewResult, PreviewResults } from "./format";
import { applyResults, diffResults } from "./results";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");
const WARRANTY = keyId("figma-ALL", "ข้อมูลการรับประกัน");
const SENSOR = keyId("figma-ALL", "เลือกไฮไลต์เซนเซอร์");

async function setup() {
  const w = await openFixtureWorkspace();
  const dir = `${w.root}/design/figma/ALL`;
  await w.fs.writeTextAtomic(`${dir}/ENG.tokens.json`, readFileSync(`${FIX}/ENG.tokens.json`, "utf8"));
  await w.fs.writeTextAtomic(`${dir}/TH.tokens.json`, readFileSync(`${FIX}/TH.tokens.json`, "utf8"));
  w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {} } });
  await syncFromFigma(w.session);
  w.session.setProjectSetting({ id: "proj-1" });
  return w.session;
}

const hashOf = (s: Awaited<ReturnType<typeof setup>>, id: string) => hashValue(s.value(id, "en"));
const file = (results: PreviewResult[], patch: Partial<PreviewResults> = {}): PreviewResults => ({
  retransPreviewResults: 1, sourceProjectId: "proj-1", locale: "en", checkedAt: "2026-11-20T11:00:00.000Z", results, ...patch,
});

describe("diffResults / applyResults", () => {
  it("applies a verdict whose text is unchanged", async () => {
    const s = await setup();
    const r = { key: WARRANTY, hash: hashOf(s, WARRANTY), verdict: "too-long" as const, note: "cut off", flag: "overflow" as const };
    const d = diffResults(s, file([r]));
    if (!d.ok) throw new Error(d.error);
    expect(d.diff).toMatchObject({ locale: "en", otherProject: false, changedSinceChecked: 0, missingKeys: 0, tooLong: 1, fits: 0 });
    expect(applyResults(s, d.diff)).toBe(1);
    expect(s.fitOf(WARRANTY, "en")).toEqual({ v: "too-long", h: r.hash, note: "cut off" });
  });

  it("skips a verdict for text that changed since it was checked", async () => {
    const s = await setup();
    const old = hashOf(s, WARRANTY);
    s.setText(WARRANTY, "en", "Warranty details");
    const d = diffResults(s, file([{ key: WARRANTY, hash: old, verdict: "fits", flag: null }]));
    if (!d.ok) throw new Error(d.error);
    expect(d.diff.changedSinceChecked).toBe(1);
    expect(d.diff.apply).toEqual([]);
    applyResults(s, d.diff);
    expect(s.fitOf(WARRANTY, "en")).toBeNull();
  });

  it("counts keys that no longer exist", async () => {
    const s = await setup();
    const d = diffResults(s, file([{ key: keyId("figma-ALL", "gone"), hash: "x", verdict: "fits", flag: null }]));
    expect(d.ok && d.diff.missingKeys).toBe(1);
  });

  it("refuses results for the base language or a language the project doesn't have", async () => {
    const s = await setup();
    const base = diffResults(s, file([], { locale: "th" }));
    expect(base.ok).toBe(false);
    const other = diffResults(s, file([], { locale: "fr" }));
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).toContain("fr");
  });

  it("warns about another project but still applies", async () => {
    const s = await setup();
    const d = diffResults(s, file([{ key: SENSOR, hash: hashOf(s, SENSOR), verdict: "fits", flag: null }], { sourceProjectId: "other" }));
    if (!d.ok) throw new Error(d.error);
    expect(d.diff.otherProject).toBe(true);
    expect(d.diff.fits).toBe(1);
    expect(applyResults(s, d.diff)).toBe(1);
  });
});
