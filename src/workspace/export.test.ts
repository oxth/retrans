import { describe, expect, it } from "vitest";
import { keyId, type MessageValue } from "../core/model";
import { joinPath } from "../platform/fs";
import { MemoryFs } from "../platform/memory-fs";
import { importTsLocales } from "../tssource/import";
import { openFixtureWorkspace, openWorkspaceFrom } from "../test/workspace-fixture";
import { planExport, recordWriteBack, writeExportPlan } from "./export";
import { BASELINE_PATH, parseBaseline, parseWorkspaceMeta, serializeBaseline, WORKSPACE_META_PATH } from "./meta";
import { syncFromSource } from "./sync";

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

/**
 * Plans a write-back; unless it is blocked, writes it and re-imports the source, which must
 * parse cleanly and match the refreshed baseline.
 */
async function writeBack(w: Awaited<ReturnType<typeof setup>>, s: typeof w.session) {
  const plan = await planExport(s, { kind: "ts-writeback" }, await w.source());
  if (plan.blocked) return plan;
  await writeExportPlan(w.fs, plan);
  const re = await w.source();
  expect(re.errors).toEqual([]);
  const again = await planExport(s, { kind: "ts-writeback" }, re);
  expect(again.blocked).toBeUndefined();
  return plan;
}

const file = (plan: { files: Array<{ path: string; text: string }> }, path: string) =>
  plan.files.find((f) => f.path === path)?.text;

describe("planExport: renames", () => {
  const BUTTON = (w: { root: string; localesDir: string }) => `${w.root}/${w.localesDir}/button.tsx`;

  it("rename → sync → save → write-back moves the key; renames cleared; second export is a no-op", async () => {
    const w = await setup();
    const s = w.session;
    const before = await w.fixtureFiles();
    const to = s.renameKey(keyId("button", "button_ok"), "button_okay");
    expect(s.workspace!.renames).toEqual({ [keyId("button", "button_ok")]: to });
    const r = await syncFromSource(s);
    expect(r.conflicts).toEqual([]);
    expect(r.added).toEqual([]);
    expect((await s.save()).stale).toEqual([]);
    expect(s.isDirty()).toBe(false);
    // The saved baseline is keyed by the new id.
    const saved = parseBaseline(await w.fs.readText(`${w.root}/${BASELINE_PATH}`))!;
    expect(saved[to]).toEqual({ th: "ตกลง", en: "OK" });

    const plan = await planExport(s, { kind: "ts-writeback" }, await w.source());
    expect(plan.blocked).toBeUndefined();
    expect(plan.files.map((f) => f.path)).toEqual([BUTTON(w)]);
    const text = plan.files[0].text;
    expect(text).not.toContain("button_ok:");
    expect(text).toContain("  button_okay: 'ตกลง',\n};");
    expect(text).toContain("  button_okay: 'OK',\n};");
    expect(plan.renamesApplied).toEqual([keyId("button", "button_ok")]);
    expect(Object.keys(parseBaseline(plan.baseline!.text)!)).toContain(to);
    expect(Object.keys(parseBaseline(plan.baseline!.text)!)).not.toContain(keyId("button", "button_ok"));

    await writeExportPlan(w.fs, plan);
    recordWriteBack(s, plan);
    expect(s.workspace!.renames).toEqual({});
    await s.save();
    expect(parseWorkspaceMeta(await w.fs.readText(`${w.root}/${WORKSPACE_META_PATH}`))!.renames).toEqual({});
    // Only button.tsx changed.
    const after = await w.fixtureFiles();
    for (const f of Object.keys(before)) if (!f.endsWith("button.tsx")) expect(after[f]).toBe(before[f]);

    const re = await w.source();
    expect(re.errors).toEqual([]);
    expect(re.keyOrder).toContain(to);
    const again = await planExport(s, { kind: "ts-writeback" }, re);
    expect(again.blocked).toBeUndefined();
    expect(again.files).toEqual([]);
    expect(again.renamesApplied ?? []).toEqual([]);
  });

  it("rename without a sync is not blocked either", async () => {
    const w = await setup();
    const s = w.session;
    s.renameKey(keyId("change-password", "current_pw"), "current_password");
    const plan = await planExport(s, { kind: "ts-writeback" }, await w.source());
    expect(plan.blocked).toBeUndefined();
    const cp = file(plan, `${w.root}/${w.localesDir}/change-password.ts`)!;
    expect(cp).not.toContain("current_pw:");
    expect(cp).toContain("current_password: 'รหัสผ่านปัจจุบัน'");
    expect(cp).toContain("current_password: 'Current password'");
  });

  it("a renamed key keeps its untranslated marker", async () => {
    const w = await setup();
    const s = w.session;
    const to = s.renameKey(keyId("button", "button_delete"), "button_remove");
    const plan = await writeBack(w, s);
    const text = file(plan, BUTTON(w))!;
    expect(text).not.toContain("button_delete");
    expect(text).toContain("  button_remove: 'ลบ',\n};");
    expect(text).toContain("  button_remove: 'ลบ (EN)',\n};");
    expect(plan.renamesApplied).toEqual([keyId("button", "button_delete")]);
    const re = await w.source();
    expect(re.markers[to]).toEqual({ en: "ลบ (EN)" });
  });

  it("ts-copy writes the rename but leaves the renames (the source still has the old key)", async () => {
    const w = await setup();
    const s = w.session;
    s.renameKey(keyId("common", "email"), "email_address");
    const plan = await planExport(s, { kind: "ts-copy", dir: OUT }, await w.source());
    expect(plan.blocked).toBeUndefined();
    const common = file(plan, `${OUT}/${w.localesDir}/common.ts`)!;
    expect(common).not.toContain("  email:");
    expect(common).toContain("email_address: { th: 'อีเมล', en: 'Email' }");
    expect(plan.renamesApplied).toBeUndefined();
  });

  it("a rename of a key added in Retrans is a no-op mapping, cleared by write-back", async () => {
    const w = await setup();
    const s = w.session;
    const id = s.addKey("button", "button_new", "ใหม่");
    const to = s.renameKey(id, "button_newer");
    expect(s.workspace!.renames).toEqual({ [id]: to });
    const plan = await writeBack(w, s);
    expect(file(plan, BUTTON(w))).toContain("  button_newer: 'ใหม่',\n};");
    expect(plan.renamesApplied).toEqual([id]);
  });
});

