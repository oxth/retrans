import { describe, expect, it } from "vitest";
import { ProjectSession } from "../core/session";
import { MemoryFs } from "../platform/memory-fs";
import { detectProject } from "./detect";
import { createProject } from "./scaffold";

describe("createProject", () => {
  it("next-i18next creates public/locales/{locale}/common.json as {} and a minimal config", async () => {
    const fs = new MemoryFs({});
    await createProject(fs, { format: "next-i18next", root: "/p", baseLocale: "en", locales: ["en", "th"] });
    expect(await fs.readText("/p/public/locales/en/common.json")).toBe("{}\n");
    expect(await fs.readText("/p/public/locales/th/common.json")).toBe("{}\n");
    expect(await fs.readText("/p/next-i18next.config.js")).toBe(
      "/** @type {import('next-i18next').UserConfig} */\nmodule.exports = {\n  i18n: {\n    defaultLocale: 'en',\n    locales: ['en', 'th'],\n  },\n}\n",
    );
  });

  it("does not overwrite an existing config", async () => {
    const fs = new MemoryFs({ "/p/next-i18next.config.mjs": "export default {}\n" });
    await createProject(fs, { format: "next-i18next", root: "/p", baseLocale: "en", locales: ["th"] });
    expect(await fs.exists("/p/next-i18next.config.js")).toBe(false);
    expect(await fs.readText("/p/next-i18next.config.mjs")).toBe("export default {}\n");
    expect(await fs.exists("/p/public/locales/en/common.json")).toBe(true);
  });

  it("paraglide creates settings.json and messages/{locale}.json with $schema", async () => {
    const fs = new MemoryFs({});
    await createProject(fs, { format: "paraglide", root: "/p", baseLocale: "en", locales: ["th", "en", "th"] });
    const s = await fs.readText("/p/project.inlang/settings.json");
    expect(s.endsWith("}\n")).toBe(true);
    expect(s).toContain('"locales": ["en", "th"]');
    expect(Object.keys(JSON.parse(s))).toEqual([
      "$schema", "baseLocale", "locales", "modules", "plugin.inlang.messageFormat",
    ]);
    expect(JSON.parse(s)["plugin.inlang.messageFormat"]).toEqual({ pathPattern: "./messages/{locale}.json" });
    for (const l of ["en", "th"]) {
      expect(await fs.readText(`/p/messages/${l}.json`)).toBe(
        '{\n  "$schema": "https://inlang.com/schema/inlang-message-format"\n}\n',
      );
    }
  });

  it("created project round-trips through detectProject and ProjectSession.open", async () => {
    for (const format of ["next-i18next", "paraglide"] as const) {
      const fs = new MemoryFs({});
      const d = await createProject(fs, { format, root: "/p", baseLocale: "en", locales: ["en", "th"] });
      expect(d.format).toBe(format);
      expect(d.locales.sort()).toEqual(["en", "th"]);
      expect(await detectProject(fs, "/p")).toEqual(d);
      await ProjectSession.open(fs, "/p", d, { baseLocale: "en", localesPath: d.localesPath });
    }
  });

  it("refuses a folder that already contains a project, and invalid input", async () => {
    const fs = new MemoryFs({});
    await createProject(fs, { format: "paraglide", root: "/p", baseLocale: "en", locales: ["en"] });
    await expect(
      createProject(fs, { format: "next-i18next", root: "/p", baseLocale: "en", locales: ["en"] }),
    ).rejects.toThrow("This folder already contains a translation project");
    const e = new MemoryFs({});
    await expect(createProject(e, { format: "paraglide", root: "/p", baseLocale: "e n!", locales: [] })).rejects.toThrow();
    await expect(
      createProject(e, { format: "paraglide", root: "/p", baseLocale: "en", locales: [], namespace: "a/b" }),
    ).rejects.toThrow();
  });
});
