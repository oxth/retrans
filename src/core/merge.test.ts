import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadFixtureDir, type MemoryFs } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { type CellMap, keyId, type MessageValue } from "./model";
import { mergeCells } from "./merge";
import { STATE_PATH } from "./state-file";
import { ProjectSession } from "./session";

const t = (text: string): MessageValue => ({ kind: "text", text });
function cells(rows: Record<string, Record<string, string>>): CellMap {
  const m: CellMap = new Map();
  for (const [id, locs] of Object.entries(rows)) {
    m.set(id, new Map(Object.entries(locs).map(([l, v]) => [l, t(v)])));
  }
  return m;
}
const plain = (m: CellMap) =>
  Object.fromEntries([...m].map(([id, c]) => [id, Object.fromEntries([...c].map(([l, v]) => [l, (v as { text: string }).text]))]));

describe("mergeCells", () => {
  const base = cells({ a: { en: "A", th: "ก" }, b: { en: "B" } });

  it("only theirs changed -> theirs is taken", () => {
    const r = mergeCells(base, cells({ a: { en: "A", th: "ก" }, b: { en: "B" } }), cells({ a: { en: "A2", th: "ก" }, b: { en: "B" } }));
    expect(plain(r.merged)).toEqual({ a: { en: "A2", th: "ก" }, b: { en: "B" } });
    expect(r.conflicts).toEqual([]);
  });

  it("only mine changed -> mine is kept", () => {
    const r = mergeCells(base, cells({ a: { en: "A", th: "ข" }, b: { en: "B" } }), cells({ a: { en: "A", th: "ก" }, b: { en: "B" } }));
    expect(plain(r.merged)).toEqual({ a: { en: "A", th: "ข" }, b: { en: "B" } });
    expect(r.conflicts).toEqual([]);
  });

  it("both changed to the same value -> no conflict", () => {
    const r = mergeCells(base, cells({ a: { en: "X", th: "ก" }, b: { en: "B" } }), cells({ a: { en: "X", th: "ก" }, b: { en: "B" } }));
    expect(plain(r.merged).a.en).toBe("X");
    expect(r.conflicts).toEqual([]);
  });

  it("both changed differently -> conflict, mine kept in merged", () => {
    const r = mergeCells(base, cells({ a: { en: "Mine", th: "ก" }, b: { en: "B" } }), cells({ a: { en: "Theirs", th: "ก" }, b: { en: "B" } }));
    expect(r.conflicts).toEqual([{ id: "a", locale: "en", mine: t("Mine"), theirs: t("Theirs") }]);
    expect(plain(r.merged).a.en).toBe("Mine");
  });

  it("theirs deleted while mine unchanged -> deleted", () => {
    const r = mergeCells(base, cells({ a: { en: "A", th: "ก" }, b: { en: "B" } }), cells({ a: { en: "A" } }));
    expect(plain(r.merged)).toEqual({ a: { en: "A" } });
    expect(r.conflicts).toEqual([]);
  });

  it("mine deleted while theirs edited -> conflict with mine undefined", () => {
    const r = mergeCells(base, cells({ a: { en: "A" }, b: { en: "B" } }), cells({ a: { en: "A", th: "ค" }, b: { en: "B" } }));
    expect(r.conflicts).toEqual([{ id: "a", locale: "th", mine: undefined, theirs: t("ค") }]);
    expect(plain(r.merged).a).toEqual({ en: "A" });
  });
});

// ---- session reload ------------------------------------------------------------------------

const R = "/project";
const NEXT = "public/locales";
const c = (k: string) => keyId("common", k);

