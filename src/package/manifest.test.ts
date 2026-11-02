import { describe, expect, it } from "vitest";
import { MemoryFs } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { hashValue } from "../core/hash";
import { keyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { parseManifest, serializeManifest, snapshotCells, type PackageManifest } from "./manifest";

const R = "/project";
const j = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const m: PackageManifest = {
  retransPackage: 1, format: "next-i18next", baseLocale: "en", locales: ["th"], localesPath: "public/locales",
  exportedAt: "2026-11-02T00:00:00.000Z", sourceProjectId: "p-1", baseline: {},
};

describe("manifest", () => {
  it("parses a valid manifest and rejects others", () => {
    expect(parseManifest(JSON.stringify(m))).toEqual(m);
    expect(parseManifest(serializeManifest(m))).toEqual(m);
    expect(serializeManifest(m).endsWith("}\n")).toBe(true);
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("{")).toBeNull();
    expect(parseManifest("[]")).toBeNull();
    expect(parseManifest(JSON.stringify({ ...m, retransPackage: 2 }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...m, format: "xliff" }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...m, locales: "th" }))).toBeNull();
  });

  it("snapshots values and statuses for the given locales", async () => {
    const fs = new MemoryFs({
      [`${R}/public/locales/en/common.json`]: j({ a: "A", b: "B" }),
      [`${R}/public/locales/th/common.json`]: j({ a: "เอ" }),
      [`${R}/.retrans/state.json`]: j({
        version: 1, project: {},
        entries: { [keyId("common", "a")]: { th: { s: "reviewed", h: hashValue({ kind: "text", text: "เอ" }), m: true } } },
      }),
    });
    const d = (await detectProject(fs, R))!;
    const session = await ProjectSession.open(fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
    const snap = snapshotCells(session, ["th"]);
    expect(snap[keyId("common", "a")].th).toEqual({ v: hashValue({ kind: "text", text: "เอ" }), s: "reviewed", m: true });
    expect(snap[keyId("common", "b")]).toBeUndefined();
  });
});
