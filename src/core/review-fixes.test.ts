/** Regression tests for the final whole-branch review findings (#1, #2, #4, #6, #9). */
import { describe, expect, it } from "vitest";
import { detectProject } from "../formats/detect";
import { MemoryFs } from "../platform/memory-fs";
import { keyId } from "./model";
import { buildRows, nextMissing, type RowFilter } from "./rows";
import { ProjectSession } from "./session";
import { parseState, STATE_PATH } from "./state-file";

const R = "/p";
const L = "public/locales";
async function open(files: Record<string, string>) {
  const fs = new MemoryFs(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${R}/${k}`, v])));
  const d = (await detectProject(fs, R))!;
  const s = await ProjectSession.open(fs, R, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
  return { fs, s };
}
const id = (k: string) => keyId("common", k);
const filter = (p: Partial<RowFilter> = {}): RowFilter => ({
  search: "", ns: "all", locales: ["th"], missing: false, needsReview: false, machine: false, status: "all", ...p,
});

describe("#1 empty strings on disk are untranslated", () => {
  const files = { [`${L}/en/common.json`]: '{"a":"A","b":"B"}\n', [`${L}/th/common.json`]: '{"a":"","b":"บี"}\n' };

  it("stats, Missing filter, nextMissing and cellMeta treat \"\" as untranslated", async () => {
    const { s } = await open(files);
    expect(s.stats().get("th")).toEqual({ done: 1, total: 2 });
    expect(buildRows(s, filter({ missing: true })).map((r) => r.id)).toEqual([id("a")]);
    expect(s.meta(id("a"), "th").status).toBe("untranslated");
    const rows = buildRows(s, filter());
    expect(nextMissing(s, rows, { id: id("b"), locale: "th" }, ["th"])).toEqual({ id: id("a"), locale: "th" });
    expect(buildRows(s, filter({ status: "untranslated" })).map((r) => r.id)).toEqual([id("a")]);
    expect(s.warnings(id("a"), "th")).toEqual([]);
  });

  it("open + save with no edits leaves the empty string on disk", async () => {
    const { fs, s } = await open(files);
    expect(s.isDirty()).toBe(false);
    const r = await s.save();
    expect(r.written).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  it("can't be marked reviewed; editing it writes the value; clearing removes the key", async () => {
    const { fs, s } = await open(files);
    s.markReviewed(id("a"), "th");
    expect(s.meta(id("a"), "th").status).toBe("untranslated");
    s.setText(id("a"), "th", "เอ");
    await s.save();
    expect(JSON.parse(await fs.readText(`${R}/${L}/th/common.json`))).toEqual({ a: "เอ", b: "บี" });
    s.setText(id("a"), "th", null);
    await s.save();
    expect(JSON.parse(await fs.readText(`${R}/${L}/th/common.json`))).toEqual({ b: "บี" });
  });
});

describe("#2 duplicate conflicts never resurrect an older disk value", () => {
  it("resolving an older conflict as theirs uses the current disk value", async () => {
    const { fs, s } = await open({ [`${L}/en/common.json`]: '{"a":"A"}\n', [`${L}/th/common.json`]: '{"a":"x"}\n' });
    const th = `${R}/${L}/th/common.json`;
    s.setText(id("a"), "th", "MINE");
    await fs.writeTextAtomic(th, '{"a":"T1"}\n');
    const c1 = await s.reloadFromDisk();
    await fs.writeTextAtomic(th, '{"a":"T2"}\n');
    const c2 = await s.reloadFromDisk();
    expect(c1).toHaveLength(1);
    expect(c2[0].theirs).toEqual({ kind: "text", text: "T2" });
    s.resolveConflict(c1[0], "theirs");
    expect(s.value(id("a"), "th")).toEqual({ kind: "text", text: "T2" });
    await s.save();
    expect(await fs.readText(th)).toBe('{"a":"T2"}\n');
  });

  it("refreshConflicts updates theirs and drops cells where mine now equals disk", async () => {
    const { fs, s } = await open({ [`${L}/en/common.json`]: '{"a":"A","b":"B"}\n', [`${L}/th/common.json`]: '{"a":"x","b":"y"}\n' });
    const th = `${R}/${L}/th/common.json`;
    s.setText(id("a"), "th", "MA");
    s.setText(id("b"), "th", "MB");
    await fs.writeTextAtomic(th, '{"a":"T1","b":"U1"}\n');
    const c1 = await s.reloadFromDisk();
    expect(c1).toHaveLength(2);
    await fs.writeTextAtomic(th, '{"a":"T2","b":"MB"}\n');
    const c2 = await s.reloadFromDisk();
    expect(c2.map((c) => c.id)).toEqual([id("a")]);
    expect(s.refreshConflicts([...c1, ...c2])).toEqual([
      { id: id("a"), locale: "th", mine: { kind: "text", text: "MA" }, theirs: { kind: "text", text: "T2" } },
    ]);
  });
});

describe("#4 malformed state.json", () => {
  const state = JSON.stringify({ version: 1, project: {}, entries: { [id("a")]: { th: { s: "reviewed", h: "x" } } } });
  const conflicted = "<<<<<<< HEAD\n" + state + "\n=======\n" + state + "\n>>>>>>> other\n";
  const files = {
    [`${L}/en/common.json`]: '{"a":"A","b":"B"}\n',
    [`${L}/th/common.json`]: '{"a":"เอ"}\n',
    [STATE_PATH]: conflicted,
  };

  it("parseState reports malformed input", () => {
    expect(parseState(conflicted).error).toBeTruthy();
    expect(parseState('{"version":2}').error).toBeTruthy();
    expect(parseState(null).error).toBeUndefined();
    expect(parseState(state).error).toBeUndefined();
  });

  it("is listed as a load error and never written while malformed", async () => {
    const { fs, s } = await open(files);
    expect(s.errors.map((e) => e.relPath)).toContain(STATE_PATH);
    s.setText(id("b"), "th", "บี");
    s.markReviewed(id("a"), "th");
    const r = await s.save();
    expect(r.written).toEqual([`${L}/th/common.json`]);
    expect(await fs.readText(`${R}/${STATE_PATH}`)).toBe(conflicted);
    expect(s.meta(id("a"), "th").status).toBe("reviewed"); // kept in memory
  });

  it("a reload with a malformed state keeps local statuses; once it parses, normal merging resumes", async () => {
    const good = JSON.stringify({ version: 1, project: {}, entries: { [id("a")]: { th: { s: "reviewed", h: "x" } } } });
    const { fs, s } = await open({ ...files, [STATE_PATH]: good });
    expect(s.meta(id("a"), "th").status).toBe("reviewed");
    await fs.writeTextAtomic(`${R}/${STATE_PATH}`, conflicted);
    await s.reloadFromDisk();
    expect(s.errors.map((e) => e.relPath)).toContain(STATE_PATH);
    expect(s.meta(id("a"), "th").status).toBe("reviewed");
    s.setText(id("b"), "th", "บี");
    await s.save();
    expect(await fs.readText(`${R}/${STATE_PATH}`)).toBe(conflicted);

    await fs.writeTextAtomic(`${R}/${STATE_PATH}`, good);
    await s.reloadFromDisk();
    expect(s.errors.map((e) => e.relPath)).not.toContain(STATE_PATH);
    const r = await s.save();
    expect(r.written).toEqual([STATE_PATH]);
    const entries = JSON.parse(await fs.readText(`${R}/${STATE_PATH}`)).entries;
    expect(entries[id("a")].th.s).toBe("reviewed");
    expect(entries[id("b")].th.s).toBe("translated");
  });
});

describe("#6 state.json project holds explicit overrides only", () => {
  const files = { [`${L}/en/common.json`]: '{"a":"A"}\n', [`${L}/th/common.json`]: '{"a":"เอ"}\n' };

  it("a status write does not persist detected values", async () => {
    const { fs, s } = await open(files);
    s.markReviewed(id("a"), "th");
    await s.save();
    expect(JSON.parse(await fs.readText(`${R}/${STATE_PATH}`)).project).toEqual({});
    expect(parseState(null).state.project).toEqual({});
  });

  it("pinBaseLocale writes only project.baseLocale, minimally", async () => {
    const existing = '{\n  "entries": {},\n  "project": {},\n  "version": 1\n}\n';
    const { fs, s } = await open({ ...files, [STATE_PATH]: existing });
    await s.pinBaseLocale("en");
    const text = await fs.readText(`${R}/${STATE_PATH}`);
    expect(JSON.parse(text)).toEqual({ entries: {}, project: { baseLocale: "en" }, version: 1 });
    expect(s.isDirty()).toBe(false);
    fs.writes.length = 0;
    expect((await s.save()).written).toEqual([]);
  });

  it("pinBaseLocale never writes a malformed state.json", async () => {
    const { fs, s } = await open({ ...files, [STATE_PATH]: "<<<<<<< x" });
    await s.pinBaseLocale("en");
    expect(await fs.readText(`${R}/${STATE_PATH}`)).toBe("<<<<<<< x");
  });
});

describe("#9 UTF-8 BOM", () => {
  const BOM = "﻿";

  it("next-i18next: BOM files load, save with no edits writes nothing, edits keep the BOM", async () => {
    const { fs, s } = await open({
      [`${L}/en/common.json`]: BOM + '{\n  "a": "A"\n}\n',
      [`${L}/th/common.json`]: BOM + '{\n  "a": "x"\n}\n',
    });
    expect(s.errors).toEqual([]);
    expect(s.value(id("a"), "th")).toEqual({ kind: "text", text: "x" });
    await s.save();
    expect(fs.writes).toEqual([]);
    s.setText(id("a"), "th", "y");
    await s.save();
    expect(await fs.readText(`${R}/${L}/th/common.json`)).toBe(BOM + '{\n  "a": "y"\n}\n');
  });

  it("paraglide: BOM message files and settings.json load and stay byte-identical", async () => {
    const settings = BOM + JSON.stringify({
      baseLocale: "en", locales: ["en", "de"],
      "plugin.inlang.messageFormat": { pathPattern: "./messages/{locale}.json" },
    }, null, 2) + "\n";
    const fs = new MemoryFs({
      [`${R}/project.inlang/settings.json`]: settings,
      [`${R}/messages/en.json`]: BOM + '{\n  "hi": "Hi"\n}\n',
      [`${R}/messages/de.json`]: BOM + '{\n  "hi": "Hallo"\n}\n',
    });
    const d = (await detectProject(fs, R))!;
    expect(d.baseLocale).toBe("en");
    const s = await ProjectSession.open(fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
    expect(s.errors).toEqual([]);
    expect(s.value(keyId("", "hi"), "de")).toEqual({ kind: "text", text: "Hallo" });
    s.setText(keyId("", "hi"), "de", "Servus");
    await s.save();
    expect(await fs.readText(`${R}/messages/de.json`)).toBe(BOM + '{\n  "hi": "Servus"\n}\n');
  });
});
