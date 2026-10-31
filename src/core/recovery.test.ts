import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { hashText } from "./hash";
import { keyId } from "./model";
import { clearJournal, journalPath, readJournal, writeJournal } from "./recovery";
import { ProjectSession } from "./session";

const R = "/project";
const c = (k: string) => keyId("common", k);

async function open(fs: MemoryFs) {
  const d = (await detectProject(fs, R))!;
  return ProjectSession.open(fs, R, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
}

describe("recovery journal", () => {
  it("journalPath hashes the root under appData/recovery", () => {
    expect(journalPath("/app", R)).toBe(`/app/recovery/${hashText(R)}.json`);
  });

  it("journal round-trip restores unsaved edits", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "../test/fixtures/next-nested"));
    const s = await open(fs);
    s.setText(c("title"), "th", "ใหม่");
    s.setText(c("nav.home"), "th", null);
    s.markReviewed(c("title"), "th");
    s.setComplex(c("nav.about"), "th", { a: [1, 2] });
    s.addLanguage("fr");
    s.setText(c("title"), "fr", "Bonjour");
    s.addNamespace("auth");
    const fresh = s.addKey("auth", "login", "Log in");
    const j = s.toJournal();

    const path = journalPath("/appdata", R);
    await writeJournal(fs, path, j);
    const back = await readJournal(fs, path);
    expect(back).toEqual(j);

    const s2 = await open(fs);
    s2.applyJournal(back!);
    expect(s2.data.locales).toEqual(s.data.locales);
    expect(s2.data.namespaces).toEqual(s.data.namespaces);
    expect(s2.dirtyCells()).toEqual(s.dirtyCells());
    expect(s2.value(fresh, "en")).toEqual({ kind: "text", text: "Log in" });
    expect(s2.value(c("nav.about"), "th")).toEqual({ kind: "complex", raw: { a: [1, 2] } });
    expect(s2.meta(c("title"), "th").status).toBe("reviewed");
    expect(s2.state).toEqual(s.state);

    await clearJournal(fs, path);
    expect(await readJournal(fs, path)).toBeNull();
    await clearJournal(fs, path); // missing is fine
  });

  it("applyJournal merges with disk changes made after the journal was written", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "../test/fixtures/next-nested"));
    const s = await open(fs);
    s.setText(c("title"), "th", "ของฉัน");
    s.setText(c("nav.home"), "th", "บ้านของฉัน");
    s.markReviewed(c("title"), "th");
    const j = s.toJournal();
    // after the crash, a teammate's change lands: one other cell, one same cell (differently)
    await fs.writeTextAtomic(
      `${R}/public/locales/th/common.json`,
      JSON.stringify({ title: "สวัสดี", nav: { home: "บ้านของเขา", about: "เกี่ยวกับ" }, orphan: "เศษ" }, null, 2) + "\n",
    );
    const s2 = await open(fs);
    const conflicts = s2.applyJournal(j);
    expect(conflicts).toEqual([
      { id: c("nav.home"), locale: "th", mine: { kind: "text", text: "บ้านของฉัน" }, theirs: { kind: "text", text: "บ้านของเขา" } },
    ]);
    expect(s2.conflicts).toEqual(conflicts);
    expect(s2.value(c("title"), "th")).toEqual({ kind: "text", text: "ของฉัน" });
    expect(s2.value(c("nav.home"), "th")).toEqual({ kind: "text", text: "บ้านของฉัน" });
    expect(s2.value(c("nav.about"), "th")).toEqual({ kind: "text", text: "เกี่ยวกับ" });
    expect(s2.meta(c("title"), "th").status).toBe("reviewed");
  });

  it("applyJournal only replaces status entries the journal touched", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "../test/fixtures/next-nested"));
    const s = await open(fs);
    s.markReviewed(c("nav.home"), "th");
    const j = s.toJournal();
    const s2 = await open(fs);
    s2.markReviewed(c("title"), "th"); // stands in for a status change on disk since the journal
    expect(s2.applyJournal(j)).toEqual([]);
    expect(s2.meta(c("title"), "th").status).toBe("reviewed");
    expect(s2.meta(c("nav.home"), "th").status).toBe("reviewed");
  });

  it("applyJournal refuses a journal for another root", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "../test/fixtures/next-nested"));
    const s = await open(fs);
    const j = { ...s.toJournal(), root: "/elsewhere" };
    expect(() => s.applyJournal(j)).toThrow(/root/);
    expect(() => s.applyJournal({ ...j, root: "/project/" })).not.toThrow();
  });

  it("readJournal returns null for missing or invalid JSON", async () => {
    const fs = new MemoryFs({ "/a/bad.json": "{nope", "/a/wrong.json": "[1]" });
    expect(await readJournal(fs, "/a/missing.json")).toBeNull();
    expect(await readJournal(fs, "/a/bad.json")).toBeNull();
    expect(await readJournal(fs, "/a/wrong.json")).toBeNull();
  });
});
