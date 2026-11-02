import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { detectProject } from "./detect";

const fx = (n: string) => loadFixtureDir(resolve(__dirname, "../test/fixtures", n));

describe("detectProject", () => {
  it("picks paraglide when project.inlang exists, next-i18next otherwise, null for empty folder", async () => {
    expect((await detectProject(fx("paraglide"), "/project"))!.format).toBe("paraglide");
    expect((await detectProject(fx("next-nested"), "/project"))!.format).toBe("next-i18next");
    expect(await detectProject(new MemoryFs({}), "/project")).toBeNull();
  });
});

describe("detectProject with a package manifest", () => {
  const manifest = (over: object = {}) =>
    JSON.stringify({
      retransPackage: 1, format: "next-i18next", baseLocale: "en", locales: ["th"],
      localesPath: "public/locales", exportedAt: "2026-11-02T00:00:00.000Z", sourceProjectId: "p", baseline: {}, ...over,
    });

  it("uses the manifest baseLocale when detection could not find one", async () => {
    const fs = new MemoryFs({
      "/p/public/locales/en/common.json": '{"a":"A"}',
      "/p/public/locales/th/common.json": '{"a":"ก"}',
      "/p/.retrans/package.json": manifest(),
    });
    const d = await detectProject(fs, "/p");
    expect(d?.format).toBe("next-i18next");
    expect(d?.baseLocale).toBe("en");
  });
  it("ignores a manifest baseLocale that is not among the locales", async () => {
    const fs = new MemoryFs({
      "/p/public/locales/en/common.json": '{"a":"A"}',
      "/p/.retrans/package.json": manifest({ baseLocale: "fr" }),
    });
    expect((await detectProject(fs, "/p"))?.baseLocale).toBeNull();
  });
  it("throws when the manifest points at a missing layout", async () => {
    const fs = new MemoryFs({ "/p/.retrans/package.json": manifest({ format: "paraglide" }) });
    await expect(detectProject(fs, "/p")).rejects.toThrow("This file isn't a Retrans package or project.");
  });
  it("ignores an invalid manifest and behaves as before", async () => {
    const fs = new MemoryFs({ "/p/public/locales/en/c.json": '{"a":"A"}', "/p/.retrans/package.json": "nope" });
    expect((await detectProject(fs, "/p"))?.format).toBe("next-i18next");
  });
  it("paraglide without a manifest is unchanged", async () => {
    const d = await detectProject(fx("paraglide"), "/project");
    expect(d?.format).toBe("paraglide");
    expect(d?.baseLocale).toBeTruthy();
  });
});
