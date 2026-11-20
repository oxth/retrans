import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain Node script, imported for its pure helpers
import { builtFilesMissing, latestVersion, pluginIdProblem, whatsNew } from "../release.mjs";

describe("pluginIdProblem", () => {
  it("accepts the numeric id Figma assigns", () => {
    expect(pluginIdProblem({ id: "1234567890123456789" })).toBeNull();
  });
  it("refuses the placeholder and anything else", () => {
    expect(pluginIdProblem({ id: "retrans-preview" })).toMatch(/placeholder/);
    expect(pluginIdProblem({})).toMatch(/no "id"/);
    expect(pluginIdProblem({ id: "" })).toMatch(/no "id"/);
  });
});

describe("builtFilesMissing", () => {
  it("lists the manifest's main and ui files that don't exist", () => {
    const exists = (p: string) => p.endsWith("code.js");
    expect(builtFilesMissing({ main: "dist/code.js", ui: "dist/ui.html" }, "/plugin", exists)).toEqual(["dist/ui.html"]);
  });
});

describe("whatsNew", () => {
  const changelog = `# Changelog

## [Unreleased]

- Not yet.

## [0.8.0] - 2026-11-20

### What's new

- **Designer preview in Figma.** A designer checks drafts.
- **Live link.** Pair in **Settings → Figma plugin**.

## [0.7.1] - 2026-11-19

- Older.

[0.8.0]: https://github.com/oxth/retrans/releases/tag/v0.8.0
`;
  it("is that version's section as plain text, without Markdown emphasis or headings", () => {
    expect(whatsNew(changelog, "0.8.0")).toBe(
      "What's new\n\n- Designer preview in Figma. A designer checks drafts.\n- Live link. Pair in Settings → Figma plugin.",
    );
  });
  it("is null when the version has no section", () => {
    expect(whatsNew(changelog, "9.9.9")).toBeNull();
  });
});

describe("latestVersion", () => {
  it("is the newest released section, skipping Unreleased", () => {
    expect(latestVersion("# Changelog\n\n## [Unreleased]\n\n- x\n\n## [0.2.0] - 2026-12-01\n\n- y\n\n## [0.1.0] - 2026-11-20\n")).toBe("0.2.0");
  });
  it("is null when nothing is released yet", () => {
    expect(latestVersion("# Changelog\n\n## [Unreleased]\n\n- x\n")).toBeNull();
  });
});
