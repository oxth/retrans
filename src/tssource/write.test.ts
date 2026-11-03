import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLocaleModule, type LocaleModule, type Quote } from "./parse";
import { applyTsEdits, encodeTsString, i18nSnippet, newTableModule, type TsEdit } from "./write";

const LOCALES = resolve(__dirname, "../test/fixtures/ts-locales/src/assets/locales");
const FILES = ["button.tsx", "common.ts", "dashboardMaguro.tsx", "change-password.ts"];
const read = (name: string) => readFileSync(resolve(LOCALES, name), "utf8");

function load(name: string, text = read(name)): { text: string; mod: LocaleModule } {
  const mod = parseLocaleModule(text, name);
  expect(mod).not.toBeNull();
  return { text, mod: mod! };
}

/** Applies the edits, re-parses, and returns both. */
function edit(name: string, edits: TsEdit[], text = read(name)) {
  const { mod } = load(name, text);
  const out = applyTsEdits(text, mod, edits);
  const after = parseLocaleModule(out, name);
  expect(after).not.toBeNull();
  return { before: text, out, after: after! };
}

/** `{ key: { locale: value } }` of a module's editable entries (undefined literals excluded). */
function values(mod: LocaleModule): Record<string, Record<string, string>> {
  const r: Record<string, Record<string, string>> = {};
  for (const e of mod.entries) {
    if (e.undefinedLiteral) continue;
    (r[e.key] ??= {})[e.locale] = e.value;
  }
  return r;
}

const lines = (s: string) => s.split("\n");

function diffLines(a: string, b: string): number {
  const x = lines(a);
  const y = lines(b);
  expect(y.length).toBe(x.length);
  return x.filter((l, i) => l !== y[i]).length;
}

describe("encodeTsString", () => {
  it("escapes backslash, the quote, newline, tab and CR; leaves the rest", () => {
    expect(encodeTsString(`it's "x" a\\b\n\t\r ไทย \${y} \`t\``, "'")).toBe(
      `'it\\'s "x" a\\\\b\\n\\t\\r ไทย \${y} \`t\`'`,
    );
    expect(encodeTsString(`it's "x"`, '"')).toBe(`"it's \\"x\\""`);
  });
});

