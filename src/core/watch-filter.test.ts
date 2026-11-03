import { describe, expect, it } from "vitest";
import { isRelevantChange } from "./watch-filter";

describe("isRelevantChange (#5)", () => {
  const next = (paths: string[], root = "/p", localesPath = "public/locales") =>
    isRelevantChange(paths, { root, format: "next-i18next", localesPath });
  const para = (paths: string[], localesPath = "messages/{locale}.json") =>
    isRelevantChange(paths, { root: "/p", format: "paraglide", localesPath });

  it("next-i18next: only the locales dir and the state file", () => {
    expect(next(["/p/src/app.tsx"])).toBe(false);
    expect(next(["/p/.next/cache/x.json"])).toBe(false);
    expect(next(["/p/public/localesX/en/a.json"])).toBe(false);
    expect(next(["/p/src/app.tsx", "/p/public/locales/th/common.json"])).toBe(true);
    expect(next(["/p/public/locales"])).toBe(true);
    expect(next(["/p/public"])).toBe(true); // an ancestor moved/removed
    expect(next(["/p/.retrans/state.json"])).toBe(true);
    expect(next(["/p/.retrans/other.json"])).toBe(false);
    expect(next(["/p/project.inlang/settings.json"])).toBe(true);
    expect(next([])).toBe(false);
  });

  it("paraglide: the directory before {locale}, settings.json and state.json", () => {
    expect(para(["/p/messages/de.json"])).toBe(true);
    expect(para(["/p/src/lib/paraglide/messages.js"])).toBe(false);
    expect(para(["/p/project.inlang/settings.json"])).toBe(true);
    expect(para(["/p/i18n/de/msgs.json"], "i18n/{locale}/msgs.json")).toBe(true);
    expect(para(["/p/de.json"], "{locale}.json")).toBe(true);
    expect(para(["/p/src/x.json"], "{locale}.json")).toBe(false); // top-level *.json would match
  });

  it("normalizes Windows paths; drive letters compare case-insensitively", () => {
    const w = (paths: string[]) =>
      isRelevantChange(paths, { root: "C:\\work\\p", format: "next-i18next", localesPath: "public/locales" });
    expect(w(["c:/work/p/public/locales/en/common.json"])).toBe(true);
    expect(w(["C:\\work\\p\\public\\locales\\en\\common.json"])).toBe(true);
    expect(w(["C:/work/p/src/x.ts"])).toBe(false);
    expect(next(["/p//public/locales/en/a.json"], "/p/")).toBe(true);
  });
});
