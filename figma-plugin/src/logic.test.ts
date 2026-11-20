import { describe, expect, it } from "vitest";
import type { PreviewBundle } from "../../src/preview/format";
import { type Box, copyPlacement, currentStep, frameToPreview, linkNote, markRestFits, nothingLinked, progress, resultsKey, isOverflow, matchesVariable, planCopies, type PluginState, type TextShape, toResults } from "./logic";

const box = (width: number, height: number, x = 0, y = 0): Box => ({ x, y, width, height });
const shape = (autoResize: TextShape["autoResize"], b: Box, needed: Box = b): TextShape => ({ box: b, autoResize, needed });

describe("matchesVariable", () => {
  it("matches the same id", () => {
    expect(matchesVariable("VariableID:3084:181892", "VariableID:3084:181892")).toBe(true);
  });
  it("matches a library variable whose id ends in the exported id", () => {
    expect(matchesVariable("VariableID:abc123/3084:181892", "VariableID:3084:181892")).toBe(true);
  });
  it("doesn't match a different id", () => {
    expect(matchesVariable("VariableID:3084:18189", "VariableID:3084:181892")).toBe(false);
    expect(matchesVariable("VariableID:abc/1:2", "VariableID:3084:181892")).toBe(false);
  });
});

describe("isOverflow", () => {
  const parent = box(200, 100);
  it("flags a fixed box whose text now needs more height", () => {
    expect(isOverflow(shape("NONE", box(100, 20)), shape("NONE", box(100, 20), box(100, 40)), parent)).toBe(true);
  });
  it("flags truncating text that now needs more room than before", () => {
    expect(isOverflow(shape("TRUNCATE", box(100, 20)), shape("TRUNCATE", box(100, 20), box(100, 60)), parent)).toBe(true);
  });
  it("doesn't flag a box that already overflowed by the same amount", () => {
    expect(isOverflow(shape("NONE", box(100, 20), box(100, 40)), shape("NONE", box(100, 20), box(100, 40)), parent)).toBe(false);
  });
  it("doesn't flag auto-height text that grows but stays inside its parent", () => {
    expect(isOverflow(shape("HEIGHT", box(100, 20)), shape("HEIGHT", box(100, 40)), parent)).toBe(false);
  });
  it("flags auto-height text that grows past its parent's bottom", () => {
    expect(isOverflow(shape("HEIGHT", box(100, 20, 0, 50)), shape("HEIGHT", box(100, 60, 0, 50)), parent)).toBe(true);
  });
  it("flags auto-width text that grows past its parent's right edge", () => {
    expect(isOverflow(shape("WIDTH_AND_HEIGHT", box(80, 20, 100, 0)), shape("WIDTH_AND_HEIGHT", box(140, 20, 100, 0)), parent)).toBe(true);
  });
  it("doesn't flag unchanged text", () => {
    expect(isOverflow(shape("NONE", box(100, 20)), shape("NONE", box(100, 20)), parent)).toBe(false);
  });
  it("without a parent, only the box itself counts", () => {
    expect(isOverflow(shape("HEIGHT", box(100, 20)), shape("HEIGHT", box(100, 400)), null)).toBe(false);
  });
});

describe("planCopies", () => {
  it("replaces an earlier copy of the same frame and language", () => {
    expect(planCopies(["A"], [{ copyId: "c1", sourceId: "A", locale: "th" }], "th")).toEqual({ remove: ["c1"], copy: ["A"] });
  });
  it("keeps copies for another language", () => {
    expect(planCopies(["A"], [{ copyId: "c1", sourceId: "A", locale: "ja" }], "th")).toEqual({ remove: [], copy: ["A"] });
  });
  it("copies a selected preview copy's source instead of the copy", () => {
    expect(planCopies(["c1"], [{ copyId: "c1", sourceId: "A", locale: "th" }], "th")).toEqual({ remove: ["c1"], copy: ["A"] });
  });
});

describe("toResults", () => {
  const bundle: PreviewBundle = {
    retransPreview: 1, sourceProjectId: "p1", exportedAt: "x", baseLocale: "en", locale: "th",
    strings: [
      { key: "a", base: "A", text: "ก", hash: "h1", status: "translated", machine: true },
      { key: "b", base: "B", text: "ข", hash: "h2", status: "translated", machine: true },
    ],
  };
  it("keeps rows with a verdict and copies hash and flag from the bundle", () => {
    const state: PluginState = {
      bundle, fileName: "f.json",
      rows: [
        { key: "a", text: "ก", flag: "overflow", found: true, verdict: "too-long", note: "cut" },
        { key: "b", text: "ข", flag: null, found: true, verdict: null },
      ],
    };
    expect(toResults(state, new Date("2026-11-20T11:00:00.000Z"))).toEqual({
      retransPreviewResults: 1, sourceProjectId: "p1", locale: "th", checkedAt: "2026-11-20T11:00:00.000Z",
      results: [{ key: "a", hash: "h1", verdict: "too-long", note: "cut", flag: "overflow" }],
    });
  });
});

