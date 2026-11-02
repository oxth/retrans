import { CATALOG, findModel, formatBytes } from "./catalog";
import { expect, it } from "vitest";

it("has exactly one recommended model and pinned https URLs", () => {
  expect(CATALOG.filter((m) => m.recommended).map((m) => m.id)).toEqual(["translategemma-4b"]);
  for (const m of CATALOG) {
    expect(m.url).toBe(`https://huggingface.co/${m.repo}/resolve/${m.url.split("/resolve/")[1].split("/")[0]}/${m.file}`);
    expect(m.url).not.toContain("/resolve/main/");
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.file).toMatch(/^[A-Za-z0-9._-]+\.gguf$/);
  }
});
it("formats sizes", () => {
  expect(formatBytes(2489909312)).toBe("2.49 GB");
  expect(formatBytes(512_000_000)).toBe("512.0 MB");
  expect(findModel("qwen3-8b")?.sizeBytes).toBe(5027783488);
});
