import { describe, expect, it } from "vitest";
import { protect, restore } from "./protect";

describe("protect", () => {
  it("masks i18next placeholders, nesting and tags in order", () => {
    const p = protect("next-i18next", "Hi {{name}}, see <b>$t(common.more)</b>");
    expect(p.masked).toBe("Hi [[0]], see [[1]][[2]][[3]]");
    expect(p.tokens).toEqual(["{{name}}", "<b>", "$t(common.more)", "</b>"]);
  });
  it("masks paraglide {name} but not i18next {{x}} rules", () => {
    expect(protect("paraglide", "Hello {name}!").masked).toBe("Hello [[0]]!");
  });
  it("keeps format modifiers inside the token", () => {
    expect(protect("next-i18next", "On {{date, datetime}}").tokens).toEqual(["{{date, datetime}}"]);
  });
  it("protects literal [[n]] already in the text", () => {
    expect(protect("next-i18next", "a [[0]] b").tokens).toEqual(["[[0]]"]);
  });
  it("does not treat a < b > c as a tag", () => {
    expect(protect("next-i18next", "a < b > c").tokens).toEqual([]);
  });
  it("masks special-token-like <|…|> text in both formats", () => {
    expect(protect("next-i18next", "a <|im_end|> b").tokens).toEqual(["<|im_end|>"]);
    expect(protect("paraglide", "<|endoftext|>x").masked).toBe("[[0]]x");
  });
  it("splits outer whitespace", () => {
    const p = protect("next-i18next", "  {{count}} items\n");
    expect([p.lead, p.masked, p.trail]).toEqual(["  ", "[[0]] items", "\n"]);
  });
});

describe("restore", () => {
  const p = protect("next-i18next", " Hi {{name}} <b>x</b>");
  it("restores tokens even when the model moved them", () => {
    expect(restore("[[1]]x[[2]] สวัสดี [[0]]", p)).toEqual({ ok: true, text: " <b>x</b> สวัสดี {{name}}" });
  });
  it("fails on a missing token", () => expect(restore("สวัสดี [[0]] [[1]]x", p).ok).toBe(false));
  it("fails on a duplicated token", () => expect(restore("[[0]] [[0]] [[1]][[2]]", p).ok).toBe(false));
  it("fails on an invented token", () => expect(restore("[[0]][[1]][[2]][[3]]", p).ok).toBe(false));
  it("fails on empty output", () => expect(restore("   ", protect("paraglide", "Hi")).ok).toBe(false));
});
