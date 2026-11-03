import { describe, expect, it } from "vitest";
import { keyId } from "../core/model";
import { joinPath } from "../platform/fs";
import { importTsLocales } from "../tssource/import";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { BASELINE_PATH, parseBaseline, WORKSPACE_DIR } from "./meta";
import { syncFromSource } from "./sync";

const text = (t: string) => ({ kind: "text", text: t });

async function setup() {
  const w = await openFixtureWorkspace();
  const srcPath = (name: string) => joinPath(w.root, w.localesDir, name);
  /** Replaces `from` (must occur exactly once) in a source file. */
  const edit = async (name: string, from: string, to: string) => {
    const t = await w.fs.readText(srcPath(name));
    expect(t.split(from).length - 1).toBe(1);
    await w.fs.writeTextAtomic(srcPath(name), t.replace(from, to));
  };
  const baseline = async () => parseBaseline(await w.fs.readText(joinPath(w.root, BASELINE_PATH)));
  const sourceBaseline = async () => (await importTsLocales(w.fs, w.root, w.localesDir, "th")).baseline;
  let emits = 0;
  w.session.subscribe(() => emits++);
  return { ...w, edit, srcPath, baseline, sourceBaseline, emits: () => emits };
}

const SAVE = keyId("button", "button_save");
const DELETE = keyId("button", "button_delete");
const OK = keyId("button", "button_ok");

