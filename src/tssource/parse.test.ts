import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLocaleModule, type LocaleModule, type TsEntry } from "./parse";

const LOCALES = resolve(__dirname, "../test/fixtures/ts-locales/src/assets/locales");
const read = (name: string) => readFileSync(resolve(LOCALES, name), "utf8");

function load(name: string): { text: string; mod: LocaleModule } {
  const text = read(name);
  const mod = parseLocaleModule(text, name);
  expect(mod).not.toBeNull();
  return { text, mod: mod! };
}

const entry = (mod: LocaleModule, key: string, locale: string): TsEntry | undefined =>
  mod.entries.find((e) => e.key === key && e.locale === locale);

/** Every entry's range slices exactly its source literal, and the literal decodes to its value. */
function expectExactRanges(text: string, mod: LocaleModule) {
  for (const e of mod.entries) {
    const raw = text.slice(e.range[0], e.range[1]);
    if (e.undefinedLiteral) {
      expect(raw).toBe("undefined");
      expect(e.value).toBe("");
      continue;
    }
    expect(raw[0]).toBe(e.quote);
    expect(raw[raw.length - 1]).toBe(e.quote);
    // The raw literals in the fixtures are valid JS string literals.
    expect(new Function(`return ${raw};`)()).toBe(e.value);
  }
  for (const o of [...mod.objects, ...Object.values(mod.pairObjects ?? {})]) {
    expect(text[o.open]).toBe("{");
    expect(text[o.close]).toBe("}");
  }
}

