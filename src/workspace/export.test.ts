import { describe, expect, it } from "vitest";
import { keyId, type MessageValue } from "../core/model";
import { joinPath } from "../platform/fs";
import { MemoryFs } from "../platform/memory-fs";
import { importTsLocales } from "../tssource/import";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { planExport, writeExportPlan } from "./export";

const OUT = "/out";

async function setup() {
  const w = await openFixtureWorkspace();
  const source = () => importTsLocales(w.fs, w.root, w.localesDir, "th");
  const fixtureFiles = async () => {
    const files = await w.fs.listFiles(joinPath(w.root, "src"), 8);
    const out: Record<string, string> = {};
    for (const f of files) out[f] = await w.fs.readText(joinPath(w.root, "src", f));
    return out;
  };
  return { ...w, source, fixtureFiles };
}

const file = (plan: { files: Array<{ path: string; text: string }> }, path: string) =>
  plan.files.find((f) => f.path === path)?.text;

describe("planExport: ts-writeback", () => {
  it("writeback with no edits writes nothing", async () => {
    const w = await setup();
    const before = await w.fixtureFiles();
    const plan = await planExport(w.session, { kind: "ts-writeback" }, await w.source());
    expect(plan.blocked).toBeUndefined();
    expect(plan.files).toEqual([]);
    expect(plan.leftOutLocales).toEqual([]);
    await writeExportPlan(w.fs, plan);
    expect(await w.fixtureFiles()).toEqual(before);
  });

  it("one edit → one file, one line", async () => {
    const w = await setup();
    const path = `${w.root}/${w.localesDir}/button.tsx`;
    const original = await w.fs.readText(path);
    w.session.setText(keyId("button", "button_ok"), "en", "Okay");
    const plan = await planExport(w.session, { kind: "ts-writeback" }, await w.source());
    expect(plan.files.map((f) => f.path)).toEqual([path]);
    const a = original.split("\n");
    const b = plan.files[0].text.split("\n");
    expect(b.length).toBe(a.length);
    const changed = b.filter((line, i) => line !== a[i]);
    expect(changed).toEqual(["  button_ok: 'Okay'"]);
    await writeExportPlan(w.fs, plan);
    expect(await w.fs.readText(path)).toBe(plan.files[0].text);
  });

  it("new key in split group goes to both objects; new group becomes a new file plus snippet", async () => {
    const w = await setup();
    const s = w.session;
    const id = s.addKey("button", "button_export", "ส่งออก");
    s.setText(id, "en", "Export");
    s.addNamespace("reports");
    const r = s.addKey("reports", "report_title", "รายงาน");
    s.setText(r, "en", "Report");
    const plan = await planExport(s, { kind: "ts-writeback" }, await w.source());
    const button = file(plan, `${w.root}/${w.localesDir}/button.tsx`)!;
    expect(button).toContain("  button_export: 'ส่งออก',\n};\n\nexport const buttonEN");
    expect(button).toContain("  button_ok: 'OK',\n  button_export: 'Export',\n};");
    const reports = file(plan, `${w.root}/${w.localesDir}/reports.ts`)!;
    expect(reports).toContain("  report_title: { th: 'รายงาน', en: 'Report' },");
    expect(reports).toContain("export const reportsTH = mapLocale(reports, 'th');");
    expect(plan.files).toHaveLength(2);
    expect(plan.snippets.join("\n")).toContain("import { reportsTH, reportsEN } from '@/assets/locales/reports';");
    const re = await importTsLocales(memWith(plan.files), w.root, w.localesDir, "th");
    expect(re.values.get(keyId("button", "button_export"))?.get("en")).toEqual(text("Export"));
    expect(re.values.get(keyId("reports", "report_title"))?.get("th")).toEqual(text("รายงาน"));
  });

  it("deleted key is removed; cleared cell loses that language only", async () => {
    const w = await setup();
    const s = w.session;
    s.deleteKey(keyId("button", "button_save"));
    s.setText(keyId("common", "email"), "en", null);
    s.setText(keyId("change-password", "current_pw"), "en", null);
    const plan = await planExport(s, { kind: "ts-writeback" }, await w.source());
    const button = file(plan, `${w.root}/${w.localesDir}/button.tsx`)!;
    expect(button).not.toContain("button_save");
    expect(file(plan, `${w.root}/${w.localesDir}/common.ts`)).toContain("  email: { th: 'อีเมล' },\n");
    const cp = file(plan, `${w.root}/${w.localesDir}/change-password.ts`)!;
    expect(cp).toContain("  current_pw: 'รหัสผ่านปัจจุบัน',");
    expect(cp).not.toContain("Current password");
    // A key with only markers / read-only values has no workspace row: left alone.
    expect(file(plan, `${w.root}/${w.localesDir}/common.ts`)).toContain("only_en: { th: undefined, en: 'Only EN (EN)' }");
    expect(file(plan, `${w.root}/${w.localesDir}/dashboardMaguro.tsx`)).toBeUndefined();
  });

  it("removed-in-source keys are not re-added", async () => {
    const w = await setup();
    const s = w.session;
    const id = s.addKey("button", "button_gone", "หาย");
    s.setWorkspaceMeta({ removedInSource: [id] });
    const plan = await planExport(s, { kind: "ts-writeback" }, await w.source());
    expect(plan.files).toEqual([]);
  });

  it("added language is reported as left out", async () => {
    const w = await setup();
    const s = w.session;
    s.addLanguage("ja");
    s.setText(keyId("button", "button_ok"), "ja", "オーケー");
    const plan = await planExport(s, { kind: "ts-writeback" }, await w.source());
    expect(plan.leftOutLocales).toEqual(["ja"]);
    expect(plan.files).toEqual([]);
    expect(plan.snippets.join("\n")).toContain("'th' | 'en' | 'ja'");
  });

  it("marker cells stay markers", async () => {
    const w = await setup();
    const s = w.session;
    expect(s.value(keyId("button", "button_delete"), "en")).toBeUndefined();
    s.setText(keyId("button", "button_delete"), "th", "ลบทิ้ง");
    s.setText(keyId("button", "button_reset_password"), "th", "รีเซ็ต");
    const plan = await planExport(s, { kind: "ts-writeback" }, await w.source());
    const button = file(plan, `${w.root}/${w.localesDir}/button.tsx`)!;
    expect(button).toContain("  button_delete: 'ลบทิ้ง',");
    expect(button).toContain("  button_delete: 'ลบ (EN)',");
    expect(button).toContain("  button_reset_password: 'Reset password (EN)',");
  });

  it("a translated marker cell is replaced", async () => {
    const w = await setup();
    w.session.setText(keyId("button", "button_delete"), "en", "Delete");
    const plan = await planExport(w.session, { kind: "ts-writeback" }, await w.source());
    const button = file(plan, `${w.root}/${w.localesDir}/button.tsx`)!;
    expect(button).toContain("  button_delete: 'Delete',");
    expect(button).not.toContain("(EN)',\n  button_reset");
  });

  it("blocked when source changed since baseline", async () => {
    const w = await setup();
    const path = `${w.root}/${w.localesDir}/button.tsx`;
    await w.fs.writeTextAtomic(path, (await w.fs.readText(path)).replace("'OK'", "'Okay!'"));
    const plan = await planExport(w.session, { kind: "ts-writeback" }, await w.source());
    expect(plan.blocked).toEqual({ reason: "conflicts" });
    expect(plan.files).toEqual([]);
    await expect(writeExportPlan(w.fs, plan)).rejects.toThrow();
    expect(await w.fs.readText(path)).toContain("'Okay!'");
  });
});