describe("planExport: ts-writeback", () => {
  it("writeback with no edits writes nothing", async () => {
    const w = await setup();
    const before = await w.fixtureFiles();
    const plan = await writeBack(w, w.session);
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
    const plan = await writeBack(w, w.session);
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
    const plan = await writeBack(w, s);
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
    const plan = await writeBack(w, s);
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
    const plan = await writeBack(w, s);
    expect(plan.files).toEqual([]);
  });

  it("added language is reported as left out", async () => {
    const w = await setup();
    const s = w.session;
    s.addLanguage("ja");
    s.setText(keyId("button", "button_ok"), "ja", "オーケー");
    const plan = await writeBack(w, s);
    expect(plan.leftOutLocales).toEqual(["ja"]);
    expect(plan.files).toEqual([]);
    expect(plan.leftOutSnippet).toContain("'th' | 'en' | 'ja'");
    expect(plan.snippets.join("\n")).not.toContain("'th' | 'en' | 'ja'");
  });

  it("marker cells stay markers", async () => {
    const w = await setup();
    const s = w.session;
    expect(s.value(keyId("button", "button_delete"), "en")).toBeUndefined();
    s.setText(keyId("button", "button_delete"), "th", "ลบทิ้ง");
    s.setText(keyId("button", "button_reset_password"), "th", "รีเซ็ต");
    const plan = await writeBack(w, s);
    const button = file(plan, `${w.root}/${w.localesDir}/button.tsx`)!;
    expect(button).toContain("  button_delete: 'ลบทิ้ง',");
    expect(button).toContain("  button_delete: 'ลบ (EN)',");
    expect(button).toContain("  button_reset_password: 'Reset password (EN)',");
  });

  it("a translated marker cell is replaced", async () => {
    const w = await setup();
    w.session.setText(keyId("button", "button_delete"), "en", "Delete");
    const plan = await writeBack(w, w.session);
    const button = file(plan, `${w.root}/${w.localesDir}/button.tsx`)!;
    expect(button).toContain("  button_delete: 'Delete',");
    expect(button).not.toContain("(EN)',\n  button_reset");
  });

  it("clearing a pair's only language while setting another stays valid (zone_name)", async () => {
    const w = await setup();
    const id = keyId("common", "zone_name");
    w.session.setText(id, "en", "Zone");
    w.session.setText(id, "th", null);
    const plan = await writeBack(w, w.session);
    expect(file(plan, `${w.root}/${w.localesDir}/common.ts`)).toContain("  zone_name: { en: 'Zone' },\n");
    const re = await w.source();
    expect(re.values.get(id)?.get("en")).toEqual(text("Zone"));
    expect(re.values.get(id)?.get("th")).toBeUndefined();
  });

  it("after a write-back the baseline is refreshed: the next export isn't blocked and has nothing to do", async () => {
    const w = await setup();
    w.session.setText(keyId("button", "button_ok"), "en", "Okay");
    const plan = await planExport(w.session, { kind: "ts-writeback" }, await w.source());
    expect(plan.baseline?.path).toBe(`${w.root}/.retrans/source-baseline.json`);
    await writeExportPlan(w.fs, plan);
    const next = await planExport(w.session, { kind: "ts-writeback" }, await w.source());
    expect(next.blocked).toBeUndefined();
    expect(next.files).toEqual([]);
    expect(next.baseline).toBeUndefined();
  });

  it("a group whose source file can't be read is not rewritten", async () => {
    const w = await setup();
    const rel = `${w.localesDir}/button.tsx`;
    const source = await w.source();
    source.modules.delete(rel);
    source.errors.push({ relPath: rel, message: "boom" });
    for (const id of Object.keys(source.baseline)) if (id.startsWith("button::")) delete source.baseline[id];
    await w.fs.writeTextAtomic(`${w.root}/.retrans/source-baseline.json`, serializeBaseline(source.baseline));
    w.session.setText(keyId("button", "button_ok"), "en", "Okay");
    const plan = await planExport(w.session, { kind: "ts-writeback" }, source);
    expect(plan.blocked).toBeUndefined();
    expect(plan.files).toEqual([]);
    expect(plan.warnings).toEqual([
      `Couldn't read ${rel}; it was left unchanged.`,
      `Couldn't read the source file of group "button"; it was not written.`,
    ]);
  });

  it("blocked when source changed since baseline", async () => {
    const w = await setup();
    const path = `${w.root}/${w.localesDir}/button.tsx`;
    await w.fs.writeTextAtomic(path, (await w.fs.readText(path)).replace("'OK'", "'Okay!'"));
    const plan = await writeBack(w, w.session);
    expect(plan.blocked).toEqual({ reason: "conflicts" });
    expect(plan.files).toEqual([]);
    await expect(writeExportPlan(w.fs, plan)).rejects.toThrow();
    expect(await w.fs.readText(path)).toContain("'Okay!'");
  });
});

