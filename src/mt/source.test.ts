import { describe, expect, it } from "vitest";
import { MemoryFs, loadFixtureDir } from "../platform/memory-fs";
import { resolve } from "node:path";
import { detectProject } from "../formats/detect";
import { keyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { sourceText } from "./source";

const R = "/project";
const c = (k: string) => keyId("common", k);

async function openNext(en: Record<string, string>, ru: Record<string, string>) {
  const j = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
  const fs = new MemoryFs({
    [`${R}/public/locales/en/common.json`]: j(en),
    [`${R}/public/locales/ru/common.json`]: j(ru),
  });
  const d = (await detectProject(fs, R))!;
  return ProjectSession.open(fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
}

describe("sourceText", () => {
  it("uses the base text", async () => {
    const s = await openNext({ title: "Welcome" }, { title: "Добро" });
    expect(sourceText(s, c("title"))).toBe("Welcome");
  });

  it("falls back to the base _other for a target-only plural variant", async () => {
    const s = await openNext(
      { items_one: "{{count}} item", items_other: "{{count}} items" },
      { items_few: "{{count}} предмета" },
    );
    expect(sourceText(s, c("items_few"))).toBe("{{count}} items");
    expect(sourceText(s, c("items_one"))).toBe("{{count}} item");
  });

  it("returns null for missing and whitespace-only base values", async () => {
    const s = await openNext({ blank: "  \n", other_one: "x" }, { gone: "только ru", blank: "" });
    expect(sourceText(s, c("blank"))).toBeNull();
    expect(sourceText(s, c("gone"))).toBeNull();
    expect(sourceText(s, c("nope_few"))).toBeNull();
  });

  it("returns null for complex paraglide messages", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "../test/fixtures/paraglide"));
    const d = (await detectProject(fs, R))!;
    const s = await ProjectSession.open(fs, R, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
    const id = [...s.data.values.keys()].find((k) => k.endsWith("download"))!;
    expect(s.value(id, "en")?.kind).toBe("complex");
    expect(sourceText(s, id)).toBeNull();
    const g = [...s.data.values.keys()].find((k) => k.endsWith("greeting"))!;
    expect(sourceText(s, g)).toBe("Hello {username}! Welcome to {placename}.");
  });
});
