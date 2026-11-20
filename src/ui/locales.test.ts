import { describe, expect, it } from "vitest";
import { languageWithCode } from "./locales";

describe("languageWithCode", () => {
  it("shows the language's name with its code", () => {
    expect(languageWithCode("th")).toBe("Thai (th)");
    expect(languageWithCode("zh-CN")).toMatch(/^Chinese.* \(zh-CN\)$/);
  });
  it("is just the code when there's no name for it", () => {
    expect(languageWithCode("qaa")).toBe("qaa");
  });
});