describe("writeExportPlan: output root", () => {
  it("refuses, before writing anything, a planned file outside the output root", async () => {
    const w = await setup();
    w.session.setText(keyId("button", "button_ok"), "en", "Okay");
    const plan = await planExport(w.session, { kind: "ts-writeback" }, await w.source());
    expect(plan.root).toBe(w.root);
    const before = await w.fixtureFiles();
    for (const path of [`${w.root}/src/../../etc/passwd`, "/etc/passwd", `${w.root}2/x.ts`, `${w.root}/./../x.ts`]) {
      const bad = { ...plan, files: [...plan.files, { path, text: "x" }] };
      await expect(writeExportPlan(w.fs, bad)).rejects.toThrow(`Refusing to write outside ${w.root}: ${path}`);
    }
    expect(await w.fixtureFiles()).toEqual(before);
    expect(await w.fs.exists("/etc/passwd")).toBe(false);

    const json = await planExport(w.session, { kind: "i18next-json", dir: OUT, namespaces: "per-group" });
    expect(json.root).toBe(OUT);
    const out = { ...json, files: [{ path: `${OUT}/en/../../evil.json`, text: "{}" }, ...json.files] };
    await expect(writeExportPlan(w.fs, out)).rejects.toThrow("Refusing to write outside");
    expect(await w.fs.exists(OUT)).toBe(false);
    // In-root paths that only look odd are fine.
    await writeExportPlan(w.fs, { ...json, files: [{ path: `${OUT}/./en/x/../a.json`, text: "{}" }] });
    expect(await w.fs.exists(`${OUT}/en/a.json`)).toBe(true);
  });
});

