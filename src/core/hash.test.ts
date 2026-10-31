import { describe, it, expect } from "vitest";
import { hashText, hashValue } from "./hash";

describe("hash", () => {
  it("FNV-1a known values", () => {
    expect(hashText("")).toBe("811c9dc5");
    expect(hashText("a")).toBe("e40c292c");
  });
  it("hashValue", () => {
    expect(hashValue(undefined)).toBe("");
    expect(hashValue({ kind: "text", text: "a" })).toBe("e40c292c");
    expect(hashValue({ kind: "complex", raw: [1] })).toBe(hashText("[1]"));
  });
});
