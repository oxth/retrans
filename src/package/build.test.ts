import { describe, expect, it } from "vitest";
import { MemoryFs } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { keyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { parseState, STATE_PATH } from "../core/state-file";
import { MANIFEST_PATH, parseManifest, serializeManifest } from "./manifest";
import { buildPackage, ExportError, packageFileName } from "./build";

const R = "/project";
const j = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const NOW = new Date("2026-11-02T10:00:00Z");
const CONFIG = "module.exports = {\r\n  i18n: { defaultLocale: 'en', locales: ['en', 'th', 'ja'] },\r\n};\r\n";

async function open(fs: MemoryFs) {
  const d = (await detectProject(fs, R))!;
  return ProjectSession.open(fs, R, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
}

function nextFs() {
  return new MemoryFs({
    [`${R}/next-i18next.config.js`]: CONFIG,
    [`${R}/public/locales/en/common.json`]: j({ a: "A", b: "B" }),
    [`${R}/public/locales/th/common.json`]: j({ a: "เอ" }),
    [`${R}/public/locales/ja/common.json`]: j({ a: "エー" }),
  });
}

async function prepared(fs = nextFs()) {
  const s = await open(fs);
  s.setText(keyId("common", "b"), "th", "บี");
  s.setText(keyId("common", "a"), "ja", "えー");
  s.setProjectSetting({ id: "proj-1" });
  await s.save();
  return s;
}

describe("buildPackage", () => {
  it("next-i18next: includes base + chosen locales, config copy, filtered state and manifest", async () => {
    const s = await prepared();
    const out = await buildPackage(s, { locales: ["th"], now: NOW });
    expect(out.map((f) => f.path)).toEqual([
      ".retrans/package.json", ".retrans/state.json", "next-i18next.config.js",
      "public/locales/en/common.json", "public/locales/th/common.json",
    ]);
    const get = (p: string) => out.find((f) => f.path === p)!.text;
    expect(get("next-i18next.config.js")).toBe(CONFIG);
    const state = parseState(get(STATE_PATH)).state;
    expect(state.project.id).toBe("proj-1");
    expect(JSON.stringify(state.entries)).not.toContain("ja");
    expect(state.entries[keyId("common", "b")]?.th).toBeDefined();
    const m = parseManifest(get(MANIFEST_PATH))!;
    expect(m.locales).toEqual(["th"]);
    expect(m.sourceProjectId).toBe("proj-1");
    expect(m.exportedAt).toBe(NOW.toISOString());
    expect(m.localesPath).toBe("public/locales");
    expect(m.baseline[keyId("common", "b")]?.th).toBeDefined();
    expect(m.baseline[keyId("common", "a")]?.ja).toBeUndefined();
  });

  it("paraglide: settings.json lists only the included locales and keeps the rest byte-identical", async () => {
    const settings =
      '{\n\t"$schema": "https://inlang.com/schema/project-settings",\n\t"baseLocale": "en",\n\t"locales": ["en", "th", "ja"],\n\t"modules": [],\n\t"plugin.inlang.messageFormat": {\n\t\t"pathPattern": "./messages/{locale}.json"\n\t}\n}\n';
    const fs = new MemoryFs({
      [`${R}/project.inlang/settings.json`]: settings,
      [`${R}/messages/en.json`]: j({ hi: "Hi" }),
      [`${R}/messages/th.json`]: j({ hi: "หวัดดี" }),
      [`${R}/messages/ja.json`]: j({ hi: "やあ" }),
    });
    const s = await open(fs);
    s.setProjectSetting({ id: "p" });
    await s.save();
    const out = await buildPackage(s, { locales: ["th"], now: NOW });
    expect(out.map((f) => f.path)).toEqual([
      ".retrans/package.json", ".retrans/state.json", "messages/en.json", "messages/th.json", "project.inlang/settings.json",
    ]);
    const text = out.find((f) => f.path === "project.inlang/settings.json")!.text;
    expect(text).toBe(settings.replace('["en", "th", "ja"]', '["en", "th"]'));
  });

  it("refuses while dirty, with malformed state, or without a project id", async () => {
    const s = await prepared();
    s.setText(keyId("common", "b"), "th", "changed");
    await expect(buildPackage(s, { locales: ["th"], now: NOW })).rejects.toThrow(new ExportError("Save your changes first."));
    await expect(buildPackage(s, { locales: ["th"], now: NOW })).rejects.toBeInstanceOf(ExportError);

    const noId = await open(nextFs());
    await expect(buildPackage(noId, { locales: ["th"], now: NOW })).rejects.toThrow("Save your changes first.");

    const fs = nextFs();
    await fs.writeTextAtomic(`${R}/${STATE_PATH}`, "{ not json");
    const bad = await open(fs);
    await expect(buildPackage(bad, { locales: ["th"], now: NOW })).rejects.toThrow("Fix .retrans/state.json before exporting.");
  });

  it("re-export from a package project keeps the original baseline and source id", async () => {
    const fs = nextFs();
    const X = { "common::a": { th: { v: "deadbeef", s: "translated" as const } } };
    await fs.writeTextAtomic(`${R}/${MANIFEST_PATH}`, serializeManifest({
      retransPackage: 1, format: "next-i18next", baseLocale: "en", locales: ["th"], localesPath: "public/locales",
      exportedAt: "2026-10-01T00:00:00.000Z", sourceProjectId: "dev-1", baseline: X,
    }));
    const s = await open(fs);
    s.setText(keyId("common", "b"), "th", "บี");
    s.setProjectSetting({ id: "translator-local" });
    await s.save();
    const out = await buildPackage(s, { locales: ["th", "ja"], now: NOW });
    const m = parseManifest(out.find((f) => f.path === MANIFEST_PATH)!.text)!;
    expect(m.baseline).toEqual(X);
    expect(m.sourceProjectId).toBe("dev-1");
    expect(m.exportedAt).toBe(NOW.toISOString());
    expect(m.locales).toEqual(["th"]);
  });

  it("packageFileName", () => {
    expect(packageFileName("shop", new Date("2026-11-02T10:00:00Z"))).toBe("shop-translation-2026-11-02.zip");
  });
});