describe("planExport: ts-copy", () => {
  it("writes every module under dir with the same relative paths", async () => {
    const w = await setup();
    w.session.setText(keyId("button", "button_ok"), "en", "Okay");
    const plan = await planExport(w.session, { kind: "ts-copy", dir: OUT }, await w.source());
    expect(plan.files.map((f) => f.path).sort()).toEqual([
      `${OUT}/${w.localesDir}/button.tsx`,
      `${OUT}/${w.localesDir}/change-password.ts`,
      `${OUT}/${w.localesDir}/common.ts`,
      `${OUT}/${w.localesDir}/dashboardMaguro.tsx`,
    ]);
    expect(file(plan, `${OUT}/${w.localesDir}/button.tsx`)).toContain("button_ok: 'Okay'");
    expect(file(plan, `${OUT}/${w.localesDir}/common.ts`)).toBe(await w.fs.readText(`${w.root}/${w.localesDir}/common.ts`));
    await writeExportPlan(w.fs, plan);
    expect(await w.fs.readText(`${w.root}/${w.localesDir}/button.tsx`)).toContain("button_ok: 'OK'");
  });
});

describe("planExport: other formats", () => {
  it("i18next-json per-group and single", async () => {
    const w = await setup();
    const s = w.session;
    const per = await planExport(s, { kind: "i18next-json", dir: OUT, namespaces: "per-group" });
    expect(per.blocked).toBeUndefined();
    expect(file(per, `${OUT}/en/button.json`)).toBe(
      '{\n  "button_save": "Save",\n  "button_ok": "OK"\n}\n',
    );
    expect(JSON.parse(file(per, `${OUT}/th/common.json`)!)).toMatchObject({ email: "อีเมล", zone_name: "ชื่อโซน" });
    expect(file(per, `${OUT}/en/change-password.json`)).toContain('"change_pw": "Change password"');

    const single = await planExport(s, { kind: "i18next-json", dir: OUT, namespaces: "single" });
    expect(single.blocked).toEqual({ reason: "duplicates", keys: ["change_pw"] });
    expect(single.files).toEqual([]);
    await expect(writeExportPlan(w.fs, single)).rejects.toThrow();

    s.renameKey(keyId("change-password", "change_pw"), "change_pw_title");
    const ok = await planExport(s, { kind: "i18next-json", dir: OUT, namespaces: "single" });
    expect(ok.blocked).toBeUndefined();
    expect(ok.files.map((f) => f.path)).toEqual([`${OUT}/th/translation.json`, `${OUT}/en/translation.json`]);
    const en = JSON.parse(file(ok, `${OUT}/en/translation.json`)!);
    expect(en.change_pw).toBe("Change Password");
    expect(en.change_pw_title).toBe("Change password");
    expect(en.button_delete).toBeUndefined();
    for (const f of ok.files) {
      expect(Object.values(JSON.parse(f.text))).not.toContain("");
      expect(f.text.endsWith("}\n")).toBe(true);
    }
    await writeExportPlan(w.fs, ok);
    expect(await w.fs.readText(`${OUT}/en/translation.json`)).toBe(file(ok, `${OUT}/en/translation.json`));
  });

  it("paraglide converts placeholders and warns on modifiers", async () => {
    const w = await setup();
    const s = w.session;
    const blocked = await planExport(s, { kind: "paraglide", dir: OUT });
    expect(blocked.blocked).toEqual({ reason: "duplicates", keys: ["change_pw"] });

    s.renameKey(keyId("change-password", "change_pw"), "change_pw_title");
    s.setText(keyId("common", "session_expire_in"), "en", "Expires in {{minutes, number}} minutes");
    const plan = await planExport(s, { kind: "paraglide", dir: OUT });
    expect(plan.blocked).toBeUndefined();
    const th = JSON.parse(file(plan, `${OUT}/messages/th.json`)!);
    const en = JSON.parse(file(plan, `${OUT}/messages/en.json`)!);
    expect(Object.keys(th)[0]).toBe("$schema");
    expect(th.$schema).toBe("https://inlang.com/schema/inlang-message-format");
    expect(th.session_expire_in).toBe("เซสชันจะหมดอายุใน {minutes} นาที");
    expect(en.session_expire_in).toBe("Expires in {minutes} minutes");
    expect(en.button_delete).toBeUndefined();
    expect(plan.warnings).toEqual(["Format modifier dropped in session_expire_in"]);
    const settings = JSON.parse(file(plan, `${OUT}/project.inlang/settings.json`)!);
    expect(settings).toMatchObject({ baseLocale: "th", locales: ["th", "en"] });
    expect(settings["plugin.inlang.messageFormat"]).toEqual({ pathPattern: "./messages/{locale}.json" });
  });

  it("ts-modules output re-imports to the same values", async () => {
    const w = await setup();
    const s = w.session;
    s.setText(keyId("common", "email"), "en", "E-mail 'quoted' \\ \"x\"\nline");
    const plan = await planExport(s, { kind: "ts-modules", dir: OUT });
    expect(plan.blocked).toBeUndefined();
    expect(plan.files.map((f) => f.path).sort()).toEqual([
      `${OUT}/button.ts`, `${OUT}/change-password.ts`, `${OUT}/common.ts`, `${OUT}/dashboardMaguro.ts`, `${OUT}/mapLocale.ts`,
    ]);
    expect(file(plan, `${OUT}/mapLocale.ts`)).toContain("'th' | 'en'");
    expect(plan.snippets.join("\n")).toContain("import { buttonTH, buttonEN } from '@/assets/locales/button';");
    await writeExportPlan(w.fs, plan);
    const re = await importTsLocales(w.fs, OUT, "", "th");
    expect(re.errors).toEqual([]);
    expect(textValues(re.values)).toEqual(textValues(s.data.values));
    // Markers survive as markers.
    expect(re.markers[keyId("button", "button_delete")]).toEqual({ en: "ลบ (EN)" });
  });
});

function text(t: string): MessageValue {
  return { kind: "text", text: t };
}

function textValues(values: Map<string, Map<string, MessageValue>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [id, cells] of values) {
    for (const [loc, v] of cells) if (v.kind === "text" && v.text !== "") (out[id] ??= {})[loc] = v.text;
  }
  return out;
}

function memWith(files: Array<{ path: string; text: string }>): MemoryFs {
  return new MemoryFs(Object.fromEntries(files.map((f) => [f.path, f.text])));
}