async function openFx(name: string) {
  const fs = loadFixtureDir(resolve(__dirname, "../test/fixtures", name));
  const d = (await detectProject(fs, R))!;
  const s = await ProjectSession.open(fs, R, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
  return { fs, s };
}

const TH = (o: Record<string, unknown>) => JSON.stringify(o, null, 2) + "\n";

describe("ProjectSession.reloadFromDisk", () => {
  it("applies a git-pull-style change silently when there are no local edits", async () => {
    const { fs, s } = await openFx("next-nested");
    await fs.writeTextAtomic(`${R}/${NEXT}/th/common.json`, TH({ title: "สวัสดี", nav: { home: "หน้าหลัก", about: "เกี่ยวกับ" }, orphan: "เศษ" }));
    await fs.writeTextAtomic(`${R}/${NEXT}/en/common.json`, TH({ title: "Hello", nav: { home: "Home", about: "About" }, extra: "Extra" }));
    let emits = 0;
    s.subscribe(() => emits++);
    const conflicts = await s.reloadFromDisk();
    expect(conflicts).toEqual([]);
    expect(emits).toBe(1);
    expect(s.value(c("nav.home"), "th")).toEqual({ kind: "text", text: "หน้าหลัก" });
    expect(s.value(c("nav.about"), "th")).toEqual({ kind: "text", text: "เกี่ยวกับ" });
    expect(s.data.keyOrder).toContain(c("extra"));
    expect(s.data.keyOrder).not.toContain(c("only_en"));
    expect(s.isDirty()).toBe(false);
    fs.writes.length = 0;
    expect(await s.save()).toEqual({ written: [], deleted: [], stale: [] });
    expect(fs.writes).toEqual([]);
  });

  it("returns a conflict when the same cell was edited both locally and on disk", async () => {
    const { fs, s } = await openFx("next-nested");
    s.setText(c("title"), "th", "ของฉัน");
    await fs.writeTextAtomic(`${R}/${NEXT}/th/common.json`, TH({ title: "ของเขา", nav: { home: "หน้าแรก" }, orphan: "เศษ" }));
    const conflicts = await s.reloadFromDisk();
    expect(conflicts).toEqual([
      { id: c("title"), locale: "th", mine: { kind: "text", text: "ของฉัน" }, theirs: { kind: "text", text: "ของเขา" } },
    ]);
    expect(s.value(c("title"), "th")).toEqual({ kind: "text", text: "ของฉัน" });
    expect(s.conflicts).toEqual(conflicts);
    s.resolveConflict(conflicts[0], "theirs");
    expect(s.value(c("title"), "th")).toEqual({ kind: "text", text: "ของเขา" });
    expect(s.conflicts).toEqual([]);
    expect(s.isDirty()).toBe(false);
  });

  it("resolveConflict mine keeps the local value and it stays dirty", async () => {
    const { fs, s } = await openFx("next-nested");
    s.setText(c("title"), "th", "ของฉัน");
    await fs.writeTextAtomic(`${R}/${NEXT}/th/common.json`, TH({ title: "ของเขา", nav: { home: "หน้าแรก" }, orphan: "เศษ" }));
    const [cf] = await s.reloadFromDisk();
    s.resolveConflict(cf, "mine");
    expect(s.conflicts).toEqual([]);
    expect(s.value(c("title"), "th")).toEqual({ kind: "text", text: "ของฉัน" });
    await s.save();
    expect(JSON.parse(await fs.readText(`${R}/${NEXT}/th/common.json`)).title).toBe("ของฉัน");
  });

  it("save detects stale snapshot and merges", async () => {
    const { fs, s } = await openFx("next-nested");
    s.setText(c("title"), "th", "ของฉัน");
    // someone else changes another cell of the same file before the watcher fires
    const theirs = TH({ title: "สวัสดี", nav: { home: "หน้าแรกของเขา" }, orphan: "เศษ" });
    await fs.writeTextAtomic(`${R}/${NEXT}/th/common.json`, theirs);
    const r1 = await s.save();
    expect(r1.stale).toEqual([`${NEXT}/th/common.json`]);
    expect(await fs.readText(`${R}/${NEXT}/th/common.json`)).toBe(theirs);
    expect(await s.reloadFromDisk()).toEqual([]);
    const r2 = await s.save();
    expect(r2.stale).toEqual([]);
    expect(r2.written).toContain(`${NEXT}/th/common.json`);
    expect(JSON.parse(await fs.readText(`${R}/${NEXT}/th/common.json`))).toEqual({
      title: "ของฉัน",
      nav: { home: "หน้าแรกของเขา" },
      orphan: "เศษ",
    });
    expect(s.isDirty()).toBe(false);
  });

  it("keeps local key adds and pending language/namespace creates across a reload", async () => {
    const { fs, s } = await openFx("next-nested");
    const id = s.addKey("common", "fresh", "Fresh");
    s.addLanguage("fr");
    s.addNamespace("auth");
    await s.reloadFromDisk();
    expect(s.data.keyOrder).toContain(id);
    expect(s.value(id, "en")).toEqual({ kind: "text", text: "Fresh" });
    expect(s.data.locales).toEqual(["en", "fr", "th"]);
    expect(s.data.namespaces).toEqual(["auth", "checkout", "common"]);
    const r = await s.save();
    expect(r.written).toEqual(expect.arrayContaining([`${NEXT}/fr/common.json`, `${NEXT}/en/auth.json`, `${NEXT}/fr/auth.json`]));
    expect(JSON.parse(await fs.readText(`${R}/${NEXT}/en/common.json`)).fresh).toBe("Fresh");
  });

  it("a pending-create file that now exists on disk is adopted; local edits stay dirty", async () => {
    const { fs, s } = await openFx("next-nested");
    s.addLanguage("fr");
    s.setText(c("title"), "fr", "Bonjour");
    await fs.writeTextAtomic(`${R}/${NEXT}/fr/common.json`, TH({ nav: { home: "Accueil" } }));
    expect((await s.save()).stale).toEqual([`${NEXT}/fr/common.json`]);
    expect(await s.reloadFromDisk()).toEqual([]);
    expect(s.value(c("nav.home"), "fr")).toEqual({ kind: "text", text: "Accueil" });
    expect(s.dirtyCells()).toEqual([{ id: c("title"), locale: "fr" }]);
    const r = await s.save();
    expect(r.stale).toEqual([]);
    expect(JSON.parse(await fs.readText(`${R}/${NEXT}/fr/common.json`))).toEqual({ nav: { home: "Accueil" }, title: "Bonjour" });
  });

  it("pending removeLanguage survives a reload", async () => {
    const { fs, s } = await openFx("next-nested");
    s.removeLanguage("th");
    await s.reloadFromDisk();
    expect(s.data.locales).toEqual(["en"]);
    expect(s.value(c("title"), "th")).toBeUndefined();
    const r = await s.save();
    expect(r.deleted).toEqual([`${NEXT}/th/common.json`]);
    expect(await fs.exists(`${R}/${NEXT}/th/common.json`)).toBe(false);
  });

  it("a file that became malformed on disk keeps its values, is listed, read-only, never written", async () => {
    const { fs, s } = await openFx("next-nested");
    await fs.writeTextAtomic(`${R}/${NEXT}/th/common.json`, "{ broken");
    expect(await s.reloadFromDisk()).toEqual([]);
    expect(s.errors.map((e) => e.relPath)).toEqual([`${NEXT}/th/common.json`]);
    expect(s.value(c("title"), "th")).toEqual({ kind: "text", text: "สวัสดี" });
    expect(() => s.setText(c("title"), "th", "x")).toThrow(/read-only/);
    fs.writes.length = 0;
    await s.save();
    expect(fs.writes).toEqual([]);
    expect(await fs.readText(`${R}/${NEXT}/th/common.json`)).toBe("{ broken");
  });

  it("save reports state.json stale when it changed on disk; reload then save keeps both statuses", async () => {
    const { fs, s } = await openFx("next-nested");
    const h = (await import("./hash")).hashText;
    s.markReviewed(c("nav.home"), "th");
    await fs.writeTextAtomic(`${R}/${STATE_PATH}`, JSON.stringify({
      version: 1,
      project: { baseLocale: "en", localesPath: NEXT },
      entries: { [c("title")]: { th: { s: "reviewed", h: h("Hello") } } },
    }));
    const pulled = await fs.readText(`${R}/${STATE_PATH}`);
    const r1 = await s.save();
    expect(r1.stale).toEqual([STATE_PATH]);
    expect(await fs.readText(`${R}/${STATE_PATH}`)).toBe(pulled);
    expect(s.isDirty()).toBe(true);
    await s.reloadFromDisk();
    const r2 = await s.save();
    expect(r2.stale).toEqual([]);
    expect(r2.written).toEqual([STATE_PATH]);
    const entries = JSON.parse(await fs.readText(`${R}/${STATE_PATH}`)).entries;
    expect(entries[c("title")].th.s).toBe("reviewed");
    expect(entries[c("nav.home")].th.s).toBe("reviewed");
    fs.writes.length = 0;
    expect((await s.save()).written).toEqual([]);
  });

  it("state.json changes on disk apply to cells not touched locally", async () => {
    const { fs, s } = await openFx("next-nested");
    s.markReviewed(c("nav.home"), "th"); // local touch
    const h = (await import("./hash")).hashText;
    await fs.writeTextAtomic(`${R}/${STATE_PATH}`, JSON.stringify({
      version: 1,
      project: { baseLocale: "en", localesPath: NEXT },
      entries: {
        [c("title")]: { th: { s: "reviewed", h: h("Hello") } },
        [c("nav.home")]: { th: { s: "translated", h: h("Home"), m: true } },
      },
    }));
    await s.reloadFromDisk();
    expect(s.meta(c("title"), "th").status).toBe("reviewed");
    expect(s.meta(c("nav.home"), "th")).toMatchObject({ status: "reviewed", machine: false });
  });
});

describe("Source changed (needsReview) for translations never touched in Retrans", () => {
  const EN = `${R}/${NEXT}/en/common.json`;
  const THF = `${R}/${NEXT}/th/common.json`;
  const editJson = async (fs: MemoryFs, path: string, patch: Record<string, unknown>) =>
    fs.writeTextAtomic(path, TH({ ...JSON.parse(await fs.readText(path)), ...patch }));

  it("a base change from disk (editor, git pull) flags the unchanged translation", async () => {
    const { fs, s } = await openFx("next-nested");
    expect(s.meta(c("title"), "th")).toMatchObject({ status: "translated", needsReview: false });
    await editJson(fs, EN, { title: "Hello there" });
    await s.reloadFromDisk();
    expect(s.meta(c("title"), "th").needsReview).toBe(true);
    // Reviewing clears it, as for a base edit made in Retrans.
    s.markReviewed(c("title"), "th");
    expect(s.meta(c("title"), "th")).toMatchObject({ status: "reviewed", needsReview: false });
  });

  it("a translation updated in the same change is not flagged", async () => {
    const { fs, s } = await openFx("next-nested");
    await editJson(fs, EN, { title: "Hello there" });
    await editJson(fs, THF, { title: "สวัสดีทุกคน" });
    await s.reloadFromDisk();
    expect(s.meta(c("title"), "th").needsReview).toBe(false);
  });

  it("fingerprints recorded on open catch a base change made while Retrans was closed", async () => {
    const first = await openFx("next-nested");
    expect(first.s.recordBaseFingerprints()).toBe(true);
    expect(first.s.recordBaseFingerprints()).toBe(false); // once per translation
    await first.s.save();
    expect(first.s.isDirty()).toBe(false);
    await editJson(first.fs, EN, { title: "Hello there" });
    const d = (await detectProject(first.fs, R))!;
    const again = await ProjectSession.open(first.fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
    expect(again.meta(c("title"), "th").needsReview).toBe(true);
    expect(again.meta(c("nav.home"), "th").needsReview).toBe(false);
  });

  it("an unreadable state.json is never touched", async () => {
    const { fs } = await openFx("next-nested");
    await fs.writeTextAtomic(`${R}/${STATE_PATH}`, "{ not json");
    const d = (await detectProject(fs, R))!;
    const s = await ProjectSession.open(fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
    expect(s.recordBaseFingerprints()).toBe(false);
  });
});