describe("parseLocaleModule", () => {
  it("split style: entries, locales, group", () => {
    const { text, mod } = load("button.tsx");
    expect(mod.style).toBe("split");
    expect(mod.group).toBe("button");
    expect(mod.locales).toEqual(["th", "en"]);
    expect(mod.readOnly).toEqual([]);
    expect(mod.pairObjects).toBeUndefined();
    expect(mod.entries).toHaveLength(8);

    const ok = entry(mod, "button_ok", "en")!;
    expect(ok.value).toBe("OK");
    expect(ok.quote).toBe("'");
    expect(text.slice(ok.range[0], ok.range[1])).toBe("'OK'");
    expect(entry(mod, "button_delete", "en")!.value).toBe("ลบ (EN)");
    expect(entry(mod, "button_delete", "th")!.value).toBe("ลบ");
    expect(entry(mod, "button_reset_password", "en")!.value).toBe("Reset password (EN)");

    expect(mod.objects.map((o) => [o.locale, o.exportName, o.propIndent, o.trailingComma])).toEqual([
      ["th", "buttonTH", "  ", true],
      ["en", "buttonEN", "  ", false],
    ]);
    expectExactRanges(text, mod);
  });

  it("table style via mapLocale", () => {
    const { text, mod } = load("common.ts");
    expect(mod.style).toBe("table");
    expect(mod.group).toBe("common");
    expect(mod.locales).toEqual(["th", "en"]);
    expect(mod.readOnly).toEqual([]);

    // Multi-line pair.
    expect(entry(mod, "support_file_jpg_png", "th")!.value).toBe("รองรับไฟล์ JPG, PNG");
    expect(entry(mod, "support_file_jpg_png", "en")!.value).toBe("Support file JPG, PNG");
    expect(entry(mod, "session_expire_in", "en")!.value).toBe("Session expires in {{minutes}} minutes");
    // `\n` escape decoded to a real newline.
    expect(entry(mod, "support_file_csv_xlsx", "en")!.value).toBe("XLS, XLSX or CSV\n(Maximum 2,000 items)");
    // Double-quoted literal.
    const dq = entry(mod, "change_pw", "en")!;
    expect(dq.quote).toBe('"');
    expect(dq.value).toBe("Change Password");
    expect(text.slice(dq.range[0], dq.range[1])).toBe('"Change Password"');
    // Pair with only th.
    expect(entry(mod, "zone_name", "th")!.value).toBe("ชื่อโซน");
    expect(entry(mod, "zone_name", "en")).toBeUndefined();
    // `th: undefined` is an editable (missing) entry, not a read-only item.
    const und = entry(mod, "only_en", "th")!;
    expect(und).toMatchObject({ value: "", quote: "'", undefinedLiteral: true });
    expect(text.slice(und.range[0], und.range[1])).toBe("undefined");
    expect(entry(mod, "only_en", "en")!.value).toBe("Only EN (EN)");
    expect(entry(mod, "only_en", "en")!.undefinedLiteral).toBeUndefined();

    const zone = mod.pairObjects!.zone_name;
    expect(zone).toBeDefined();
    expect(zone.locale).toBeNull();
    expect(text.slice(zone.open, zone.close + 1)).toBe("{ th: 'ชื่อโซน' }");
    expect(zone.trailingComma).toBe(false);
    const multi = mod.pairObjects!.support_file_jpg_png;
    expect(multi.propIndent).toBe("    ");
    expect(multi.trailingComma).toBe(true);
    expect(Object.keys(mod.pairObjects!)).toEqual([
      "email",
      "support_file_jpg_png",
      "session_expire_in",
      "support_file_csv_xlsx",
      "change_pw",
      "zone_name",
      "only_en",
      "logout",
    ]);

    expect(mod.objects).toHaveLength(1);
    expect(mod.objects[0]).toMatchObject({ locale: null, propIndent: "  ", trailingComma: true });
    expect(text.slice(mod.objects[0].open, mod.objects[0].open + 12)).toBe("{\n  email: {");
    expectExactRanges(text, mod);
  });

  it("export-name prefix may differ from file name", () => {
    const { text, mod } = load("dashboardMaguro.tsx");
    expect(mod.style).toBe("split");
    expect(mod.group).toBe("dashboardMaguro");
    expect(mod.locales).toEqual(["th", "en"]);
    expect(mod.objects.map((o) => o.exportName)).toEqual(["maguroTH", "maguroEN"]);
    expect(entry(mod, "maguro_greeting", "en")!.value).toBe("<0>Hi</0>");
    expectExactRanges(text, mod);
  });

  it("computed values are read-only", () => {
    const { mod } = load("dashboardMaguro.tsx");
    expect(entry(mod, "maguro_brand", "th")).toBeUndefined();
    expect(entry(mod, "maguro_brand", "en")).toBeUndefined();
    expect(mod.readOnly).toEqual([
      { key: "maguro_brand", locale: "th", reason: expect.any(String) },
      { key: "maguro_brand", locale: "en", reason: expect.any(String) },
    ]);

    const src = [
      "const other = { a: 'A' };",
      "const name = 'n';",
      "export const xTH = {",
      "  ident: name,",
      "  call: String(1),",
      "  ...other,",
      "  plainTpl: `plain`,",
      "  'quoted-key': 'ok',",
      "};",
    ].join("\n");
    const m = parseLocaleModule(src, "x.ts")!;
    expect(m.entries.map((e) => [e.key, e.value])).toEqual([["quoted-key", "ok"]]);
    expect(m.readOnly.map((r) => r.key)).toEqual(["ident", "call", "...other", "plainTpl"]);
    for (const r of m.readOnly) expect(r.reason.length).toBeGreaterThan(0);

    const table = [
      "const t = {",
      "  a: { th: 'ก', en: name },",
      "  b: 'not a pair',",
      "};",
      "export const tTH = mapLocale(t, 'th');",
    ].join("\n");
    const tm = parseLocaleModule(table, "t.ts")!;
    expect(tm.style).toBe("table");
    expect(tm.entries.map((e) => [e.key, e.locale, e.value])).toEqual([["a", "th", "ก"]]);
    expect(tm.readOnly).toEqual([
      { key: "a", locale: "en", reason: expect.any(String) },
      { key: "b", reason: expect.any(String) },
    ]);
    expect(Object.keys(tm.pairObjects!)).toEqual(["a"]);
  });

  it("an `undefined` value is a missing entry in both styles", () => {
    const src = "export const xEN = { u: undefined, w: 'W' };";
    const m = parseLocaleModule(src, "x.ts")!;
    expect(m.readOnly).toEqual([]);
    const u = m.entries.find((e) => e.key === "u")!;
    expect(u).toEqual({ key: "u", locale: "en", value: "", range: [24, 33], quote: "'", undefinedLiteral: true });
    expect(src.slice(u.range[0], u.range[1])).toBe("undefined");
  });

  it("helper and non-locale files return null", () => {
    expect(parseLocaleModule(read("mapLocale.ts"), "mapLocale.ts")).toBeNull();
    expect(parseLocaleModule(read("__tests__/mapLocale.test.ts"), "mapLocale.test.ts")).toBeNull();
    expect(parseLocaleModule("export const DEFAULT_URL = { a: 'b' };\nexport const n = 1;", "c.ts")).toBeNull();
    expect(parseLocaleModule("", "empty.ts")).toBeNull();
  });

  it("CRLF file offsets still slice exact literals", () => {
    const { text, mod } = load("change-password.ts");
    expect(text).toContain("\r\n");
    expect(mod.group).toBe("change-password");
    expect(mod.style).toBe("split");
    const e = entry(mod, "change_profile_pw_success_description", "en")!;
    expect(text.slice(e.range[0], e.range[1])).toBe("'Please log in again to continue'");
    expect(entry(mod, "change_pw", "en")!.value).toBe("Change password");
    expect(entry(mod, "change_pw", "th")).toBeUndefined();
    expect(mod.objects[0].propIndent).toBe("  ");
    expectExactRanges(text, mod);
  });

  it("offsets include a leading BOM", () => {
    const text = "\uFEFF" + read("button.tsx");
    const mod = parseLocaleModule(text, "button.tsx")!;
    const ok = entry(mod, "button_ok", "en")!;
    expect(text.slice(ok.range[0], ok.range[1])).toBe("'OK'");
    expectExactRanges(text, mod);
  });

  it("group strips directories and extension; escapes decode like JS", () => {
    const src = "export const aEN = { k: 'it\\'s\\t\\u0e01', d: \"say \\\"hi\\\"\" } as const;";
    const m = parseLocaleModule(src, "src/assets/locales/a-b.tsx")!;
    expect(m.group).toBe("a-b");
    expect(m.locales).toEqual(["en"]);
    expect(m.entries.map((e) => e.value)).toEqual(["it's\t\u0e01", 'say "hi"']);
    expect(parseLocaleModule(src, "C:\\x\\y\\win.ts")!.group).toBe("win");
  });
});
