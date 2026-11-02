import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadFixtureDir } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { ProjectSession } from "../core/session";
import { comparePlaceholders } from "../core/placeholders";
import { parseState, STATE_PATH } from "../core/state-file";
import { isTranslated } from "../core/model";
import { missingItems, translateMissing } from "../mt/batch";
import { translateText, type MtEngine } from "../mt/translate";

const R = "/project";

/** Fake engine: a fixed Thai string followed by every `[[n]]` token found in the prompt. */
const engine: MtEngine = {
  async generate(r) {
    const tokens = [...new Set(r.prompt.match(/\[\[\d+\]\]/g) ?? [])];
    return ["แปลแล้ว", ...tokens].join(" ");
  },
  async cancel() {},
};

describe("e2e machine translation", () => {
  it("translates every missing th cell, marks it machine, keeps placeholders, leaves other files alone", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "fixtures", "next-nested"));
    const original = fs.snapshot();
    const d = (await detectProject(fs, R))!;
    const s = await ProjectSession.open(fs, R, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });

    const items = missingItems(s, "th", "all");
    expect(items.length).toBeGreaterThan(0);
    const model = { path: "/fake.gguf", template: "translategemma" as const };
    const res = await translateMissing(
      s,
      items,
      "th",
      (text) => translateText(engine, model, s.data.format, s.data.baseLocale, "th", text),
      () => {},
      new AbortController().signal,
    );
    expect(res.translated).toBe(items.length);
    expect(res.unsafe).toEqual([]);
    expect(res.failed).toEqual([]);
    await s.save();

    // every originally missing cell now has a value
    for (const { id } of items) expect(isTranslated(s.value(id, "th"))).toBe(true);

    // state: machine + translated, never reviewed
    const state = parseState(await fs.readText(`${R}/${STATE_PATH}`)).state;
    for (const { id } of items) {
      const e = state.entries[id]?.th;
      expect(e?.m).toBe(true);
      expect(e?.s).toBe("translated");
    }

    // placeholders in saved th JSON equal the base's
    const thCommon = JSON.parse(await fs.readText(`${R}/public/locales/th/common.json`));
    const enCommon = JSON.parse(await fs.readText(`${R}/public/locales/en/common.json`));
    const items1 = { en: enCommon.items_other as string, th: thCommon.items_other as string };
    expect(items1.th).toContain("{{count}}");
    expect(comparePlaceholders(s.data.format, items1.en, items1.th)).toEqual({ missing: [], extra: [] });

    // untouched files are byte-identical
    const after = fs.snapshot();
    for (const p of [`${R}/public/locales/en/common.json`, `${R}/public/locales/en/checkout.json`]) expect(after[p]).toBe(original[p]);
  });
});
