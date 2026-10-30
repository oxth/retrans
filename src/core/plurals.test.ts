import { describe, it, expect } from "vitest";
import { splitPlural, pluralCategories, isApplicable, expandPluralKeys } from "./plurals";
import { keyId, parseKeyId, valuesEqual, type ProjectData } from "./model";

function mk(format: "next-i18next" | "paraglide", keys: string[], locales = ["en", "th", "ru"]): ProjectData {
  return { format, root: "/r", baseLocale: "en", locales, namespaces: [""], keyOrder: keys.map((k) => keyId("", k)), values: new Map() };
}

describe("model", () => {
  it("keyId round trip", () => {
    expect(parseKeyId(keyId("common", "a.b"))).toEqual({ ns: "common", key: "a.b" });
    expect(parseKeyId(keyId("", "a"))).toEqual({ ns: "", key: "a" });
  });
  it("valuesEqual", () => {
    expect(valuesEqual(undefined, undefined)).toBe(true);
    expect(valuesEqual({ kind: "text", text: "a" }, { kind: "text", text: "a" })).toBe(true);
    expect(valuesEqual({ kind: "complex", raw: { a: 1 } }, { kind: "complex", raw: { a: 1 } })).toBe(true);
    expect(valuesEqual({ kind: "text", text: "a" }, { kind: "complex", raw: "a" })).toBe(false);
    expect(valuesEqual({ kind: "text", text: "a" }, undefined)).toBe(false);
  });
});

describe("plurals", () => {
  it("splitPlural", () => {
    expect(splitPlural("cart.items_one")).toEqual({ base: "cart.items", category: "one" });
    expect(splitPlural("user_name")).toBeNull();
  });
  it("pluralCategories", () => {
    expect(pluralCategories("th")).toEqual(["other"]);
    expect(pluralCategories("en")).toEqual(["one", "other"]);
    expect(pluralCategories("ru")).toEqual(["one", "few", "many", "other"]);
  });
  it("isApplicable", () => {
    const d = mk("next-i18next", ["items_one", "items_other", "plain", "solo_one"]);
    expect(isApplicable(d, keyId("", "items_one"), "en")).toBe(true);
    expect(isApplicable(d, keyId("", "items_one"), "th")).toBe(false);
    expect(isApplicable(d, keyId("", "plain"), "th")).toBe(true);
    expect(isApplicable(d, keyId("", "solo_one"), "th")).toBe(true);
    const p = mk("paraglide", ["items_one", "items_other"]);
    expect(isApplicable(p, keyId("", "items_one"), "th")).toBe(true);
  });
  it("expandPluralKeys", () => {
    const d = mk("next-i18next", ["a", "items_one", "items_other", "z"]);
    const out = expandPluralKeys(d);
    expect(out.map((i) => parseKeyId(i).key)).toEqual(["a", "items_one", "items_other", "items_few", "items_many", "z"]);
    expect(d.keyOrder.length).toBe(4);
    expect(expandPluralKeys(mk("paraglide", ["items_one", "items_other"]))).toEqual(mk("paraglide", ["items_one", "items_other"]).keyOrder);
  });
});
