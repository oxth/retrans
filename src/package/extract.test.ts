import { describe, expect, it } from "vitest";
import { MemoryFs } from "../platform/memory-fs";
import { extractPackage, safeEntryPath } from "./extract";

const E = (path: string, text = "{}") => ({ path, text });

describe("safeEntryPath", () => {
  it("accepts normal paths and normalises", () => {
    expect(safeEntryPath("a/b.json")).toBe("a/b.json");
    expect(safeEntryPath("./a/b.json")).toBe("a/b.json");
    expect(safeEntryPath("a\\b.json")).toBe("a/b.json");
    expect(safeEntryPath("a/./b")).toBe("a/b");
    expect(safeEntryPath("././a")).toBe("a");
    expect(safeEntryPath(".retrans/state.json")).toBe(".retrans/state.json");
  });
  it("rejects unsafe paths", () => {
    for (const p of ["", ".", "/abs", "a/", "../x", "a/../x", "a//b", "C:/x", "c:x", "__MACOSX/a", "a/.DS_Store", "a\0b",
      ".git/config", "a/.GIT/x.json", "a/b:c.json", "CON", "con.json", "a/Nul.txt/x.json", "COM1.json", "lpt9", "aux.tar.gz"]) {
      expect(safeEntryPath(p), p).toBeNull();
    }
  });
});

describe("extractPackage", () => {
  it("writes nested files", async () => {
    const fs = new MemoryFs({});
    await extractPackage(fs, [E("public/locales/en/common.json", '{"a":"A"}'), E(".retrans/package.json", "{}")], "/out/p");
    expect(await fs.readText("/out/p/public/locales/en/common.json")).toBe('{"a":"A"}');
    expect(await fs.exists("/out/p/.retrans/package.json")).toBe(true);
  });
  it("skips unsafe entries and writes nothing outside dest", async () => {
    const fs = new MemoryFs({});
    await extractPackage(fs, [E("../evil.json"), E("public/locales/en/c.json")], "/out/p");
    expect(await fs.exists("/out/evil.json")).toBe(false);
    expect(await fs.listFiles("/out", 5)).toEqual(["p/public/locales/en/c.json"]);
  });
  it("refuses a non-empty dest and leaves it untouched", async () => {
    const fs = new MemoryFs({ "/out/p/keep.txt": "x" });
    await expect(extractPackage(fs, [E("public/locales/en/c.json")], "/out/p")).rejects.toThrow("Choose an empty folder.");
    expect(await fs.listFiles("/out/p", 5)).toEqual(["keep.txt"]);
  });
  it("refuses a dest holding only subfolders (a saved package) and leaves it untouched", async () => {
    const fs = new MemoryFs({ "/out/p/messages/th.json": '{"a":"saved"}' });
    await expect(extractPackage(fs, [E("messages/th.json", '{"a":"old"}')], "/out/p")).rejects.toThrow("Choose an empty folder.");
    expect(await fs.readText("/out/p/messages/th.json")).toBe('{"a":"saved"}');
  });
  it("writes only the files a package needs", async () => {
    const fs = new MemoryFs({});
    await extractPackage(fs, [
      E(".retrans/package.json"), E(".retrans/state.json"), E("project.inlang/settings.json"),
      E("project.inlang/README.md", "x"), E("next-i18next.config.js", "c"), E("next-i18next.config.mjs", "c"),
      E("public/locales/en/common.json"), E("messages/en.json"),
      E("run.sh", "x"), E("src/next-i18next.config.js", "x"), E("package.json.exe", "x"), E("a/b.js", "x"),
    ], "/out/p");
    expect(await fs.listFiles("/out/p", 10)).toEqual([
      ".retrans/package.json", ".retrans/state.json", "messages/en.json", "next-i18next.config.js", "next-i18next.config.mjs",
      "project.inlang/README.md", "project.inlang/settings.json", "public/locales/en/common.json",
    ]);
  });
  it("accepts an existing empty-or-missing dest", async () => {
    const fs = new MemoryFs({});
    await extractPackage(fs, [E("messages/en.json")], "/new/dir");
    expect(await fs.exists("/new/dir/messages/en.json")).toBe(true);
  });
  it("refuses entries with no locale file or manifest, writing nothing", async () => {
    const fs = new MemoryFs({});
    await expect(extractPackage(fs, [E("README.txt", "hi")], "/out/p")).rejects.toThrow("This file isn't a Retrans package or project.");
    expect(await fs.exists("/out/p/README.txt")).toBe(false);
    await expect(extractPackage(fs, [E("../public/locales/en/c.json")], "/out/p")).rejects.toThrow("isn't a Retrans package");
  });
});
