import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { keyId } from "../core/model";
import { setAt } from "../core/json-text";
import { paraglideAdapter as adapter } from "./paraglide";

const fx = () => loadFixtureDir(resolve(__dirname, "../test/fixtures/paraglide"));
const R = "/project";
const opts = { baseLocale: "en", localesPath: "messages/{locale}.json" };

describe("paraglide", () => {
  it("detect reads baseLocale/locales/pathPattern", async () => {
    const r = await adapter.detect(fx(), R);
    expect(r).toMatchObject({
      format: "paraglide",
      baseLocale: "en",
      locales: ["en", "th"],
      namespaces: [""],
      localesPath: "messages/{locale}.json",
      keyCount: 3,
    });
  });

  it("$schema is not a key and is preserved after an edit", async () => {
    const fs = fx();
    const { data, files } = await adapter.load(fs, R, opts);
    expect(data.keyOrder.some((k) => k.includes("$schema"))).toBe(false);
    const th = files.find((f) => f.locale === "th")!;
    const out = setAt(th.text, adapter.jsonPath(th, "greeting"), "x", th.style);
    expect(out).toContain('"$schema": "https://inlang.com/schema/inlang-message-format"');
  });

  it("array value loads as complex and round-trips untouched", async () => {
    const { data, files } = await adapter.load(fx(), R, opts);
    const v = data.values.get(keyId("", "download"))!.get("en")!;
    expect(v.kind).toBe("complex");
    const en = files.find((f) => f.locale === "en")!;
    expect(adapter.encode(v)).toEqual(JSON.parse(en.text).download);
    const out = setAt(en.text, adapter.jsonPath(en, "greeting"), "Hi", en.style);
    expect(out).toContain('"platform=*, userGender=*": "The person has to download the app."');
  });

  it("nested message object becomes dotted keys", async () => {
    const { data, files } = await adapter.load(fx(), R, opts);
    expect(data.keyOrder).toEqual([
      keyId("", "greeting"),
      keyId("", "nesting.level1.level2.level3"),
      keyId("", "download"),
    ]);
    expect(data.values.get(keyId("", "nesting.level1.level2.level3"))!.get("en")).toEqual({
      kind: "text", text: "This is a nested message.",
    });
    expect(files[0].locale).toBe("en");
  });

  it("missing locale file is treated as empty; malformed one is read-only", async () => {
    const snap = fx().snapshot();
    snap["/project/project.inlang/settings.json"] = snap["/project/project.inlang/settings.json"].replace('"th"]', '"th", "de", "fr"]');
    snap["/project/messages/fr.json"] = "{ nope";
    const { data, files, errors } = await adapter.load(new MemoryFs(snap), R, opts);
    expect(data.locales).toEqual(["en", "th", "de", "fr"]);
    expect(files.find((f) => f.locale === "de")).toBeUndefined();
    expect(files.find((f) => f.locale === "fr")!.readOnly).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("onLocalesChanged updates only the locales array in settings.json", async () => {
    const fs = fx();
    const p = "/project/project.inlang/settings.json";
    const before = await fs.readText(p);
    const res = await adapter.onLocalesChanged(fs, R, ["en", "th", "de"]);
    expect(res).toEqual({ written: ["project.inlang/settings.json"] });
    const after = await fs.readText(p);
    expect(after).toBe(before.replace('["en", "th"]', '["en", "th", "de"]'));
    fs.writes.length = 0;
    expect(await adapter.onLocalesChanged(fs, R, ["en", "th", "de"])).toEqual({});
    expect(fs.writes).toEqual([]);
  });

  it("filePath substitutes {locale} into pathPattern", () => {
    expect(adapter.filePath(opts, "th", "")).toBe("messages/th.json");
  });

  it("newFileStyle carries the $schema prefix", async () => {
    const { files } = await adapter.load(fx(), R, opts);
    const s = adapter.newFileStyle(files);
    expect(s.prefix).toEqual({ $schema: "https://inlang.com/schema/inlang-message-format" });
    expect(s.style.indent).toBe("\t");
  });

  it("detect throws on malformed settings.json, null when missing", async () => {
    await expect(adapter.detect(new MemoryFs({ "/project/project.inlang/settings.json": "{" }), R)).rejects.toThrow(
      "project.inlang/settings.json is not valid JSON",
    );
    expect(await adapter.detect(new MemoryFs({ "/project/a": "x" }), R)).toBeNull();
  });

  it("onLocalesChanged edits only the top-level locales even if a nested one comes first", async () => {
    const t = '{\n\t"x": { "locales": ["a"] },\n\t"baseLocale": "en",\n\t"locales": ["en","th"]\n}\n';
    const fs = new MemoryFs({ "/project/project.inlang/settings.json": t });
    await adapter.onLocalesChanged(fs, R, ["en", "th", "de"]);
    expect(await fs.readText("/project/project.inlang/settings.json")).toBe(
      t.replace('["en","th"]', '["en","th","de"]'),
    );
  });

  it("array pathPattern uses the first entry", async () => {
    const s = JSON.stringify({
      baseLocale: "en",
      locales: ["en"],
      "plugin.inlang.messageFormat": { pathPattern: ["./a/{locale}.json", "./b/{locale}.json"] },
    });
    const r = await adapter.detect(new MemoryFs({ "/project/project.inlang/settings.json": s }), R);
    expect(r!.localesPath).toBe("a/{locale}.json");
  });
});
