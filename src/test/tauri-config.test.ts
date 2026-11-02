import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const conf = (name: string) => JSON.parse(readFileSync(resolve(__dirname, "../../src-tauri", name), "utf8"));

describe("Windows bundle config", () => {
  it("builds the NSIS installer only (the MSI is untested) and keeps the llama.cpp DLLs", () => {
    const w = conf("tauri.windows.conf.json");
    expect(w.bundle.targets).toEqual(["nsis"]);
    expect(w.bundle.resources).toEqual({ "llama-dlls/": "" });
    expect(conf("tauri.release.conf.json").bundle.targets).toBeUndefined();
  });
});