describe("syncFromSource", () => {
  it("new key in code is added", async () => {
    const w = await setup();
    await w.edit("button.tsx", "  button_ok: 'ตกลง',\n", "  button_ok: 'ตกลง',\n  button_export: 'ส่งออก',\n");
    await w.edit("button.tsx", "  button_ok: 'OK'\n", "  button_ok: 'OK',\n  button_export: 'Export',\n");
    const r = await syncFromSource(w.session);
    const id = keyId("button", "button_export");
    expect(r.sourceAvailable).toBe(true);
    expect(r.added).toEqual([id]);
    expect(r.conflicts).toEqual([]);
    expect(w.session.data.keyOrder).toContain(id);
    // Placed after its predecessor in the source, not at the end.
    expect(w.session.data.keyOrder.indexOf(id)).toBe(w.session.data.keyOrder.indexOf(OK) + 1);
    expect(w.session.value(id, "th")).toEqual(text("ส่งออก"));
    expect(w.session.value(id, "en")).toEqual(text("Export"));
    expect(await w.baseline()).toEqual(await w.sourceBaseline());
    expect(w.emits()).toBe(1);
    await w.session.save();
    expect(JSON.parse(await w.fs.readText(joinPath(w.root, WORKSPACE_DIR, "en", "button.json"))).button_export).toBe("Export");
  });

  it("new key with no base value is added with the base missing", async () => {
    const w = await setup();
    await w.edit("button.tsx", "  button_ok: 'OK'\n", "  button_ok: 'OK',\n  button_export: 'Export',\n");
    const r = await syncFromSource(w.session);
    const id = keyId("button", "button_export");
    expect(r.added).toEqual([id]);
    expect(w.session.value(id, "th")).toBeUndefined();
    expect(w.session.value(id, "en")).toEqual(text("Export"));
  });

  it("code change wins when workspace untouched", async () => {
    const w = await setup();
    await w.edit("button.tsx", "button_save: 'Save',", "button_save: 'Save file',");
    const r = await syncFromSource(w.session);
    expect(r.updated).toEqual([SAVE]);
    expect(r.conflicts).toEqual([]);
    expect(w.session.value(SAVE, "en")).toEqual(text("Save file"));
    expect(w.session.value(SAVE, "th")).toEqual(text("บันทึก"));
    expect(await w.baseline()).toEqual(await w.sourceBaseline());
  });

  it("both changed → conflict, workspace keeps mine", async () => {
    const w = await setup();
    w.session.setText(SAVE, "en", "Store");
    await w.edit("button.tsx", "button_save: 'Save',", "button_save: 'Save file',");
    await w.edit("button.tsx", "button_ok: 'OK'", "button_ok: 'Okay'");
    const before = await w.baseline();
    const r = await syncFromSource(w.session);
    expect(r.conflicts).toEqual([{ id: SAVE, locale: "en", mine: text("Store"), theirs: text("Save file") }]);
    expect(w.session.value(SAVE, "en")).toEqual(text("Store"));
    // The non-conflicting change is taken and its baseline cell updated; the conflict's is not.
    expect(w.session.value(OK, "en")).toEqual(text("Okay"));
    const b = await w.baseline();
    expect(b![SAVE].en).toBe(before![SAVE].en);
    expect(b![OK].en).toBe("Okay");
    // Syncing again reports the same conflict until it is resolved.
    const again = await syncFromSource(w.session);
    expect(again.conflicts).toEqual(r.conflicts);
  });

  it("same change on both sides is not a conflict", async () => {
    const w = await setup();
    w.session.setText(SAVE, "en", "Save file");
    await w.edit("button.tsx", "button_save: 'Save',", "button_save: 'Save file',");
    const r = await syncFromSource(w.session);
    expect(r.conflicts).toEqual([]);
    expect(await w.baseline()).toEqual(await w.sourceBaseline());
  });

  it("workspace change with source unchanged is kept", async () => {
    const w = await setup();
    w.session.setText(SAVE, "en", "Store");
    const r = await syncFromSource(w.session);
    expect(r).toEqual({ sourceAvailable: true, conflicts: [], added: [], updated: [], removedInSource: [], newGroups: [] });
    expect(w.session.value(SAVE, "en")).toEqual(text("Store"));
  });

  it("deleted in code → removedInSource, not deleted", async () => {
    const w = await setup();
    await w.edit("button.tsx", "  button_ok: 'ตกลง',\n", "");
    await w.edit("button.tsx", ",\n  button_ok: 'OK'\n", "\n");
    const r = await syncFromSource(w.session);
    expect(r.removedInSource).toEqual([OK]);
    expect(w.session.workspace!.removedInSource).toEqual([OK]);
    expect(w.session.data.keyOrder).toContain(OK);
    expect(w.session.value(OK, "th")).toEqual(text("ตกลง"));
    expect(w.session.value(OK, "en")).toEqual(text("OK"));
    expect(await w.baseline()).toEqual(await w.sourceBaseline());
    // Back in the source: no longer removed.
    await w.edit("button.tsx", "  button_reset_password: 'รีเซ็ตรหัสผ่าน',\n", "  button_reset_password: 'รีเซ็ตรหัสผ่าน',\n  button_ok: 'ตกลง',\n");
    await w.edit("button.tsx", "(EN)'\n};", "(EN)',\n  button_ok: 'OK',\n};");
    const r2 = await syncFromSource(w.session);
    expect(r2.removedInSource).toEqual([]);
    expect(r2.conflicts).toEqual([]);
    expect(w.session.workspace!.removedInSource).toEqual([]);
  });

  it("deleted source file → its keys are removed in source", async () => {
    const w = await setup();
    await w.fs.remove(w.srcPath("dashboardMaguro.tsx"));
    const r = await syncFromSource(w.session);
    expect(r.removedInSource).toEqual([keyId("dashboardMaguro", "maguro_dash_title"), keyId("dashboardMaguro", "maguro_greeting")]);
    expect(w.session.value(keyId("dashboardMaguro", "maguro_dash_title"), "en")).toEqual(text("Store overview"));
  });

  it("new source file → new group", async () => {
    const w = await setup();
    await w.fs.writeTextAtomic(
      w.srcPath("profile.ts"),
      "export const profileTH = {\n  profile_title: 'โปรไฟล์',\n};\n\nexport const profileEN = {\n  profile_title: 'Profile',\n};\n",
    );
    const r = await syncFromSource(w.session);
    const id = keyId("profile", "profile_title");
    expect(r.newGroups).toEqual(["profile"]);
    expect(r.added).toEqual([id]);
    expect(w.session.data.namespaces).toContain("profile");
    expect(w.session.value(id, "th")).toEqual(text("โปรไฟล์"));
    expect(w.session.value(id, "en")).toEqual(text("Profile"));
    await w.session.save();
    expect(JSON.parse(await w.fs.readText(joinPath(w.root, WORKSPACE_DIR, "th", "profile.json")))).toEqual({ profile_title: "โปรไฟล์" });
    expect(JSON.parse(await w.fs.readText(joinPath(w.root, WORKSPACE_DIR, "en", "profile.json")))).toEqual({ profile_title: "Profile" });
  });

  it("missing source folder → sourceAvailable false and nothing marked removed", async () => {
    const w = await setup();
    await w.fs.remove(joinPath(w.root, w.localesDir));
    const meta = structuredClone(w.session.workspace);
    const before = w.fs.snapshot();
    const version = w.session.version;
    const r = await syncFromSource(w.session);
    expect(r).toEqual({ sourceAvailable: false, conflicts: [], added: [], updated: [], removedInSource: [], newGroups: [] });
    expect(w.session.workspace).toEqual(meta);
    expect(w.session.version).toBe(version);
    expect(w.session.isDirty()).toBe(false);
    expect(w.fs.snapshot()).toEqual(before);
    expect(w.emits()).toBe(0);
  });

  it("source folder with no locale modules → sourceAvailable false", async () => {
    const w = await setup();
    for (const f of await w.fs.listFiles(joinPath(w.root, w.localesDir), 8)) {
      if (f !== "mapLocale.ts") await w.fs.remove(w.srcPath(f));
    }
    const r = await syncFromSource(w.session);
    expect(r.sourceAvailable).toBe(false);
    expect(w.session.workspace!.removedInSource).toEqual([]);
  });

  it("marker added in code for a translated cell counts as a source change to missing", async () => {
    const w = await setup();
    await w.edit("button.tsx", "button_save: 'Save',", "button_save: 'Save (EN)',");
    const r = await syncFromSource(w.session);
    expect(r.updated).toEqual([SAVE]);
    expect(w.session.value(SAVE, "en")).toBeUndefined();
    expect(w.session.value(SAVE, "th")).toEqual(text("บันทึก"));
    expect(w.session.workspace!.markers[SAVE]).toEqual({ en: "Save (EN)" });
    expect(w.session.workspace!.drafts[SAVE]).toEqual({ en: "Save" });
    expect(await w.baseline()).toEqual(await w.sourceBaseline());
  });

  it("marker replaced by a translation in code: value taken, stale marker and draft dropped", async () => {
    const w = await setup();
    const RESET = keyId("button", "button_reset_password");
    expect(w.session.workspace!.drafts[RESET]).toEqual({ en: "Reset password" });
    await w.edit("button.tsx", "'Reset password (EN)'", "'Reset password'");
    await syncFromSource(w.session);
    expect(w.session.value(RESET, "en")).toEqual(text("Reset password"));
    expect(w.session.workspace!.markers[RESET]).toBeUndefined();
    expect(w.session.workspace!.drafts[RESET]).toBeUndefined();
    expect(w.session.workspace!.markers[DELETE]).toEqual({ en: "ลบ (EN)" });
  });

  it("stale markers are refreshed from the source after a write-back translated them", async () => {
    const w = await setup();
    // The source already has a translation (as after a write-back) but the meta still lists the marker.
    w.session.setText(DELETE, "en", "Delete");
    await w.edit("button.tsx", "'ลบ (EN)'", "'Delete'");
    const r = await syncFromSource(w.session);
    expect(r.conflicts).toEqual([]);
    expect(w.session.workspace!.markers[DELETE]).toBeUndefined();
  });

  it("keeps emptyKeys and duplicates in step with the source", async () => {
    const w = await setup();
    await syncFromSource(w.session);
    expect(w.session.workspace!.emptyKeys).toEqual([keyId("common", "only_en")]);
    expect(w.session.workspace!.duplicates).toEqual(["change_pw"]);
    await w.edit("common.ts", "  zone_name: { th: 'ชื่อโซน' },\n", "  zone_name: { th: 'ชื่อโซน' },\n  only_marker: { en: 'X (EN)' },\n");
    await w.edit("change-password.ts", "  change_pw: 'Change password',\r\n", "");
    const r = await syncFromSource(w.session);
    expect(r.added).toEqual([]);
    expect(w.session.workspace!.emptyKeys).toEqual([keyId("common", "only_en"), keyId("common", "only_marker")]);
    expect(w.session.workspace!.duplicates).toEqual([]);
  });

  it("unchanged source → nothing changes and listeners are not notified", async () => {
    const w = await setup();
    const version = w.session.version;
    const r = await syncFromSource(w.session);
    expect(r).toEqual({ sourceAvailable: true, conflicts: [], added: [], updated: [], removedInSource: [], newGroups: [] });
    expect(w.session.version).toBe(version);
    expect(w.emits()).toBe(0);
    expect(w.session.isDirty()).toBe(false);
  });

  it("an unreadable source file changes nothing for its keys", async () => {
    const w = await setup();
    await w.fs.writeTextAtomic(w.srcPath("button.tsx"), "export const buttonTH = {\n  button_save: 'บันทึก\n");
    const before = await w.baseline();
    const r = await syncFromSource(w.session);
    expect(r.sourceAvailable).toBe(true);
    expect(r.removedInSource).toEqual([]);
    expect(w.session.value(SAVE, "en")).toEqual(text("Save"));
    expect((await w.baseline())![SAVE]).toEqual(before![SAVE]);
  });
});
