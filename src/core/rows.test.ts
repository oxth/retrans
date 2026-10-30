import { describe, expect, it } from "vitest";
import { MemoryFs } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { keyId } from "./model";
import { buildRows, nextMissing, type RowFilter } from "./rows";
import { ProjectSession } from "./session";

const R = "/project";
const NEXT = "public/locales";

async function open(files: Record<string, unknown>) {
  const fs = new MemoryFs(
    Object.fromEntries(Object.entries(files).map(([p, v]) => [`${R}/${NEXT}/${p}`, JSON.stringify(v, null, 2) + "\n"])),
  );
  const d = (await detectProject(fs, R))!;
  return ProjectSession.open(fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
}

const F = (o: Partial<RowFilter> = {}): RowFilter => ({
  search: "", ns: "all", locales: ["th", "ja"], missing: false, needsReview: false, machine: false, status: "all", ...o,
});
const c = (k: string) => keyId("common", k);
const ids = (rows: { key: string }[]) => rows.map((r) => r.key);

const basic = () =>
  open({
    "en/common.json": { Title: "Hello World", bye: "Goodbye", only: "Only en" },
    "th/common.json": { Title: "สวัสดี", bye: "ลาก่อน" },
    "ja/common.json": { Title: "こんにちは", only: "x" },
  });

describe("buildRows", () => {
  it("search matches key or any visible value, case-insensitive (Thai too)", async () => {
    const s = await basic();
    expect(ids(buildRows(s, F({ search: "HELLO" })))).toEqual(["Title"]);
    expect(ids(buildRows(s, F({ search: "title" })))).toEqual(["Title"]);
    expect(ids(buildRows(s, F({ search: "ลาก่อน" })))).toEqual(["bye"]);
    expect(ids(buildRows(s, F({ search: "ลาก่อน", locales: ["ja"] })))).toEqual([]);
    expect(ids(buildRows(s, F({ search: "" })))).toEqual(["Title", "bye", "only"]);
    expect(buildRows(s, F({ ns: "other" }))).toEqual([]);
  });

  it("missing filter keeps rows with any visible applicable untranslated cell; non-applicable plural cells don't count", async () => {
    const s = await basic();
    expect(ids(buildRows(s, F({ missing: true })))).toEqual(["bye", "only"]);
    expect(ids(buildRows(s, F({ missing: true, locales: ["th"] })))).toEqual(["only"]);
    // th has only "other" for plurals; `items_one` is not applicable for th/ja
    const p = await open({
      "en/common.json": { items_one: "1 item", items_other: "{{count}} items" },
      "th/common.json": { items_other: "{{count}} อัน" },
      "ja/common.json": { items_other: "{{count}}" },
    });
    expect(ids(buildRows(p, F({ missing: true })))).toEqual([]);
    expect(ids(buildRows(p, F({ missing: true, locales: ["th", "ja"] })))).toEqual([]);
  });

  it("needsReview / machine / status filters", async () => {
    const s = await basic();
    s.setText(c("bye"), "th", "ลาก่อนจ้า", { machine: true });
    s.markReviewed(c("Title"), "th");
    expect(ids(buildRows(s, F({ machine: true })))).toEqual(["bye"]);
    expect(ids(buildRows(s, F({ status: "reviewed" })))).toEqual(["Title"]);
    expect(ids(buildRows(s, F({ status: "untranslated" })))).toEqual(["bye", "only"]);
    expect(ids(buildRows(s, F({ status: "translated", locales: ["th"] })))).toEqual(["bye"]);
    s.setText(c("Title"), "en", "Hello changed");
    expect(ids(buildRows(s, F({ needsReview: true })))).toEqual(["Title"]);
    expect(ids(buildRows(s, F({ needsReview: true, machine: true })))).toEqual([]);
  });

  it("plural variants are adjacent and carry pluralGroup/category", async () => {
    const p = await open({
      "en/common.json": { a: "A", items_one: "1", items_other: "n", z: "Z" },
      "ru/common.json": { items_one: "1", items_other: "o" },
    });
    const rows = buildRows(p, F({ locales: ["ru"] }));
    const items = rows.filter((r) => r.pluralGroup === "items");
    expect(items.map((r) => r.pluralCategory)).toEqual(["one", "few", "many", "other"]);
    const first = rows.indexOf(items[0]);
    expect(rows.slice(first, first + items.length)).toEqual(items);
    expect(items.map((r) => r.pluralCategory)).toContain("other");
    expect(rows.find((r) => r.key === "a")!.pluralGroup).toBeUndefined();
  });

  it("plural variants only present in a non-base locale stay contiguous in category order", async () => {
    const p = await open({
      "en/common.json": { items_one: "1", x: "X", items_other: "n", y: "Y" },
      "ru/common.json": { items_one: "1", items_few: "f", items_many: "m", items_other: "o" },
    });
    const rows = buildRows(p, F({ locales: ["ru"] }));
    expect(ids(rows)).toEqual(["items_one", "items_few", "items_many", "items_other", "x", "y"]);
    expect(rows.slice(0, 4).map((r) => r.pluralCategory)).toEqual(["one", "few", "many", "other"]);
    expect(rows.slice(0, 4).every((r) => r.pluralGroup === "items")).toBe(true);
  });

  it("nextMissing wraps and skips non-applicable cells", async () => {
    const s = await open({
      "en/common.json": { a: "A", items_one: "1", items_other: "n", b: "B" },
      "th/common.json": { a: "x", items_other: "o" },
      "ja/common.json": { a: "y", items_other: "o", b: "z" },
    });
    const loc = ["th", "ja"];
    const rows = buildRows(s, F({ locales: loc }));
    // only missing applicable cell: b/th
    expect(nextMissing(s, rows, { id: c("a"), locale: "th" }, loc)).toEqual({ id: c("b"), locale: "th" });
    // wraps around
    expect(nextMissing(s, rows, { id: c("b"), locale: "ja" }, loc)).toEqual({ id: c("b"), locale: "th" });
    // from itself the only one: returns itself
    expect(nextMissing(s, rows, { id: c("b"), locale: "th" }, loc)).toEqual({ id: c("b"), locale: "th" });
    s.setText(c("b"), "th", "t");
    expect(nextMissing(s, rows, { id: c("a"), locale: "th" }, loc)).toBeNull();
  });

  it("buildRows over 5,000 keys × 10 locales runs under 100 ms", async () => {
    const locales = ["en", "th", "ja", "de", "fr", "es", "it", "pt", "ru", "ko"];
    const files: Record<string, unknown> = {};
    for (const l of locales) {
      const o: Record<string, string> = {};
      for (let i = 0; i < 5000; i++) {
        if (i % 50 === 0) {
          o[`k${i}_one`] = `One ${i} ${l}`;
          o[`k${i}_other`] = `Many ${i} ${l}`;
        } else if (l === "en" || i % 7 !== 0) o[`k${i}`] = `Value ${i} ${l}`;
      }
      files[`${l}/common.json`] = o;
    }
    const s = await open(files);
    const f = F({ locales: locales.slice(1), search: "value 4", missing: true, status: "untranslated" });
    buildRows(s, f); // warm-up
    const t = performance.now();
    const rows = buildRows(s, f);
    const dt = performance.now() - t;
    expect(rows.length).toBeGreaterThan(0);
    expect(dt).toBeLessThan(100);
  });
});
