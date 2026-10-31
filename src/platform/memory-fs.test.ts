import { describe, expect, it } from "vitest";
import { joinPath } from "./fs";
import { MemoryFs } from "./memory-fs";

describe("MemoryFs", () => {
  it("writeTextAtomic then readText round-trips", async () => {
    const fs = new MemoryFs();
    await fs.writeTextAtomic("/p/a.json", "hi");
    expect(await fs.readText("/p/a.json")).toBe("hi");
    expect(await fs.exists("/p/a.json")).toBe(true);
  });

  it("readText missing throws NotFound", async () => {
    const fs = new MemoryFs();
    await expect(fs.readText("/nope")).rejects.toMatchObject({ code: "NotFound" });
  });

  it("listFiles throws NotFound for a missing root", async () => {
    await expect(new MemoryFs({ "/r/x.json": "{}" }).listFiles("/nope", 1)).rejects.toMatchObject({ code: "NotFound" });
  });

  it("listFiles returns sorted relative paths and respects maxDepth", async () => {
    const fs = new MemoryFs({ "/r/x.json": "1", "/r/a/b/c.json": "2" });
    expect(await fs.listFiles("/r", 1)).toEqual(["x.json"]);
    expect(await fs.listFiles("/r", 3)).toEqual(["a/b/c.json", "x.json"]);
  });

  it("joinPath normalizes backslashes", () => {
    expect(joinPath("C:\\p", "a/b.json")).toBe("C:/p/a/b.json");
  });

  it("writes records each written path", async () => {
    const fs = new MemoryFs();
    await fs.writeTextAtomic("/a", "1");
    await fs.writeTextAtomic("/b", "2");
    expect(fs.writes).toEqual(["/a", "/b"]);
  });
});
