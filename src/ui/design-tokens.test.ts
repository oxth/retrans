import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { btnSecondary, inputCls } from "./Dialog";
import { btnRow, fieldBase } from "./settings-ui";

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

/** The `--c-*` colors declared in the first rule that starts with `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--c-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const themes = { light: tokens(":root {"), dark: tokens(':root[data-theme="dark"] {') };

describe("design tokens", () => {
  it.each(Object.entries(themes))("%s: field borders are at least 3:1 on every surface a field sits on", (_, t) => {
    expect(t["field-line"]).toBeDefined();
    for (const bg of ["surface", "panel", "sunken"]) expect(contrast(t["field-line"], t[bg])).toBeGreaterThanOrEqual(3);
  });

  it.each(Object.entries(themes))("%s: status dots are at least 3:1 on cells, panels and hovered rows", (_, t) => {
    for (const dot of ["st-missing", "st-translated", "st-reviewed"]) {
      for (const bg of ["surface", "panel", "hover"]) expect(contrast(t[dot], t[bg])).toBeGreaterThanOrEqual(3);
    }
  });

  it("dark mode follows the system with the same values as the explicit dark theme", () => {
    expect(tokens(':root:not([data-theme="light"]) {')).toEqual(themes.dark);
  });
});

describe("controls use the tokens", () => {
  it("fields and outlined buttons are bordered with the field color", () => {
    for (const cls of [fieldBase, inputCls, btnRow, btnSecondary]) expect(cls).toContain("border-field-line");
  });

  it("focused fields show the brand ring, not the pale one", () => {
    for (const cls of [fieldBase, inputCls]) {
      expect(cls).toContain("focus:ring-brand");
      expect(cls).not.toContain("focus:ring-brand-line");
    }
  });
});

describe("text sizes scale with Settings → Appearance → Interface size", () => {
  it("no component sets a font size in pixels", () => {
    const dir = resolve(__dirname);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
      .flatMap((f) => [...readFileSync(resolve(dir, f), "utf8").matchAll(/text-\[\d+px\]/g)].map((m) => `${f}: ${m[0]}`));
    expect(offenders).toEqual([]);
  });
});
