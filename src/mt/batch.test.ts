import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { MemoryFs, loadFixtureDir } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { keyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { missingItems, translateMissing } from "./batch";

const R = "/project";
const c = (k: string) => keyId("common", k);
const ok = async (s: string) => ({ ok: true as const, text: `th:${s}` });

async function open() {
  const j = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
  const fs = new MemoryFs({
    [`${R}/public/locales/en/common.json`]: j({ a: "A", b: "B", c: "C" }),
    [`${R}/public/locales/en/other.json`]: j({ x: "X" }),
    [`${R}/public/locales/th/common.json`]: j({ b: "บี" }),
    [`${R}/public/locales/th/other.json`]: j({}),
  });
  const d = (await detectProject(fs, R))!;
  return ProjectSession.open(fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
}

describe("batch", () => {
  it("translates only missing cells and marks them machine", async () => {
    const session = await open();
    const items = missingItems(session, "th", "common");
    expect(items.map((i) => i.source)).toEqual(["A", "C"]);
    const r = await translateMissing(session, items, "th", ok, () => {}, new AbortController().signal);
    expect(r).toEqual({ translated: 2, unsafe: [], failed: [], skipped: 0, cancelled: false });
    expect(session.value(c("a"), "th")).toEqual({ kind: "text", text: "th:A" });
    expect(session.meta(c("a"), "th")).toMatchObject({ status: "translated", machine: true });
    expect(session.value(c("b"), "th")).toEqual({ kind: "text", text: "บี" });
  });

  it("filters by namespace", async () => {
    const session = await open();
    expect(missingItems(session, "th", "all").map((i) => i.source)).toEqual(["A", "C", "X"]);
    expect(missingItems(session, "th", "other").map((i) => i.source)).toEqual(["X"]);
  });

  it("skips a cell filled while the batch was running", async () => {
    const session = await open();
    const items = missingItems(session, "th", "common");
    const r = await translateMissing(session, items, "th", async (s) => {
      if (s === "A") session.setText(c("c"), "th", "typed by hand");
      return { ok: true, text: `th:${s}` };
    }, () => {}, new AbortController().signal);
    expect(r.skipped).toBe(1);
    expect(r.translated).toBe(1);
    expect(session.value(c("c"), "th")).toEqual({ kind: "text", text: "typed by hand" });
    expect(session.meta(c("c"), "th").machine).toBe(false);
  });

  it("skips a key deleted while the batch was running", async () => {
    const session = await open();
    const items = missingItems(session, "th", "common");
    const r = await translateMissing(session, items, "th", async (s) => {
      if (s === "A") session.deleteKey(c("c"));
      return { ok: true, text: `th:${s}` };
    }, () => {}, new AbortController().signal);
    expect(r).toEqual({ translated: 1, unsafe: [], failed: [], skipped: 1, cancelled: false });
  });

  it("collects unsafe and failed results", async () => {
    const session = await open();
    const r = await translateMissing(session, missingItems(session, "th", "common"), "th", async (s) =>
      s === "A" ? { ok: false, reason: "unsafe" } : { ok: false, reason: "error", message: "boom" },
    () => {}, new AbortController().signal);
    expect(r).toEqual({
      translated: 0,
      unsafe: [c("a")],
      failed: [{ id: c("c"), message: "boom" }],
      skipped: 0,
      cancelled: false,
    });
  });

  it("stops on abort before the next item", async () => {
    const session = await open();
    const ac = new AbortController();
    const r = await translateMissing(session, missingItems(session, "th", "common"), "th", async () => {
      ac.abort();
      return { ok: false, reason: "unsafe" };
    }, () => {}, ac.signal);
    expect(r).toMatchObject({ translated: 0, unsafe: [c("a")], cancelled: true });
  });

  it("keeps earlier results and cancels on a cancelled result", async () => {
    const session = await open();
    const r = await translateMissing(session, missingItems(session, "th", "common"), "th", async (s) =>
      s === "A" ? { ok: true, text: "th:A" } : { ok: false, reason: "cancelled" },
    () => {}, new AbortController().signal);
    expect(r).toMatchObject({ translated: 1, cancelled: true });
    expect(session.value(c("a"), "th")).toEqual({ kind: "text", text: "th:A" });
    expect(session.value(c("c"), "th")).toBeUndefined();
  });

  it("skips complex paraglide messages", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "../test/fixtures/paraglide"));
    const d = (await detectProject(fs, R))!;
    const s = await ProjectSession.open(fs, R, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
    const id = [...s.data.values.keys()].find((k) => k.endsWith("download"))!;
    expect(s.value(id, "en")?.kind).toBe("complex");
    const target = s.data.locales.find((l) => l !== "en")!;
    const items = missingItems(s, target, "all");
    expect(items.map((i) => i.id)).not.toContain(id);
    for (const i of items) expect(i.source.trim()).not.toBe("");
  });

  it("reports progress with the next item as current", async () => {
    const session = await open();
    const calls: unknown[] = [];
    await translateMissing(session, missingItems(session, "th", "common"), "th", ok, (p) => calls.push(p), new AbortController().signal);
    expect(calls).toEqual([
      { done: 0, total: 2, current: null },
      { done: 1, total: 2, current: c("c") },
      { done: 2, total: 2, current: null },
    ]);
  });
});
