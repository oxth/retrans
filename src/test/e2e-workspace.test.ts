import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { isTranslated, keyId, parseKeyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { loadFixtureDir, type MemoryFs } from "../platform/memory-fs";
import { buildPackage } from "../package/build";
import { applyImport, diffPackage, openIncoming } from "../package/diff";
import { extractPackage } from "../package/extract";
import { findLocalesDir, importTsLocales } from "../tssource/import";
import { acceptDraft } from "../workspace/actions";
import { planExport, recordWriteBack, writeExportPlan } from "../workspace/export";
import { BASELINE_PATH, parseWorkspaceMeta, WORKSPACE_META_PATH } from "../workspace/meta";
import { syncFromSource } from "../workspace/sync";

const ROOT = "/project";
const JSON_ROOT = "/exported";
const TR = "/translator/pkg";
const LOCALES = "src/assets/locales";
const BUTTON = `${ROOT}/${LOCALES}/button.tsx`;
const COMMON = `${ROOT}/${LOCALES}/common.ts`;

async function openAt(fs: MemoryFs, root: string, baseLocale?: string) {
  const d = (await detectProject(fs, root))!;
  return ProjectSession.open(fs, root, d, { baseLocale: baseLocale ?? d.baseLocale ?? "th", localesPath: d.localesPath });
}

/** Every file under the project's `src/`, path -> text. */
function sources(fs: MemoryFs): Record<string, string> {
  return Object.fromEntries(Object.entries(fs.snapshot()).filter(([p]) => p.startsWith(`${ROOT}/src/`)));
}

/** Lines of `b` not in `a` and of `a` not in `b` (a line-set diff; the edits here keep line counts). */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const al = a.split("\n");
  const bl = b.split("\n");
  return { removed: al.filter((l) => !bl.includes(l)), added: bl.filter((l) => !al.includes(l)) };
}