describe("copyPlacement", () => {
  const abs = box(100, 50, 1000, 2000);
  it("places a top-level frame beside the original on the page", () => {
    expect(copyPlacement({ x: 10, y: 20, width: 100, abs, parentType: "PAGE" })).toEqual({ into: "parent", x: 190, y: 20 });
  });
  it("places a frame in a section beside the original inside the section", () => {
    expect(copyPlacement({ x: 10, y: 20, width: 100, abs, parentType: "SECTION" })).toEqual({ into: "parent", x: 190, y: 20 });
  });
  it("places a nested frame on the page, beside where it shows", () => {
    expect(copyPlacement({ x: 10, y: 20, width: 100, abs, parentType: "FRAME" })).toEqual({ into: "page", x: 1180, y: 2000 });
  });
});

describe("resultsKey", () => {
  const base: PluginState = {
    bundle: null, fileName: null,
    rows: [{ key: "a", text: "ก", flag: null, found: true, verdict: "fits" }],
  };
  it("stays the same for the same verdicts and notes", () => {
    expect(resultsKey(base)).toBe(resultsKey({ ...base, rows: base.rows.map((r) => ({ ...r })) }));
  });
  it("changes when a verdict or a note changes", () => {
    expect(resultsKey({ ...base, rows: [{ ...base.rows[0], verdict: "too-long" }] })).not.toBe(resultsKey(base));
    expect(resultsKey({ ...base, rows: [{ ...base.rows[0], note: "cut" }] })).not.toBe(resultsKey(base));
  });
});

describe("the guided steps", () => {
  const bundle = { retransPreview: 1, sourceProjectId: "p", exportedAt: "x", baseLocale: "en", locale: "de", strings: [] } as PreviewBundle;
  const row = (key: string, patch: Partial<PluginState["rows"][number]> = {}): PluginState["rows"][number] =>
    ({ key, text: key, flag: null, found: true, verdict: null, ...patch });

  const preview = (linked: number, textLayers = 8) => ({ frameName: "Card", textLayers, linked });

  it("starts at getting drafts, then selecting a frame, then checking", () => {
    expect(currentStep({ bundle: null, fileName: null, rows: [] })).toBe("drafts");
    expect(currentStep({ bundle, fileName: "f", rows: [row("a", { found: false })] })).toBe("select");
    expect(currentStep({ bundle, fileName: "f", rows: [row("a")], preview: preview(1) })).toBe("check");
  });

  it("counts what was found, flagged and checked", () => {
    const rows = [row("a", { flag: "overflow", verdict: "too-long" }), row("b"), row("c", { verdict: "fits" }), row("d", { found: false })];
    expect(progress(rows)).toEqual({ total: 4, found: 3, flagged: 1, checked: 2, missing: 1 });
  });

  it("marks the rest as fits: only found, unflagged strings without a verdict", () => {
    const rows = [row("a", { flag: "overflow" }), row("b"), row("c", { verdict: "too-long" }), row("d", { found: false })];
    expect(markRestFits(rows).map((r) => r.verdict)).toEqual([null, "fits", "too-long", null]);
  });

  it("notices when the previewed frame has nothing linked to the drafts", () => {
    expect(nothingLinked({ bundle, fileName: "f", rows: [row("a", { found: false })], preview: preview(0) })).toBe(true);
    expect(nothingLinked({ bundle, fileName: "f", rows: [row("a")], preview: preview(2) })).toBe(false);
    expect(nothingLinked({ bundle, fileName: "f", rows: [row("a", { found: false })] })).toBe(false);
  });

  it("describes a mismatch as information, and says nothing when every text layer is linked", () => {
    expect(linkNote(preview(0))).toBe("This frame's text isn't linked to these drafts: none of its 8 text layers use the variables you imported into Retrans.");
    expect(linkNote(preview(3))).toBe("3 of 8 text layers are linked.");
    expect(linkNote(preview(8))).toBeNull();
  });
});

describe("frameToPreview", () => {
  it("keeps the current preview for nothing selected or a layer inside a preview copy", () => {
    expect(frameToPreview([])).toBe("keep");
    expect(frameToPreview([{ id: "t", topFrameId: "copy", inPreview: true }])).toBe("keep");
  });
  it("previews the top-level frame of the first selected node", () => {
    expect(frameToPreview([{ id: "t1", topFrameId: "F", inPreview: false }, { id: "t2", topFrameId: "G", inPreview: false }])).toBe("F");
    expect(frameToPreview([{ id: "F", topFrameId: "F", inPreview: false }])).toBe("F");
  });
  it("keeps the current preview for a node that isn't in any frame", () => {
    expect(frameToPreview([{ id: "r", topFrameId: null, inPreview: false }])).toBe("keep");
  });
});
