import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { keyId } from "../core/model";
import { MemoryFs, loadFixtureDir } from "../platform/memory-fs";
import { findLocalesDir, importTsLocales, isMarker } from "./import";

const FIXTURE = resolve(__dirname, "../test/fixtures/ts-locales");
const R = "/project";
const DIR = "src/assets/locales";

const load = () => importTsLocales(loadFixtureDir(FIXTURE, R), R, DIR, "th");

describe("isMarker", () => {
  it("matches a trailing ` (XX)` for the cell's own locale only", () => {
    expect(isMarker("ลบ (EN)", "en")).toBe(true);
    expect(isMarker("Reset password (EN)  ", "en")).toBe(true);
    expect(isMarker("Age (JA)", "ja")).toBe(true);
    expect(isMarker("Age (EN)", "ja")).toBe(false);
    expect(isMarker("Age(EN)", "en")).toBe(false);
    expect(isMarker("Age (en)", "en")).toBe(false);
    expect(isMarker("OK", "en")).toBe(false);
  });
});

describe("findLocalesDir", () => {
  it("finds src/assets/locales from the project root", async () => {
    expect(await findLocalesDir(loadFixtureDir(FIXTURE, R), R)).toBe("src/assets/locales");
  });

  it("checks candidates in order and needs a real locale module", async () => {
    const mod = "export const aEN = { k: 'v' };";
    const fs = new MemoryFs({
      [`${R}/src/assets/locales/mapLocale.ts`]: "export function mapLocale() {}",
      [`${R}/src/locales/__tests__/a.ts`]: mod,
      [`${R}/src/i18n/a.ts`]: mod,
      [`${R}/locales/a.ts`]: mod,
    });
    expect(await findLocalesDir(fs, R)).toBe("src/i18n");
    expect(await findLocalesDir(new MemoryFs({ [`${R}/src/x.ts`]: mod }), R)).toBeNull();
  });
});

