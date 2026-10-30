import { describe, it, expect } from "vitest";
import { extractPlaceholders, comparePlaceholders } from "./placeholders";

describe("placeholders", () => {
  it("next-i18next", () => {
    expect(extractPlaceholders("next-i18next", "Hi {{name}}, {{ date, datetime }} $t(common.ok)")).toEqual(["$t(common.ok)", "date", "name"]);
  });
  it("paraglide", () => {
    expect(extractPlaceholders("paraglide", "Hi {name} {count}")).toEqual(["count", "name"]);
  });
  it("compare", () => {
    expect(comparePlaceholders("paraglide", "Hi {name}", "Hi {amount}")).toEqual({ missing: ["name"], extra: ["amount"] });
    expect(comparePlaceholders("paraglide", "{a} {a}", "{a}")).toEqual({ missing: ["a"], extra: [] });
  });
  it("unescaped {{- name}}", () => {
    expect(extractPlaceholders("next-i18next", "{{- name}} {{-other}}")).toEqual(["name", "other"]);
  });
});
