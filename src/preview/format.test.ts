import { describe, expect, it } from "vitest";
import { type PreviewBundle, type PreviewResults, parseBundle, parseResults, serializePreview } from "./format";

const bundle: PreviewBundle = {
  retransPreview: 1,
  sourceProjectId: "p1",
  exportedAt: "2026-11-20T10:00:00.000Z",
  baseLocale: "en",
  locale: "th",
  strings: [
    { key: "button::button_save", figmaVariableId: "VariableID:3084:181892", base: "Save", text: "บันทึก", hash: "abcd1234", status: "translated", machine: true },
    { key: "button::cancel", base: "Cancel", text: "ยกเลิก", hash: "0000ffff", status: "reviewed", machine: false },
  ],
};

const results: PreviewResults = {
  retransPreviewResults: 1,
  sourceProjectId: "p1",
  locale: "th",
  checkedAt: "2026-11-20T11:00:00.000Z",
  results: [
    { key: "button::button_save", hash: "abcd1234", verdict: "too-long", note: "wraps to 2 lines", flag: "overflow" },
    { key: "button::cancel", hash: "0000ffff", verdict: "fits", flag: null },
  ],
};

const withString = (patch: Record<string, unknown>) =>
  JSON.stringify({ ...bundle, strings: [{ ...bundle.strings[0], ...patch }] });

describe("parseBundle", () => {
  it("round-trips a bundle, with and without a Figma variable id", () => {
    const text = serializePreview(bundle);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseBundle(text)).toEqual({ ok: true, bundle });
  });

  it("accepts a leading BOM", () => {
    expect(parseBundle("﻿" + serializePreview(bundle)).ok).toBe(true);
  });

  it("rejects invalid JSON", () => {
    expect(parseBundle("{").ok).toBe(false);
  });

  it("rejects a newer format version with a clear message", () => {
    const r = parseBundle(JSON.stringify({ ...bundle, retransPreview: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer version of Retrans/);
  });

  it("rejects a string without a hash", () => {
    expect(parseBundle(withString({ hash: undefined })).ok).toBe(false);
  });

  it("rejects an untranslated status", () => {
    expect(parseBundle(withString({ status: "untranslated" })).ok).toBe(false);
  });
});

describe("parseResults", () => {
  it("round-trips results", () => {
    expect(parseResults(serializePreview(results))).toEqual({ ok: true, results, unreadable: 0 });
  });

  it("drops a result with an unknown verdict", () => {
    const text = JSON.stringify({ ...results, results: [{ ...results.results[0], verdict: "maybe" }, results.results[1]] });
    const r = parseResults(text);
    expect(r.ok && r.results.results.map((x) => x.key)).toEqual(["button::cancel"]);
  });

  it("counts the results it couldn't read", () => {
    const text = JSON.stringify({ ...results, results: [{ ...results.results[0], verdict: "maybe" }, 7, results.results[1]] });
    const r = parseResults(text);
    expect(r.ok && r.unreadable).toBe(2);
    expect(parseResults(serializePreview(results)).ok && (parseResults(serializePreview(results)) as { unreadable: number }).unreadable).toBe(0);
  });

  it("keeps a note only when it is a non-empty string", () => {
    const text = JSON.stringify({ ...results, results: [{ ...results.results[0], note: "" }, { ...results.results[1], note: 5 }] });
    const r = parseResults(text);
    expect(r.ok && r.results.results.every((x) => !("note" in x))).toBe(true);
  });

  it("turns an unknown flag into null", () => {
    const text = JSON.stringify({ ...results, results: [{ ...results.results[0], flag: "weird" }] });
    const r = parseResults(text);
    expect(r.ok && r.results.results[0].flag).toBeNull();
  });

  it("rejects a file that isn't a results file", () => {
    expect(parseResults(serializePreview(bundle)).ok).toBe(false);
  });
});