describe("applyTsEdits", () => {
  it("no edits → identical text", () => {
    for (const f of FILES) {
      const { text, mod } = load(f);
      expect(applyTsEdits(text, mod, [])).toBe(text);
    }
  });

  it("one set → one-line diff", () => {
    const { before, out, after } = edit("button.tsx", [
      { kind: "set", key: "button_ok", locale: "en", value: "Okay" },
    ]);
    expect(diffLines(before, out)).toBe(1);
    expect(out).toContain("  button_ok: 'Okay'\n};");
    expect(values(after).button_ok.en).toBe("Okay");
  });

  it("set keeps a double-quoted literal double-quoted", () => {
    const { out, after } = edit("common.ts", [
      { kind: "set", key: "change_pw", locale: "en", value: "Change it" },
    ]);
    expect(out).toContain(`en: "Change it" }`);
    expect(values(after).change_pw.en).toBe("Change it");
  });

  it("awkward text round-trips", () => {
    const awkward = ["it's", 'say "hi"', "a\\b", "line1\nline2", "${x}", "`tick`", "tab\there", "cr\r\nlf"];
    // button_ok/en is single-quoted, change_pw/en is double-quoted.
    const targets: Array<[string, string, string, Quote]> = [
      ["button.tsx", "button_ok", "en", "'"],
      ["common.ts", "change_pw", "en", '"'],
    ];
    for (const [file, key, locale, quote] of targets) {
      expect(load(file).mod.entries.find((e) => e.key === key && e.locale === locale)!.quote).toBe(quote);
      for (const v of awkward) {
        const { after } = edit(file, [{ kind: "set", key, locale, value: v }]);
        expect(values(after)[key][locale]).toBe(v);
      }
    }
  });

  it("set on an `undefined` value writes a single-quoted literal", () => {
    const { out, after } = edit("common.ts", [
      { kind: "set", key: "only_en", locale: "th", value: "เฉพาะ" },
    ]);
    expect(out).toContain("  only_en: { th: 'เฉพาะ', en: 'Only EN (EN)' },\n");
    expect(values(after).only_en.th).toBe("เฉพาะ");
  });

  it("add in split style goes into every language object, comma fixed", () => {
    const { before, out, after } = edit("button.tsx", [
      { kind: "add", key: "button_cancel", values: { th: "ยกเลิก", en: "Cancel" } },
      { kind: "add", key: "button-x", values: { th: "x" } },
    ]);
    expect(out).toBe(
      before
        .replace("  button_ok: 'ตกลง',\n};", "  button_ok: 'ตกลง',\n  button_cancel: 'ยกเลิก',\n  'button-x': 'x',\n};")
        .replace("  button_ok: 'OK'\n};", "  button_ok: 'OK',\n  button_cancel: 'Cancel',\n};"),
    );
    const v = values(after);
    expect(v.button_cancel).toEqual({ th: "ยกเลิก", en: "Cancel" });
    expect(v["button-x"]).toEqual({ th: "x" });
    expect(v.button_ok).toEqual({ th: "ตกลง", en: "OK" });
  });

  it("add and set-missing-language in table style", () => {
    const { before, out, after } = edit("common.ts", [
      { kind: "add", key: "new_key", values: { th: "ใหม่", en: "New" } },
      { kind: "add", key: "th_only", values: { th: "ไทย", en: "" } },
      // single-line pair → inline
      { kind: "set", key: "zone_name", locale: "en", value: "Zone name" },
    ]);
    expect(out).toBe(
      before
        .replace("  zone_name: { th: 'ชื่อโซน' },", "  zone_name: { th: 'ชื่อโซน', en: 'Zone name' },")
        .replace(
          "  logout: { th: 'ออกจากระบบ', en: 'Logout' },\n};",
          "  logout: { th: 'ออกจากระบบ', en: 'Logout' },\n  new_key: { th: 'ใหม่', en: 'New' },\n  th_only: { th: 'ไทย' },\n};",
        ),
    );
    const v = values(after);
    expect(v.new_key).toEqual({ th: "ใหม่", en: "New" });
    expect(v.th_only).toEqual({ th: "ไทย" });
    expect(v.zone_name).toEqual({ th: "ชื่อโซน", en: "Zone name" });
  });

  it("set-missing-language in a multi-line table pair goes on a new line", () => {
    const text = read("common.ts").replace("    en: 'Support file JPG, PNG',\n", "");
    const { out, after } = edit("common.ts", [
      { kind: "set", key: "support_file_jpg_png", locale: "en", value: "JPG/PNG" },
    ], text);
    expect(out).toBe(read("common.ts").replace("'Support file JPG, PNG'", "'JPG/PNG'"));
    expect(values(after).support_file_jpg_png.en).toBe("JPG/PNG");
  });

  it("remove deletes the key everywhere and leaves the rest byte-identical", () => {
    const split = edit("button.tsx", [{ kind: "remove", key: "button_delete" }]);
    expect(split.out).toBe(
      split.before.replace("  button_delete: 'ลบ',\n", "").replace("  button_delete: 'ลบ (EN)',\n", ""),
    );
    expect(values(split.after).button_delete).toBeUndefined();

    // Last property without a trailing comma: the object keeps its no-trailing-comma style.
    const last = edit("button.tsx", [{ kind: "remove", key: "button_ok" }]);
    expect(last.out).toBe(
      last.before
        .replace("  button_ok: 'ตกลง',\n", "")
        .replace("  button_reset_password: 'Reset password (EN)',\n  button_ok: 'OK'\n", "  button_reset_password: 'Reset password (EN)'\n"),
    );

    const table = edit("common.ts", [
      { kind: "remove", key: "support_file_jpg_png" },
      { kind: "remove", key: "zone_name" },
    ]);
    expect(table.out).toBe(
      table.before
        .replace("  support_file_jpg_png: {\n    th: 'รองรับไฟล์ JPG, PNG',\n    en: 'Support file JPG, PNG',\n  },\n", "")
        .replace("  zone_name: { th: 'ชื่อโซน' },\n", ""),
    );
    expect(Object.keys(values(table.after))).not.toContain("zone_name");

    // A value on the line after its key goes too.
    const cp = edit("change-password.ts", [{ kind: "remove", key: "change_profile_pw_success_description" }]);
    expect(cp.out).not.toContain("change_profile_pw_success_description");
    expect(cp.out).not.toContain("Please log in again");
    expect(cp.out).toBe(cp.before.replace(/.*success_description:\r\n.*\r\n/g, ""));
  });

  it("CRLF preserved", () => {
    const { before, out, after } = edit("change-password.ts", [
      { kind: "set", key: "current_pw", locale: "en", value: "Now" },
      { kind: "add", key: "new_pw", values: { th: "ใหม่", en: "New" } },
      { kind: "remove", key: "change_profile_pw_title" },
    ]);
    expect(before).toContain("\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    expect(out).toContain("  change_pw: 'Change password',\r\n  new_pw: 'New',\r\n};\r\n");
    const v = values(after);
    expect(v.current_pw.en).toBe("Now");
    expect(v.new_pw).toEqual({ th: "ใหม่", en: "New" });
    expect(v.change_profile_pw_title).toBeUndefined();
  });

  it("keeps a BOM", () => {
    const { out } = edit("button.tsx", [{ kind: "set", key: "button_ok", locale: "en", value: "Y" }], "﻿" + read("button.tsx"));
    expect(out.startsWith("﻿")).toBe(true);
  });

  it("refuses to edit a read-only value", () => {
    const { text, mod } = load("dashboardMaguro.tsx");
    expect(() => applyTsEdits(text, mod, [{ kind: "set", key: "maguro_brand", locale: "en", value: "x" }])).toThrow();
  });
});

describe("newTableModule / i18nSnippet", () => {
  it("newTableModule output parses as a table module with the given values", () => {
    const vals = {
      report_title: { th: "รายงาน", en: "Report" },
      "report-x": { th: "it's", en: "a\nb" },
      th_only: { th: "ไทย" },
    };
    const text = newTableModule("report", vals, ["th", "en"]);
    expect(text).toBe(
      [
        "import { mapLocale } from '@/assets/locales/mapLocale';",
        "",
        "const report = {",
        "  report_title: { th: 'รายงาน', en: 'Report' },",
        "  'report-x': { th: 'it\\'s', en: 'a\\nb' },",
        "  th_only: { th: 'ไทย' },",
        "};",
        "",
        "export const reportTH = mapLocale(report, 'th');",
        "export const reportEN = mapLocale(report, 'en');",
        "",
      ].join("\n"),
    );
    const mod = parseLocaleModule(text, "report.ts")!;
    expect(mod.style).toBe("table");
    expect(mod.group).toBe("report");
    expect(mod.locales).toEqual(["th", "en"]);
    expect(values(mod)).toEqual(vals);
  });

  it("i18nSnippet", () => {
    expect(i18nSnippet(["report"], ["th", "en"])).toBe(
      [
        "import { reportTH, reportEN } from '@/assets/locales/report';",
        "",
        "// resources.th.translation:",
        "...reportTH,",
        "",
        "// resources.en.translation:",
        "...reportEN,",
        "",
      ].join("\n"),
    );
  });
});
