import { describe, expect, it } from "vitest";
import type { MessageValue, ProjectData } from "./model";
import { cellMeta, recordCleared, recordEdit, recordReviewed, renameInState } from "./status";
import type { StateFile } from "./state-file";

const t = (text: string): MessageValue => ({ kind: "text", text });
const mk = (): ProjectData => ({
  format: "next-i18next", root: "/p", baseLocale: "en", locales: ["en", "th"], namespaces: ["c"],
  keyOrder: ["c::a"],
  values: new Map([["c::a", new Map([["en", t("Hello")], ["th", t("สวัสดี")]])]]),
});
const st = (): StateFile => ({ version: 1, project: { baseLocale: "en" }, entries: {} });

describe("status", () => {
  it("missing value → untranslated", () => {
    const d = mk(); d.values.get("c::a")!.delete("th");
    expect(cellMeta(d, st(), "c::a", "th")).toEqual({ status: "untranslated", needsReview: false, machine: false });
  });
  it("value without entry → translated, not needsReview", () => {
    expect(cellMeta(mk(), st(), "c::a", "th")).toEqual({ status: "translated", needsReview: false, machine: false });
  });
  it("recordEdit stores s=translated, h=hash of base, m only when machine", () => {
    const d = mk(), s = st();
    recordEdit(d, s, "c::a", "th", false);
    expect(s.entries["c::a"].th.m).toBeUndefined();
    expect(s.entries["c::a"].th.s).toBe("translated");
    recordEdit(d, s, "c::a", "th", true);
    expect(s.entries["c::a"].th.m).toBe(true);
    expect(cellMeta(d, s, "c::a", "th").machine).toBe(true);
  });
  it("recordReviewed → reviewed; editing again → translated", () => {
    const d = mk(), s = st();
    recordReviewed(d, s, "c::a", "th");
    expect(cellMeta(d, s, "c::a", "th").status).toBe("reviewed");
    recordEdit(d, s, "c::a", "th", false);
    expect(cellMeta(d, s, "c::a", "th").status).toBe("translated");
  });
  it("base text change → needsReview for others, cleared by recordReviewed", () => {
    const d = mk(), s = st();
    recordEdit(d, s, "c::a", "th", false);
    d.values.get("c::a")!.set("en", t("Hi"));
    expect(cellMeta(d, s, "c::a", "th").needsReview).toBe(true);
    recordReviewed(d, s, "c::a", "th");
    expect(cellMeta(d, s, "c::a", "th").needsReview).toBe(false);
  });
  it("base locale cells never get entries; meta is translated/untranslated with needsReview false", () => {
    const d = mk(), s = st();
    recordEdit(d, s, "c::a", "en", false);
    recordReviewed(d, s, "c::a", "en");
    expect(s.entries).toEqual({});
    expect(cellMeta(d, s, "c::a", "en")).toEqual({ status: "translated", needsReview: false, machine: false });
    d.values.get("c::a")!.delete("en");
    expect(cellMeta(d, s, "c::a", "en").status).toBe("untranslated");
  });
  it("recordCleared and renameInState", () => {
    const d = mk(), s = st();
    recordEdit(d, s, "c::a", "th", false);
    renameInState(s, "c::a", "c::b");
    expect(Object.keys(s.entries)).toEqual(["c::b"]);
    recordCleared(s, "c::b", "th");
    expect(s.entries).toEqual({});
  });
});
