import { describe, expect, it } from "vitest";
import { MemoryFs } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { keyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { MANIFEST_PATH } from "./manifest";
import { buildPackage } from "./build";
import { applyImport, diffPackage, openIncoming, openIncomingFolder } from "./diff";

const R = "/project";
const NOW = new Date("2026-11-02T10:00:00Z");
const j = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const c = (k: string) => keyId("common", k);
const t = (text: string) => ({ kind: "text" as const, text });
const CONFIG = "module.exports = {\n  i18n: { defaultLocale: 'en', locales: ['en', 'th', 'ja'] },\n};\n";

type Entries = Array<{ path: string; text: string }>;

async function dev(): Promise<{ s: ProjectSession; fs: MemoryFs }> {
  const fs = new MemoryFs({
    [`${R}/next-i18next.config.js`]: CONFIG,
    [`${R}/public/locales/en/common.json`]: j({ a: "A", b: "B", c: "C", d: "D" }),
    [`${R}/public/locales/th/common.json`]: j({ a: "เอ", c: "ซี", d: "ดี" }),
    [`${R}/public/locales/ja/common.json`]: j({ a: "エー" }),
  });
  const d = (await detectProject(fs, R))!;
  const s = await ProjectSession.open(fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
  s.setProjectSetting({ id: "proj-1" });
  await s.save();
  return { s, fs };
}

/** The translator opens the package, edits, saves; returns the files they send back. */
async function translate(pkg: Entries, edit: (s: ProjectSession) => void): Promise<Entries> {
  const { session } = await openIncoming(pkg);
  edit(session);
  const res = await session.save();
  expect(res.stale).toEqual([]);
  const fs = session.fs as MemoryFs;
  return Object.entries(fs.snapshot()).map(([p, text]) => ({ path: p.replace(/^\/incoming\//, ""), text }));
}

async function scenario(edit: (s: ProjectSession) => void, devEdit?: (s: ProjectSession) => void) {
  const { s } = await dev();
  const pkg = await buildPackage(s, { locales: ["th"], now: NOW });
  const back = await translate(pkg, edit);
  devEdit?.(s);
  const { session, manifest } = await openIncoming(back);
  return { current: s, diff: diffPackage(s, session, manifest), manifest };
}

describe("import diff", () => {
  it("translator fills a missing cell → new, with their reviewed status", async () => {
    const { current, diff } = await scenario((s) => {
      s.setText(c("b"), "th", "บี");
      s.markReviewed(c("b"), "th");
    });
    expect(diff.hasManifest).toBe(true);
    expect(diff.otherProject).toBe(false);
    expect(diff.items).toEqual([
      expect.objectContaining({ id: c("b"), locale: "th", kind: "new", mine: undefined, theirs: t("บี") }),
    ]);
    expect(applyImport(current, diff, new Map())).toBe(1);
    expect(current.value(c("b"), "th")).toEqual(t("บี"));
    expect(current.meta(c("b"), "th")).toMatchObject({ status: "reviewed", machine: false, needsReview: false });
  });

  it("translator's machine flag travels", async () => {
    const { current, diff } = await scenario((s) => s.setText(c("b"), "th", "บี?", { machine: true }));
    expect(diff.items.map((i) => i.kind)).toEqual(["new"]);
    applyImport(current, diff, new Map());
    expect(current.meta(c("b"), "th")).toMatchObject({ status: "translated", machine: true });
  });

  it("translator only marks reviewed → status item", async () => {
    const { current, diff } = await scenario((s) => s.markReviewed(c("a"), "th"));
    expect(diff.items).toEqual([
      expect.objectContaining({ id: c("a"), locale: "th", kind: "status", mine: t("เอ"), theirs: t("เอ") }),
    ]);
    expect(applyImport(current, diff, new Map())).toBe(1);
    expect(current.meta(c("a"), "th").status).toBe("reviewed");
  });

  it("translator changes a value → changed; clearing a cell is also changed", async () => {
    const { current, diff } = await scenario((s) => {
      s.setText(c("a"), "th", "เอใหม่");
      s.setText(c("c"), "th", null);
    });
    expect(diff.items.map((i) => [i.id, i.kind])).toEqual([[c("a"), "changed"], [c("c"), "changed"]]);
    expect(applyImport(current, diff, new Map())).toBe(2);
    expect(current.value(c("a"), "th")).toEqual(t("เอใหม่"));
    expect(current.value(c("c"), "th")).toBeUndefined();
    expect(current.state.entries[c("c")]?.th).toBeUndefined();
  });

  it("both edited the same cell differently → conflict; picks decide; default keeps mine", async () => {
    const { current, diff } = await scenario(
      (s) => {
        s.setText(c("a"), "th", "theirs-a");
        s.setText(c("c"), "th", "theirs-c");
        s.setText(c("d"), "th", "same");
      },
      (s) => {
        s.setText(c("a"), "th", "mine-a");
        s.setText(c("c"), "th", "mine-c");
        s.setText(c("d"), "th", "same");
      },
    );
    // d: both made the same edit → nothing to do
    expect(diff.items.map((i) => [i.id, i.kind])).toEqual([[c("a"), "conflict"], [c("c"), "conflict"]]);
    expect(diff.items[0]).toMatchObject({ mine: t("mine-a"), theirs: t("theirs-a") });
    const n = applyImport(current, diff, new Map([[`${c("c")}|th`, "theirs" as const]]));
    expect(n).toBe(1);
    expect(current.value(c("a"), "th")).toEqual(t("mine-a"));
    expect(current.value(c("c"), "th")).toEqual(t("theirs-c"));
  });

  it("a pick of mine on a non-conflict item skips it", async () => {
    const { current, diff } = await scenario((s) => s.setText(c("b"), "th", "บี"));
    expect(applyImport(current, diff, new Map([[`${c("b")}|th`, "mine" as const]]))).toBe(0);
    expect(current.value(c("b"), "th")).toBeUndefined();
  });

  it("dev edited a cell the translator didn't touch → nothing", async () => {
    const { diff } = await scenario(
      () => {},
      (s) => {
        s.setText(c("a"), "th", "dev changed");
        s.markReviewed(c("c"), "th");
        s.setText(c("d"), "th", null);
      },
    );
    expect(diff.items).toEqual([]);
    expect(diff.skipped).toEqual([]);
  });

  it("dev deleted a key after export → skipped unknown-key", async () => {
    const { current, diff } = await scenario(
      (s) => s.setText(c("b"), "th", "บี"),
      (s) => s.deleteKey(c("b")),
    );
    expect(diff.items).toEqual([]);
    expect(diff.skipped).toEqual([
      { id: c("b"), locale: "en", reason: "unknown-key" },
      { id: c("b"), locale: "th", reason: "unknown-key" },
    ]);
    expect(applyImport(current, diff, new Map())).toBe(0);
  });

  it("translator changed base text → skipped base-locale and never applied", async () => {
    const { current, diff } = await scenario((s) => s.setText(c("a"), "en", "A changed"));
    expect(diff.items).toEqual([]);
    expect(diff.skipped).toEqual([{ id: c("a"), locale: "en", reason: "base-locale" }]);
    // even a forced pick can't apply it
    expect(applyImport(current, diff, new Map([[`${c("a")}|en`, "theirs" as const]]))).toBe(0);
    expect(current.value(c("a"), "en")).toEqual(t("A"));
    expect(current.isDirty()).toBe(false);
  });

  it("statuses Retrans adds on its own (base-edit pins) don't read as translator changes", async () => {
    // The translator's base edit pins th:a's untracked translation; the dev meanwhile edits th:a.
    const { diff } = await scenario(
      (s) => s.setText(c("a"), "en", "A changed"),
      (s) => s.setText(c("a"), "th", "dev's เอ"),
    );
    expect(diff.items).toEqual([]);
    expect(diff.skipped).toEqual([{ id: c("a"), locale: "en", reason: "base-locale" }]);
  });

  it("dev added a language after export → its cells untouched", async () => {
    const { current, diff } = await scenario(
      (s) => s.setText(c("b"), "th", "บี"),
      (s) => {
        s.addLanguage("fr");
        s.setText(c("a"), "fr", "A-fr");
      },
    );
    expect(diff.items.every((i) => i.locale === "th")).toBe(true);
    expect(diff.skipped).toEqual([]);
    applyImport(current, diff, new Map());
    expect(current.value(c("a"), "fr")).toEqual(t("A-fr"));
    expect(current.value(c("b"), "fr")).toBeUndefined();
  });

  it("translator added a language the project lacks → unknown-locale once", async () => {
    const { diff } = await scenario((s) => {
      s.addLanguage("de");
      s.setText(c("a"), "de", "A-de");
      s.setText(c("b"), "de", "B-de");
    });
    expect(diff.skipped).toEqual([{ id: "", locale: "de", reason: "unknown-locale" }]);
    expect(diff.items).toEqual([]);
  });

  it("package from another project → otherProject true", async () => {
    const { s } = await dev();
    const pkg = await buildPackage(s, { locales: ["th"], now: NOW });
    const back = await translate(pkg, (x) => x.setText(c("b"), "th", "บี"));
    s.setProjectSetting({ id: "proj-2" });
    const { session, manifest } = await openIncoming(back);
    const diff = diffPackage(s, session, manifest);
    expect(diff.otherProject).toBe(true);
    expect(diff.items.map((i) => i.kind)).toEqual(["new"]);
  });

  it("no manifest → values only: missing→new, differing→conflict, no status carried", async () => {
    const { s } = await dev();
    const pkg = await buildPackage(s, { locales: ["th"], now: NOW });
    const back = (await translate(pkg, (x) => {
      x.setText(c("b"), "th", "บี");
      x.markReviewed(c("b"), "th");
      x.setText(c("a"), "th", "เอ2");
      x.markReviewed(c("c"), "th");
      x.setText(c("d"), "th", null);
    })).filter((e) => e.path !== MANIFEST_PATH);
    const { session, manifest } = await openIncoming(back);
    expect(manifest).toBeNull();
    const diff = diffPackage(s, session, manifest);
    expect(diff.hasManifest).toBe(false);
    expect(diff.otherProject).toBe(false);
    expect(diff.items.map((i) => [i.id, i.kind])).toEqual([[c("a"), "conflict"], [c("b"), "new"]]);
    expect(diff.items.every((i) => i.theirsEntry === undefined)).toBe(true);
    applyImport(s, diff, new Map());
    expect(s.value(c("b"), "th")).toEqual(t("บี"));
    expect(s.meta(c("b"), "th")).toMatchObject({ status: "translated", machine: false });
    expect(s.value(c("a"), "th")).toEqual(t("เอ"));
    expect(s.value(c("d"), "th")).toEqual(t("ดี"));
  });

  it("applyImport returns the count and leaves the session dirty for a normal save", async () => {
    const { current, diff } = await scenario((s) => {
      s.setText(c("b"), "th", "บี");
      s.markReviewed(c("a"), "th");
    });
    expect(current.isDirty()).toBe(false);
    expect(applyImport(current, diff, new Map())).toBe(2);
    expect(current.isDirty()).toBe(true);
    const fs = current.fs as MemoryFs;
    const res = await current.save();
    expect(res.written.sort()).toEqual([".retrans/state.json", "public/locales/th/common.json"]);
    expect(JSON.parse(fs.snapshot()[`${R}/public/locales/th/common.json`])).toEqual({ a: "เอ", b: "บี", c: "ซี", d: "ดี" });
    expect(current.isDirty()).toBe(false);
  });
});

describe("openIncoming", () => {
  it("no translation files → Couldn't find translation files here.", async () => {
    await expect(openIncoming([{ path: "readme.txt", text: "hi" }])).rejects.toThrow("Couldn't find translation files here.");
  });

  it("without manifest or config, falls back to the current project's base when present", async () => {
    const entries = [
      { path: "public/locales/en/common.json", text: j({ a: "A" }) },
      { path: "public/locales/th/common.json", text: j({ a: "เอ" }) },
    ];
    const { session } = await openIncoming(entries, "th");
    expect(session.data.baseLocale).toBe("th");
  });

  it("drops unsafe entry paths", async () => {
    const { session } = await openIncoming([
      { path: "public/locales/en/common.json", text: j({ a: "A" }) },
      { path: "../evil/locales/th/common.json", text: j({ a: "x" }) },
    ], "en");
    expect(session.data.locales).toEqual(["en"]);
  });

  it("openIncomingFolder reads a plain folder", async () => {
    const fs = new MemoryFs({
      "/drop/public/locales/en/common.json": j({ a: "A" }),
      "/drop/public/locales/th/common.json": j({ a: "เอ" }),
    });
    const { session, manifest } = await openIncomingFolder(fs, "/drop", "en");
    expect(manifest).toBeNull();
    expect(session.value(c("a"), "th")).toEqual(t("เอ"));
    await expect(openIncomingFolder(new MemoryFs({}), "/none")).rejects.toThrow("Couldn't find translation files here.");
  });
});
