import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { keyId } from "../core/model";
import { nextI18nextAdapter as adapter } from "./next-i18next";

const fx = (name: string) => loadFixtureDir(resolve(__dirname, "../test/fixtures", name));
const R = "/project";

describe("next-i18next detect", () => {
  it("detect reads defaultLocale and locales from config statically", async () => {
    const r = await adapter.detect(fx("next-nested"), R);
    expect(r).toMatchObject({
      format: "next-i18next",
      baseLocale: "en",
      locales: ["en", "th"],
      namespaces: ["checkout", "common"],
      localesPath: "public/locales",
    });
    expect(r!.keyCount).toBeGreaterThan(0);
  });

  it("detect without config infers locales from folders and returns baseLocale null", async () => {
    const r = await adapter.detect(fx("next-flat-crlf"), R);
    expect(r!.baseLocale).toBeNull();
    expect(r!.locales).toEqual(["en", "th"]);
    expect(r!.namespaces).toEqual(["common"]);
  });

  it("detect returns null for a folder with neither config nor public/locales", async () => {
    expect(await adapter.detect(new MemoryFs({ "/project/readme.md": "x" }), R)).toBeNull();
  });
});

describe("next-i18next load", () => {
  const opts = { baseLocale: "en", localesPath: "public/locales" };

  it("load builds dotted keys, keyOrder follows base file order", async () => {
    const { data } = await adapter.load(fx("next-nested"), R, opts);
    expect(data.locales).toEqual(["en", "th"]);
    expect(data.namespaces).toEqual(["checkout", "common"]);
    expect(data.keyOrder.slice(0, 3)).toEqual([
      keyId("checkout", "pay"),
      keyId("checkout", "total"),
      keyId("common", "title"),
    ]);
    const common = data.keyOrder.filter((k) => k.startsWith("common::"));
    expect(common.indexOf(keyId("common", "nav.home"))).toBeLessThan(common.indexOf(keyId("common", "nav.about")));
    expect(common).toContain(keyId("common", "items_one"));
    expect(common).toContain(keyId("common", "lit.a.b"));
    // orphan (only in th) comes last
    expect(data.keyOrder[data.keyOrder.length - 1]).toBe(keyId("common", "orphan"));
    expect(data.values.get(keyId("common", "title"))!.get("en")).toEqual({ kind: "text", text: "Hello" });
  });

  it('load leaves untranslated th keys absent (not "")', async () => {
    const { data } = await adapter.load(fx("next-nested"), R, opts);
    expect(data.values.get(keyId("common", "nav.about"))!.has("th")).toBe(false);
    expect(data.values.get(keyId("common", "title"))!.has("th")).toBe(true);
  });

  it("flat file shape detected and jsonPath returns [key]", async () => {
    const { files } = await adapter.load(fx("next-flat-crlf"), R, opts);
    const f = files.find((x) => x.locale === "en")!;
    expect(f.shape).toBe("flat");
    expect(f.style).toEqual({ indent: "\t", eol: "\r\n", finalNewline: false });
    expect(adapter.jsonPath(f, "a.title")).toEqual(["a.title"]);
    expect(adapter.jsonPath(f, "new.key")).toEqual(["new.key"]);
  });

  it("edits a literal dotted segment in place", async () => {
    const { files } = await adapter.load(fx("next-nested"), R, opts);
    const f = files.find((x) => x.relPath === "public/locales/en/common.json")!;
    expect(f.shape).toBe("nested");
    expect(adapter.jsonPath(f, "lit.a.b")).toEqual(["lit", "a.b"]);
    expect(adapter.jsonPath(f, "nav.home")).toEqual(["nav", "home"]);
    expect(adapter.jsonPath(f, "brand.new")).toEqual(["brand", "new"]);
  });

  it("literal dotted path is kept for locales lacking the key", async () => {
    const { files } = await adapter.load(fx("next-nested"), R, opts);
    const th = files.find((x) => x.relPath === "public/locales/th/common.json")!;
    expect(adapter.jsonPath(th, "lit.a.b")).toEqual(["lit", "a.b"]);
  });

  it("an ambiguous base file does not decide the project shape", async () => {
    const fs = new MemoryFs({
      "/project/public/locales/en/b.json": '{"pay":"x"}',
      "/project/public/locales/en/a.json": '{"k.l":"x"}',
    });
    const { files } = await adapter.load(fs, R, opts);
    expect(files.find((f) => f.ns === "b")!.shape).toBe("flat");
  });

  it("malformed file is reported and never written", async () => {
    const fs = fx("next-broken");
    const { errors, files, data } = await adapter.load(fs, R, opts);
    expect(errors.map((e) => e.relPath)).toEqual(["public/locales/th/common.json"]);
    expect(files.find((f) => f.relPath === "public/locales/th/common.json")!.readOnly).toBe(true);
    expect(files.find((f) => f.relPath === "public/locales/en/common.json")!.readOnly).toBe(false);
    expect(data.values.get(keyId("common", "title"))!.has("th")).toBe(false);
    expect(data.values.get(keyId("checkout", "pay"))!.get("en")).toBeDefined();
    expect(fs.writes).toEqual([]);
  });

  it("encode returns string for text and raw for complex", () => {
    expect(adapter.encode({ kind: "text", text: "a" })).toBe("a");
    expect(adapter.encode({ kind: "complex", raw: [1] })).toEqual([1]);
  });

  it("non-string leaves load as complex", async () => {
    const fs = new MemoryFs({
      "/project/public/locales/en/c.json": '{"n": 3, "l": ["a"], "s": "x"}',
    });
    const { data } = await adapter.load(fs, R, opts);
    expect(data.values.get(keyId("c", "n"))!.get("en")).toEqual({ kind: "complex", raw: 3 });
    expect(data.values.get(keyId("c", "l"))!.get("en")).toEqual({ kind: "complex", raw: ["a"] });
  });

  it("filePath and newFileStyle", async () => {
    expect(adapter.filePath(opts, "ja", "common")).toBe("public/locales/ja/common.json");
    const { files } = await adapter.load(fx("next-flat-crlf"), R, opts);
    expect(adapter.newFileStyle(files)).toMatchObject({ shape: "flat", style: { indent: "\t", eol: "\r\n" } });
    expect(adapter.newFileStyle([])).toMatchObject({ shape: "nested", style: { indent: "  " } });
  });
});

describe("next-i18next onLocalesChanged", () => {
  it("onLocalesChanged returns snippet and writes nothing", async () => {
    const fs = fx("next-nested");
    const r = await adapter.onLocalesChanged(fs, R, ["en", "th", "ja"]);
    expect(r.configSnippet).toBe("locales: ['en', 'th', 'ja'],");
    expect(fs.writes).toEqual([]);
  });
});
