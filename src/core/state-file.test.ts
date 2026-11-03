import { describe, expect, it } from "vitest";
import type { ProjectData } from "./model";
import { parseState, reconcile, serializeState, type StateFile } from "./state-file";

const fb = { baseLocale: "en" };

describe("state-file", () => {
  it("round-trips project.id through state.json and reconcile", () => {
    const { state } = parseState('{"version":1,"project":{"id":"p-1"},"entries":{}}');
    expect(state.project.id).toBe("p-1");
    expect(serializeState(state)).toContain('"id": "p-1"');
    const data = { baseLocale: "en", locales: ["en"], keyOrder: [], values: new Map() } as unknown as ProjectData;
    expect(reconcile(state, data).project.id).toBe("p-1");
  });
  it("serializeState is stable and sorted", () => {
    const a: StateFile = { version: 1, project: fb, entries: { "b::x": { th: { s: "translated", h: "1" } }, "a::y": { th: { s: "reviewed", h: "2" }, fr: { s: "translated", h: "3", m: true } } } };
    const b: StateFile = { entries: { "a::y": { fr: { m: true, h: "3", s: "translated" }, th: { h: "2", s: "reviewed" } }, "b::x": { th: { h: "1", s: "translated" } } }, project: fb, version: 1 };
    expect(serializeState(a)).toBe(serializeState(b));
    const out = serializeState(a);
    expect(out.endsWith("}\n")).toBe(true);
    expect(out.indexOf("a::y")).toBeLessThan(out.indexOf("b::x"));
    expect(out).toContain('\n  "entries"');
  });
  it("parseState reports invalid JSON as an error with an empty state", () => {
    const bad = parseState("{nope");
    expect(bad.state).toEqual({ version: 1, project: {}, entries: {} });
    expect(bad.error).toBeTruthy();
    expect(parseState(null)).toEqual({ state: { version: 1, project: {}, entries: {} } });
    expect(parseState('{"version":2,"entries":{"a":{}}}').state.entries).toEqual({});
  });
  it("parseState reads a valid file; project holds only what the file says", () => {
    const { state: s, error } = parseState('{"version":1,"project":{"localesPath":"x"},"entries":{"a::k":{"th":{"s":"reviewed","h":"1"}}}}');
    expect(error).toBeUndefined();
    expect(s.project).toEqual({ localesPath: "x" });
    expect(s.entries["a::k"].th.s).toBe("reviewed");
  });
  it("reconcile prunes deleted keys and removed locales", () => {
    const data: ProjectData = {
      format: "next-i18next", root: "/p", baseLocale: "en", locales: ["en", "th"], namespaces: ["a"], keyOrder: ["a::k"],
      values: new Map([["a::k", new Map([["en", { kind: "text" as const, text: "x" }], ["th", { kind: "text" as const, text: "y" }]])]]),
    };
    const s: StateFile = { version: 1, project: fb, entries: {
      "a::k": { th: { s: "translated", h: "1" }, fr: { s: "translated", h: "1" }, en: { s: "translated", h: "1" } },
      "a::gone": { th: { s: "translated", h: "1" } },
    } };
    const r = reconcile(s, data);
    expect(r.entries).toEqual({ "a::k": { th: { s: "translated", h: "1" } } });
    expect(s.entries["a::gone"]).toBeDefined();
  });
});