describe("same-named locale files", () => {
  it("the later file by path is never imported, synced or written", async () => {
    const R = "/p";
    const root = `${R}/locales/common.ts`;
    const admin = `${R}/locales/admin/common.ts`;
    const fs = new MemoryFs({
      [root]: "export const commonTH = {\n  a: 'ก',\n};\n\nexport const commonEN = {\n  a: 'A',\n};\n",
      [admin]: "export const commonTH = {\n  b: 'ข',\n};\n\nexport const commonEN = {\n  b: 'B',\n};\n",
    });
    const s = await openWorkspaceFrom(fs, R, "locales");
    expect(s.data.keyOrder).toEqual([keyId("common", "b")]);
    // A developer edits the skipped file: sync ignores it.
    await fs.writeTextAtomic(root, (await fs.readText(root)).replace("a: 'A'", "a: 'AA'"));
    const r = await syncFromSource(s);
    expect(r).toMatchObject({ added: [], updated: [], removedInSource: [], conflicts: [] });
    await s.save();
    const rootText = await fs.readText(root);

    s.setText(keyId("common", "b"), "en", "Bee");
    await s.save();
    const plan = await planExport(s, { kind: "ts-writeback" }, await importTsLocales(fs, R, "locales", "th"));
    expect(plan.blocked).toBeUndefined();
    expect(plan.files.map((f) => f.path)).toEqual([admin]);
    expect(plan.files[0].text).not.toContain("a:");
    expect(plan.warnings).toEqual([
      `Two locale files are named "common" (locales/admin/common.ts, locales/common.ts). Retrans can't tell them apart yet — locales/common.ts was skipped.`,
    ]);
    await writeExportPlan(fs, plan);
    expect(await fs.readText(root)).toBe(rootText);
    expect(await fs.readText(admin)).toContain("  b: 'Bee',\n");

    const copy = await planExport(s, { kind: "ts-copy", dir: OUT }, await importTsLocales(fs, R, "locales", "th"));
    expect(copy.files.map((f) => f.path)).toEqual([`${OUT}/locales/admin/common.ts`]);
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
    expect(file(plan, `${OUT}/button.ts`)).toContain("import { mapLocale } from './mapLocale';");
    // New format: untranslated cells are omitted, markers included.
    expect(file(plan, `${OUT}/button.ts`)).toContain("  button_delete: { th: 'ลบ' },");
    expect(plan.snippets.join("\n")).toContain("import { buttonTH, buttonEN } from '@/assets/locales/button';");
    await writeExportPlan(w.fs, plan);
    const re = await importTsLocales(w.fs, OUT, "", "th");
    expect(re.errors).toEqual([]);
    expect(textValues(re.values)).toEqual(textValues(s.data.values));
    expect(re.markers).toEqual({});
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
