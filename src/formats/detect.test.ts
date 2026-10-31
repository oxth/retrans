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
