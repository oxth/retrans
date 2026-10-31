import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadFixtureDir, type MemoryFs } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { keyId } from "../core/model";
import { STATE_PATH } from "../core/state-file";
import { buildRows, nextMissing, type RowFilter } from "../core/rows";
import { ProjectSession } from "../core/session";

const R = "/project";
const FILTER: RowFilter = { search: "", ns: "all", locales: ["th"], missing: false, needsReview: false, machine: false, status: "all" };

async function open(fs: MemoryFs) {
  const d = (await detectProject(fs, R))!;
  return ProjectSession.open(fs, R, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
}

/** Changed / added / removed lines per file (positional diff is enough for these small edits). */
function lineDiff(before: Record<string, string>, after: Record<string, string>) {
  const out: Record<string, { removed: string[]; added: string[] }> = {};
  for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (p.endsWith(STATE_PATH)) continue;
    if (before[p] === after[p]) continue;
    const a = (before[p] ?? "").split(/\r?\n/).filter(Boolean);
    const b = (after[p] ?? "").split(/\r?\n/).filter(Boolean);
    const sa = new Set(a);
    const sb = new Set(b);
    out[p.replace(`${R}/`, "")] = { removed: a.filter((l) => !sb.has(l)), added: b.filter((l) => !sa.has(l)) };
  }
  return out;
}

const fixture = (n: string) => loadFixtureDir(resolve(__dirname, "fixtures", n));

describe("e2e core scenario", () => {
  it.each([
    { name: "next-nested", ns: "common", existing: "nav.home", newKey: "footer.note", rel: "public/locales" },
    { name: "next-flat-crlf", ns: "common", existing: "a.title", newKey: "c.new", rel: "public/locales" },
    { name: "paraglide", ns: "", existing: "greeting", newKey: "farewell", rel: "messages" },
  ])("full edit flow on $name changes only intended lines", async ({ name, ns, existing, newKey }) => {
    const fs = fixture(name);
    const original = fs.snapshot();
    const s = await open(fs);
    const id = (k: string) => keyId(ns, k);

    // Tab flow: jump to the next missing Thai cell and fill it
    const rows = buildRows(s, FILTER);
    const first = { id: rows[0].id, locale: "th" };
    const hit = nextMissing(s, rows, first, ["th"]);
    expect(hit).not.toBeNull();
    expect(hit!.locale).toBe("th");
    expect(s.value(hit!.id, "th")).toBeUndefined();
    s.setText(hit!.id, "th", "แปลใหม่");
    expect(s.meta(hit!.id, "th").status).toBe("translated");
    s.markReviewed(hit!.id, "th");
    expect(s.meta(hit!.id, "th").status).toBe("reviewed");

    // Changing English flags Thai as needing review
    s.setText(id(existing), "th", s.value(id(existing), "th") ? (s.value(id(existing), "th") as any).text : "ไทย");
    s.markReviewed(id(existing), "th");
    s.setText(id(existing), "en", "Changed English");
    expect(s.meta(id(existing), "th").needsReview).toBe(true);

    // add / rename / delete key
    const added = s.addKey(ns, newKey, "Brand new");
    expect(s.data.keyOrder).toContain(added);
    const renamed = s.renameKey(added, newKey + "2");
    expect(s.data.keyOrder).toContain(renamed);
    expect(s.data.keyOrder).not.toContain(added);
    s.deleteKey(renamed);
    expect(s.data.keyOrder).not.toContain(renamed);

    // add language
    s.addLanguage("ja");
    expect(s.data.locales).toContain("ja");

    const r = await s.save();
    expect(r.stale).toEqual([]);
    expect(s.isDirty()).toBe(false);

    const after = fs.snapshot();
    const diff = lineDiff(original, after);
    const changed = Object.keys(diff).sort();
    // en (changed English line), th (filled cell), new ja file(s), and for Paraglide the inlang locales list
    expect(changed.every((p) => /(^|\/)(en|th|ja)(\/|\.json$)|inlang\/settings\.json$/.test(p))).toBe(true);
    expect(changed.some((p) => /(^|\/)ja(\/|\.json$)/.test(p))).toBe(true);
    for (const [p, d] of Object.entries(diff)) {
      expect(d.added.join("\n")).not.toContain("Brand new"); // added then deleted before save
      if (/(^|\/)ja(\/|\.json$)/.test(p)) {
        expect(d.removed).toEqual([]);
      } else if (p.endsWith("settings.json")) {
        expect(d.removed).toHaveLength(1);
        expect(d.added).toHaveLength(1);
        expect(d.added[0]).toContain('"ja"');
      } else if (/(^|\/)en(\/|\.json$)/.test(p)) {
        expect(d.removed).toHaveLength(1);
        expect(d.added).toHaveLength(1);
        expect(d.added[0]).toContain("Changed English");
      } else {
        // th: the filled cell; at most the previous last line gains a trailing comma
        expect(d.removed.length).toBeLessThanOrEqual(1);
        expect(d.added.join("\n")).toContain("แปลใหม่");
      }
    }
    // untouched files are byte-identical (e.g. checkout.json)
    for (const [p, text] of Object.entries(original)) if (!changed.includes(p.replace(`${R}/`, "")) && after[p] !== undefined) expect(after[p]).toBe(text);

    // second save without edits writes nothing
    fs.writes.length = 0;
    await s.save();
    expect(fs.writes.filter((w) => !w.endsWith(STATE_PATH))).toEqual([]);
  });

  it("external edit is picked up by reloadFromDisk", async () => {
    const fs = fixture("next-nested");
    const s = await open(fs);
    const p = `${R}/public/locales/th/common.json`;
    const text = await fs.readText(p);
    await fs.writeTextAtomic(p, text.replace("สวัสดี", "ดีจ้า"));
    const conflicts = await s.reloadFromDisk();
    expect(conflicts).toEqual([]);
    expect(s.value(keyId("common", "title"), "th")).toEqual({ kind: "text", text: "ดีจ้า" });
    expect(s.isDirty()).toBe(false);
  });

  it("external edit to a cell with unsaved changes yields a conflict", async () => {
    const fs = fixture("next-nested");
    const s = await open(fs);
    const p = `${R}/public/locales/th/common.json`;
    s.setText(keyId("common", "title"), "th", "ของฉัน");
    await fs.writeTextAtomic(p, (await fs.readText(p)).replace("สวัสดี", "ของเขา"));
    const conflicts = await s.reloadFromDisk();
    expect(conflicts).toHaveLength(1);
    expect(s.value(keyId("common", "title"), "th")).toEqual({ kind: "text", text: "ของฉัน" });
  });

  it("crash recovery: journal from one session restores in a fresh session", async () => {
    const fs = fixture("next-nested");
    const s = await open(fs);
    const t = keyId("common", "nav.about");
    s.setText(t, "th", "เกี่ยวกับ");
    s.markReviewed(t, "th");
    const fresh = s.addKey("common", "footer.note", "Note");
    const j = s.toJournal();
    const s2 = await open(fs); // "after the crash": nothing was saved
    expect(s2.isDirty()).toBe(false);
    expect(s2.applyJournal(j)).toEqual([]);
    expect(s2.value(t, "th")).toEqual({ kind: "text", text: "เกี่ยวกับ" });
    expect(s2.meta(t, "th").status).toBe("reviewed");
    expect(s2.value(fresh, "en")).toEqual({ kind: "text", text: "Note" });
    expect(s2.dirtyCells()).toEqual(s.dirtyCells());
  });
});