describe("importTsLocales", () => {
  it("imports both styles into one model", async () => {
    const imp = await load();
    expect(imp.values.get("button::button_ok")?.get("en")).toEqual({ kind: "text", text: "OK" });
    expect(imp.values.get("button::button_ok")?.get("th")).toEqual({ kind: "text", text: "ตกลง" });
    expect(imp.values.get("common::email")?.get("th")).toEqual({ kind: "text", text: "อีเมล" });
    expect(imp.values.get("common::email")?.get("en")).toEqual({ kind: "text", text: "Email" });
    expect(imp.locales).toEqual(["th", "en"]);
    expect([...imp.modules.keys()]).toEqual([
      "src/assets/locales/button.tsx",
      "src/assets/locales/change-password.ts",
      "src/assets/locales/common.ts",
      "src/assets/locales/dashboardMaguro.tsx",
    ]);
    const m = imp.modules.get("src/assets/locales/common.ts")!;
    expect(m.relPath).toBe("src/assets/locales/common.ts");
    expect(m.module.style).toBe("table");
    expect(m.text).toContain("mapLocale(common, 'th')");
    expect(imp.errors).toEqual([]);
  });

  it("keyOrder follows file path order, then source order", async () => {
    const imp = await load();
    expect(imp.keyOrder).toEqual(
      [
        ["button", "button_save"],
        ["button", "button_delete"],
        ["button", "button_reset_password"],
        ["button", "button_ok"],
        ["change-password", "change_profile_pw_title"],
        ["change-password", "current_pw"],
        ["change-password", "change_profile_pw_success_description"],
        ["change-password", "change_pw"],
        ["common", "email"],
        ["common", "support_file_jpg_png"],
        ["common", "session_expire_in"],
        ["common", "support_file_csv_xlsx"],
        ["common", "change_pw"],
        ["common", "zone_name"],
        ["common", "only_en"],
        ["common", "logout"],
        ["dashboardMaguro", "maguro_dash_title"],
        ["dashboardMaguro", "maguro_greeting"],
        ["dashboardMaguro", "maguro_brand"],
      ].map(([g, k]) => keyId(g, k)),
    );
    // Deterministic across runs.
    expect((await load()).keyOrder).toEqual(imp.keyOrder);
  });

  it("marker cells are missing; drafts only for real drafts", async () => {
    const imp = await load();
    const del = keyId("button", "button_delete");
    expect(imp.values.get(del)?.get("en")).toBeUndefined();
    expect(imp.values.get(del)?.get("th")).toEqual({ kind: "text", text: "ลบ" });
    expect(imp.markers[del]).toEqual({ en: "ลบ (EN)" });
    expect(imp.drafts[del]).toBeUndefined();

    const reset = keyId("button", "button_reset_password");
    expect(imp.values.get(reset)?.get("en")).toBeUndefined();
    expect(imp.markers[reset]).toEqual({ en: "Reset password (EN)" });
    expect(imp.drafts[reset]?.en).toBe("Reset password");

    // Only marker cells are recorded.
    expect(Object.keys(imp.markers).sort()).toEqual([del, reset, keyId("common", "only_en")].sort());
    expect(Object.keys(imp.drafts).sort()).toEqual([reset, keyId("common", "only_en")].sort());
  });

  it("draft comparison trims whitespace and handles markers in other locales", async () => {
    const fs = new MemoryFs({
      [`${R}/loc/a.ts`]: [
        "export const aTH = { same: ' ข้อ ', diff: 'ข้อ', none: 'x' };",
        "export const aEN = { same: 'ข้อ  (EN)', diff: 'Text (EN)', none: 'Y' };",
        "export const aJA = { same: 'ข้อ (JA)', diff: 'Text (EN)' };",
      ].join("\n"),
    });
    const imp = await importTsLocales(fs, R, "loc", "th");
    expect(imp.locales).toEqual(["th", "en", "ja"]);
    expect(imp.markers["a::same"]).toEqual({ en: "ข้อ  (EN)", ja: "ข้อ (JA)" });
    expect(imp.drafts["a::same"]).toBeUndefined();
    expect(imp.drafts["a::diff"]).toEqual({ en: "Text" });
    // ` (EN)` in the ja column is not a ja marker: it is a real value.
    expect(imp.values.get("a::diff")?.get("ja")).toEqual({ kind: "text", text: "Text (EN)" });
    expect(imp.markers["a::none"]).toBeUndefined();
  });

  it("an `undefined` value is a missing cell with no marker and no baseline entry", async () => {
    const imp = await load();
    const id = keyId("common", "only_en");
    expect(imp.values.get(id)?.get("th")).toBeUndefined();
    expect(imp.markers[id]).toEqual({ en: "Only EN (EN)" });
    expect(imp.drafts[id]).toEqual({ en: "Only EN" });
    expect(imp.baseline[id]).toEqual({ en: "Only EN (EN)" });
    expect(imp.readOnly.map((r) => r.id)).not.toContain(id);
  });

  it("duplicates are reported", async () => {
    const imp = await load();
    expect(imp.duplicates).toEqual(["change_pw"]);
    expect(imp.values.get("common::change_pw")?.get("en")).toEqual({ kind: "text", text: "Change Password" });
    expect(imp.values.get("change-password::change_pw")?.get("en")).toEqual({
      kind: "text",
      text: "Change password",
    });
  });

  it("ignores helper and tests", async () => {
    const fs = loadFixtureDir(FIXTURE, R);
    await fs.writeTextAtomic(`${R}/${DIR}/extra.test.ts`, "export const extraEN = { k: 'v' };");
    await fs.writeTextAtomic(`${R}/${DIR}/extra.spec.tsx`, "export const extra2EN = { k: 'v' };");
    await fs.writeTextAtomic(`${R}/${DIR}/__tests__/fake.ts`, "export const fakeEN = { k: 'v' };");
    await fs.writeTextAtomic(`${R}/${DIR}/notes.md`, "export const notesEN = { k: 'v' };");
    const imp = await importTsLocales(fs, R, DIR, "th");
    const groups = new Set(imp.keyOrder.map((id) => id.split("::")[0]));
    expect([...groups]).toEqual(["button", "change-password", "common", "dashboardMaguro"]);
    expect(groups.has("mapLocale")).toBe(false);
    for (const p of imp.modules.keys()) expect(p).not.toContain("__tests__");
  });

  it("baseline keeps raw source including markers", async () => {
    const imp = await load();
    expect(imp.baseline["button::button_delete"]).toEqual({ th: "ลบ", en: "ลบ (EN)" });
    expect(imp.baseline["button::button_reset_password"]).toEqual({
      th: "รีเซ็ตรหัสผ่าน",
      en: "Reset password (EN)",
    });
    expect(imp.baseline["common::support_file_csv_xlsx"]?.en).toBe("XLS, XLSX or CSV\n(Maximum 2,000 items)");
    expect(imp.baseline["common::zone_name"]).toEqual({ th: "ชื่อโซน" });
    expect(imp.baseline["dashboardMaguro::maguro_brand"]).toBeUndefined();
  });

  it("read-only items are listed by key id", async () => {
    const imp = await load();
    expect(imp.readOnly.map((r) => r.id)).toEqual(["dashboardMaguro::maguro_brand", "dashboardMaguro::maguro_brand"]);
    for (const r of imp.readOnly) expect(r.reason.length).toBeGreaterThan(0);
    expect(imp.values.get("dashboardMaguro::maguro_brand")).toBeUndefined();
  });

  it("parse errors are recorded per file and the rest still imports", async () => {
    const fs = new MemoryFs({
      [`${R}/loc/bad.ts`]: "export const badEN = { k: 'v' ",
      [`${R}/loc/good.ts`]: "export const goodEN = { k: 'v' };",
    });
    const imp = await importTsLocales(fs, R, "loc", "th");
    expect(imp.errors).toHaveLength(1);
    expect(imp.errors[0].relPath).toBe("loc/bad.ts");
    expect(imp.errors[0].message.length).toBeGreaterThan(0);
    expect(imp.keyOrder).toEqual(["good::k"]);
    expect(imp.locales).toEqual(["th", "en"]);
  });
});