describe("e2e TypeScript workspace", () => {
  it("import, edit, save, sync, write back, export JSON, translator package", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "fixtures", "ts-locales"), ROOT);
    const original = sources(fs);

    const email = keyId("common", "email");
    const onlyEn = keyId("common", "only_en");
    const del = keyId("button", "button_delete");
    const reset = keyId("button", "button_reset_password");
    const exp = keyId("button", "button_export");

    // 1. Import (as the Import dialog does), saved and reopened from disk.
    expect(await findLocalesDir(fs, ROOT)).toBe(LOCALES);
    const imp = await importTsLocales(fs, ROOT, LOCALES, "th");
    expect(imp.errors).toEqual([]);
    const fresh = await ProjectSession.fromImport(fs, ROOT, imp, { name: "project", localesDir: LOCALES, baseLocale: "th" });
    expect((await fresh.save()).stale).toEqual([]);
    expect(sources(fs)).toEqual(original);
    const s = await openAt(fs, ROOT);
    expect(s.workspace?.source).toEqual({ type: "ts", localesDir: LOCALES });
    expect(s.data.baseLocale).toBe("th");
    const opened = await syncFromSource(s); // as opening a workspace does
    expect(opened).toMatchObject({ sourceAvailable: true, conflicts: [], added: [], updated: [], removedInSource: [] });

    // 2. Markers are missing; drafts exist.
    expect(s.value(del, "en")).toBeUndefined();
    expect(s.value(reset, "en")).toBeUndefined();
    expect(s.value(onlyEn, "en")).toBeUndefined();
    expect(s.workspace!.markers[del]).toEqual({ en: "ลบ (EN)" });
    expect(s.workspace!.markers[onlyEn]).toEqual({ en: "Only EN (EN)" });
    expect(s.workspace!.drafts[reset]).toEqual({ en: "Reset password" });
    expect(s.workspace!.drafts[onlyEn]).toEqual({ en: "Only EN" });
    expect(s.workspace!.drafts[del]).toBeUndefined(); // "ลบ" is just the base value

    // 3. Accept one draft, translate one marker cell, edit one value.
    acceptDraft(s, reset, "en");
    s.setText(del, "en", "Delete");
    s.setText(email, "en", "E-mail");
    expect(s.workspace!.drafts[reset]).toBeUndefined();

    // 4. Save never writes the TS sources.
    expect((await s.save()).stale).toEqual([]);
    expect(s.isDirty()).toBe(false);
    expect(sources(fs)).toEqual(original);
    expect(JSON.parse(await fs.readText(`${ROOT}/.retrans/workspace/en/button.json`)).button_reset_password).toBe("Reset password");

    // 5. A developer adds button_export to the source; sync adds it.
    const devButton = original[BUTTON]
      .replace("  button_save: 'บันทึก',\n", "  button_save: 'บันทึก',\n  button_export: 'ส่งออก',\n")
      .replace("  button_save: 'Save',\n", "  button_save: 'Save',\n  button_export: 'Export',\n");
    expect(devButton).not.toBe(original[BUTTON]);
    await fs.writeTextAtomic(BUTTON, devButton);
    const synced = await syncFromSource(s);
    expect(synced).toMatchObject({ sourceAvailable: true, conflicts: [], added: [exp], removedInSource: [] });
    expect(s.value(exp, "th")).toEqual({ kind: "text", text: "ส่งออก" });
    expect(s.value(exp, "en")).toEqual({ kind: "text", text: "Export" });
    expect(s.value(email, "en")).toEqual({ kind: "text", text: "E-mail" }); // own edit kept
    await s.save();

    // 6. Write-back: only the 3 changed values (plus the developer's new key) differ from the original.
    const plan = await planExport(s, { kind: "ts-writeback" }, await importTsLocales(fs, ROOT, LOCALES, "th"));
    expect(plan.blocked).toBeUndefined();
    expect(plan.leftOutLocales).toEqual([]);
    expect(plan.files.map((f) => f.path).sort()).toEqual([BUTTON, COMMON]);
    await writeExportPlan(fs, plan);
    recordWriteBack(s, plan);
    // As the Export dialog does: sync (the markers follow the source), then save.
    const post = await syncFromSource(s);
    expect(post).toMatchObject({ conflicts: [], added: [], updated: [], removedInSource: [] });
    await s.save();
    expect(s.isDirty()).toBe(false);

    const after = sources(fs);
    for (const p of Object.keys(original)) if (p !== BUTTON && p !== COMMON) expect(after[p]).toBe(original[p]);
    expect(Object.keys(after).sort()).toEqual(Object.keys(original).sort());
    expect(after[BUTTON]).toBe(
      devButton
        .replace("  button_delete: 'ลบ (EN)',", "  button_delete: 'Delete',")
        .replace("  button_reset_password: 'Reset password (EN)',", "  button_reset_password: 'Reset password',"),
    );
    expect(lineDiff(original[BUTTON], after[BUTTON])).toEqual({
      removed: ["  button_delete: 'ลบ (EN)',", "  button_reset_password: 'Reset password (EN)',"],
      added: ["  button_export: 'ส่งออก',", "  button_export: 'Export',", "  button_delete: 'Delete',", "  button_reset_password: 'Reset password',"],
    });
    expect(lineDiff(original[COMMON], after[COMMON])).toEqual({
      removed: ["  email: { th: 'อีเมล', en: 'Email' },"],
      added: ["  email: { th: 'อีเมล', en: 'E-mail' },"],
    });
    expect(after[COMMON]).toContain("  only_en: { th: undefined, en: 'Only EN (EN)' },"); // untranslated: marker kept

    // Re-import gives the same values (and the write-back left nothing to sync).
    const re = await importTsLocales(fs, ROOT, LOCALES, "th");
    expect(re.errors).toEqual([]);
    for (const id of s.data.keyOrder) {
      for (const loc of s.data.locales) expect(re.values.get(id)?.get(loc), `${id}|${loc}`).toEqual(s.value(id, loc));
    }
    expect(re.markers).toEqual(s.workspace!.markers);
    const again = await syncFromSource(s);
    expect(again).toMatchObject({ conflicts: [], added: [], updated: [], removedInSource: [] });
    expect((await planExport(s, { kind: "ts-writeback" }, re)).files).toEqual([]);

    // 7. i18next per-group JSON, re-opened as a plain next-i18next project: same values.
    const json = await planExport(s, { kind: "i18next-json", dir: `${JSON_ROOT}/public/locales`, namespaces: "per-group" });
    expect(json.blocked).toBeUndefined();
    await writeExportPlan(fs, json);
    const jd = (await detectProject(fs, JSON_ROOT))!;
    expect(jd.workspace).toBeUndefined();
    expect(jd.format).toBe("next-i18next");
    const plain = await openAt(fs, JSON_ROOT, "th");
    const dups = new Set(s.workspace!.duplicates);
    expect([...dups]).toEqual(["change_pw"]);
    let compared = 0;
    for (const id of s.data.keyOrder) {
      if (dups.has(parseKeyId(id).key)) continue;
      for (const loc of s.data.locales) {
        const v = s.value(id, loc);
        expect(plain.value(id, loc), `${id}|${loc}`).toEqual(isTranslated(v) ? v : undefined);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(30);
    expect(sources(fs)).toEqual(after);

    // 8. Translator package: no source, so no sync and nothing marked removed.
    s.setProjectSetting({ id: "ws-proj" });
    await s.save();
    const pkg = await buildPackage(s, { locales: ["en"], now: new Date("2026-11-04T00:00:00Z") });
    const paths = pkg.map((f) => f.path);
    expect(paths).toContain(WORKSPACE_META_PATH);
    expect(paths).toContain(".retrans/state.json");
    expect(paths).toContain(".retrans/workspace/en/button.json");
    expect(paths).not.toContain(BASELINE_PATH);
    expect(paths.filter((p) => !p.startsWith(".retrans/"))).toEqual([]);
    expect(parseWorkspaceMeta(pkg.find((f) => f.path === WORKSPACE_META_PATH)!.text)!.source).toBeUndefined();

    await extractPackage(fs, pkg, TR);
    const tr = await openAt(fs, TR);
    expect(tr.workspace).not.toBeNull();
    expect(tr.workspace!.source).toBeUndefined();
    expect(tr.data.baseLocale).toBe("th");
    const trSync = await syncFromSource(tr);
    expect(trSync.sourceAvailable).toBe(false);
    expect(trSync.removedInSource).toEqual([]);
    expect(tr.workspace!.removedInSource).toEqual([]);
    expect(tr.isDirty()).toBe(false);
    expect(tr.value(exp, "en")).toEqual({ kind: "text", text: "Export" });

    // The translator translates the last marked cell; the developer imports it back.
    tr.setText(onlyEn, "en", "Only English");
    await tr.save();
    const back = await buildPackage(tr, { locales: ["en"], now: new Date("2026-11-05T00:00:00Z") });
    const inc = await openIncoming(back, s.data.baseLocale);
    const diff = diffPackage(s, inc.session, inc.manifest);
    expect(diff.otherProject).toBe(false);
    expect(diff.items.map((i) => `${i.kind}|${i.id}|${i.locale}`)).toEqual([`new|${onlyEn}|en`]);
    expect(applyImport(s, diff, new Map())).toBe(1);
    await s.save();
    expect(s.value(onlyEn, "en")).toEqual({ kind: "text", text: "Only English" });
    expect(sources(fs)).toEqual(after); // Save still never writes the sources
  });
});

describe("groups in a TypeScript workspace", () => {
  it("groups from the source are locked (they're files in the code); a group made in Retrans isn't", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "fixtures", "ts-locales"), ROOT);
    const imp = await importTsLocales(fs, ROOT, LOCALES, "th");
    const s = await ProjectSession.fromImport(fs, ROOT, imp, { name: "project", localesDir: LOCALES, baseLocale: "th" });
    expect(s.namespaceLockReason("common")).toBe('Comes from the "common" file in src/assets/locales. Rename or delete it in your code: this group\'s keys then show as removed from the source, and you can delete the group here.');
    expect(() => s.renameNamespace("common", "shared")).toThrow(/Comes from/);
    expect(() => s.deleteNamespace("button")).toThrow(/Comes from/);
    s.addNamespace("extra");
    expect(s.namespaceLockReason("extra")).toBeNull();
    s.renameNamespace("extra", "more");
    expect(s.data.namespaces).toContain("more");
    s.deleteNamespace("more");
    expect(s.data.namespaces).not.toContain("more");
  });
});
