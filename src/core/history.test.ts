import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../formats/detect";
import { loadFixtureDir } from "../platform/memory-fs";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { keepKey } from "../workspace/actions";
import { syncFromSource } from "../workspace/sync";
import { syncFromFigma } from "../figma/sync";
import { keyId } from "./model";
import { ProjectSession } from "./session";

const FIX = resolve(__dirname, "../test/fixtures/next-nested");
const TITLE = "common::title";
const HOME = "common::nav.home";
const text = (t: string) => ({ kind: "text" as const, text: t });

async function open() {
  const fs = loadFixtureDir(FIX);
  const d = (await detectProject(fs, "/project"))!;
  const s = await ProjectSession.open(fs, "/project", d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
  return { fs, s };
}

describe("undo history", () => {
  it("undo/redo a cell edit", async () => {
    const { s } = await open();
    const before = s.value(TITLE, "th");
    expect(s.canUndo).toBe(false);
    s.setText(TITLE, "th", "แก้");
    expect(s.canUndo).toBe(true);
    expect(s.undo()).toEqual({ done: true, skipped: 0 });
    expect(s.value(TITLE, "th")).toEqual(before);
    expect(s.isDirty()).toBe(false);
    expect(s.canRedo).toBe(true);
    s.redo();
    expect(s.value(TITLE, "th")).toEqual(text("แก้"));
  });

  it("a batch is one step", async () => {
    const { s } = await open();
    s.batch(() => {
      s.setText(TITLE, "th", "a");
      s.setText(HOME, "th", "b");
    });
    s.undo();
    expect(s.value(TITLE, "th")).toEqual(text("สวัสดี"));
    expect(s.value(HOME, "th")).toEqual(text("หน้าแรก"));
    expect(s.canUndo).toBe(false);
  });

  it("rename then edit undoes in reverse order", async () => {
    const { s } = await open();
    const renamed = s.renameKey(TITLE, "heading");
    s.setText(renamed, "th", "หัวข้อ");
    s.undo();
    expect(s.value(renamed, "th")).toEqual(text("สวัสดี"));
    s.undo();
    expect(s.data.keyOrder).toContain(TITLE);
    expect(s.data.keyOrder).not.toContain(renamed);
    expect(s.value(TITLE, "th")).toEqual(text("สวัสดี"));
    expect(s.isDirty()).toBe(false);
  });

  it("delete key undo brings the row and values back in place", async () => {
    const { s } = await open();
    const at = s.data.keyOrder.indexOf(TITLE);
    const en = s.value(TITLE, "en");
    s.deleteKey(TITLE);
    s.undo();
    expect(s.data.keyOrder.indexOf(TITLE)).toBe(at);
    expect(s.value(TITLE, "en")).toEqual(en);
    expect(s.isDirty()).toBe(false);
  });

  it("mark reviewed is undoable", async () => {
    const { s } = await open();
    const other = s.data.locales.find((l) => l !== s.data.baseLocale)!;
    const before = s.meta(TITLE, other).status;
    s.markReviewed(TITLE, other);
    expect(s.meta(TITLE, other).status).toBe("reviewed");
    s.undo();
    expect(s.meta(TITLE, other).status).toBe(before);
  });

  it("add language undo removes it; redo adds it back", async () => {
    const { s } = await open();
    s.addLanguage("ja");
    s.setText(TITLE, "ja", "こんにちは");
    s.undo();
    expect(s.value(TITLE, "ja")).toBeUndefined();
    s.undo();
    expect(s.data.locales).not.toContain("ja");
    s.redo();
    expect(s.data.locales).toContain("ja");
    s.redo();
    expect(s.value(TITLE, "ja")).toEqual(text("こんにちは"));
  });

  it("undo after a save makes the session dirty again with the old value", async () => {
    const { fs, s } = await open();
    s.setText(TITLE, "th", "saved");
    await s.save();
    expect(s.isDirty()).toBe(false);
    s.undo();
    expect(s.value(TITLE, "th")).toEqual(text("สวัสดี"));
    expect(s.isDirty()).toBe(true);
    await s.save();
    expect(JSON.parse(await fs.readText("/project/public/locales/th/common.json")).title).toBe("สวัสดี");
  });

  it("undo skips a cell changed by an external change since", async () => {
    const { s } = await open();
    s.batch(() => {
      s.setText(TITLE, "th", "mine");
      s.setText(HOME, "th", "mine too");
    });
    s.external(() => s.importCell(TITLE, "th", text("from code"), undefined));
    expect(s.undo()).toEqual({ done: true, skipped: 1 });
    expect(s.value(TITLE, "th")).toEqual(text("from code"));
    expect(s.value(HOME, "th")).toEqual(text("หน้าแรก"));
  });

  it("external changes are not recorded", async () => {
    const { s } = await open();
    s.external(() => s.importCell(TITLE, "th", text("x"), undefined));
    expect(s.canUndo).toBe(false);
  });

  it("a new edit clears redo", async () => {
    const { s } = await open();
    s.setText(TITLE, "th", "a");
    s.undo();
    s.setText(HOME, "th", "b");
    expect(s.canRedo).toBe(false);
  });

  it("history keeps at most 200 steps", async () => {
    const { s } = await open();
    for (let i = 0; i < 205; i++) s.setText(TITLE, "th", `v${i}`);
    let n = 0;
    while (s.canUndo) {
      s.undo();
      n++;
    }
    expect(n).toBe(200);
    expect(s.value(TITLE, "th")).toEqual(text("v4"));
  });

  it("a group makes one step of the writes made inside it", async () => {
    const { s } = await open();
    const g = s.beginGroup();
    s.inGroup(g, () => s.setText(TITLE, "th", "a"));
    s.inGroup(g, () => s.setText(HOME, "th", "b"));
    s.endGroup(g);
    s.undo();
    expect(s.value(TITLE, "th")).toEqual(text("สวัสดี"));
    expect(s.value(HOME, "th")).toEqual(text("หน้าแรก"));
    expect(s.canUndo).toBe(false);
  });

  it("an undo that changes nothing is not a step (undo/redo don't record themselves)", async () => {
    const { s } = await open();
    s.setText(TITLE, "th", "a");
    s.undo();
    expect(s.canUndo).toBe(false);
    s.redo();
    expect(s.canRedo).toBe(false);
    expect(s.canUndo).toBe(true);
  });

  it("workspace meta changes (Keep, Figma links) are undone with the step", async () => {
    const w = await openFixtureWorkspace();
    const s = w.session;
    const id = keyId("button", "button_save");
    s.external(() => s.setWorkspaceMeta({ removedInSource: [id] }));
    keepKey(s, id);
    expect(s.workspace!.removedInSource).not.toContain(id);
    s.undo();
    expect(s.workspace!.removedInSource).toContain(id);
  });

  it("a TypeScript sync is not an undo step", async () => {
    const w = await openFixtureWorkspace();
    const src = `${w.root}/${w.localesDir}/button.tsx`;
    await w.fs.writeTextAtomic(src, (await w.fs.readText(src)).replace("button_save: 'Save',", "button_save: 'Store',"));
    await syncFromSource(w.session);
    expect(w.session.value(keyId("button", "button_save"), "en")).toEqual(text("Store"));
    expect(w.session.canUndo).toBe(false);
  });

  it("a Figma sync is not an undo step", async () => {
    const w = await openFixtureWorkspace();
    const { readFileSync } = await import("node:fs");
    const fig = resolve(__dirname, "../test/fixtures/figma/ALL");
    for (const f of ["ENG.tokens.json", "TH.tokens.json"]) {
      await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/${f}`, readFileSync(`${fig}/${f}`, "utf8"));
    }
    w.session.external(() =>
      w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {} } }),
    );
    await syncFromFigma(w.session);
    expect(w.session.data.keyOrder).toContain(keyId("figma-ALL", "ข้อมูลการรับประกัน"));
    expect(w.session.canUndo).toBe(false);
  });

  it("reload from disk is not an undo step", async () => {
    const { fs, s } = await open();
    const p = "/project/public/locales/th/common.json";
    const d = JSON.parse(await fs.readText(p));
    d.title = "จากดิสก์";
    await fs.writeTextAtomic(p, JSON.stringify(d, null, 2) + "\n");
    await s.reloadFromDisk();
    expect(s.value(TITLE, "th")).toEqual(text("จากดิสก์"));
    expect(s.canUndo).toBe(false);
  });

  it("review fix: a reload after auto-save neither records a step nor clears redo (workspace)", async () => {
    const w = await openFixtureWorkspace();
    const s = w.session;
    const id = keyId("button", "button_save");
    s.setText(id, "en", "Keep it");
    await s.save();
    await s.reloadFromDisk(); // what the watcher does after auto-save writes
    expect(s.canUndo).toBe(true);
    s.undo();
    expect(s.canUndo).toBe(false);
    await s.save();
    await s.reloadFromDisk();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(true);
  });

  it("review fix: user edits during a group are their own steps", async () => {
    const { s } = await open();
    const g = s.beginGroup();
    s.inGroup(g, () => s.setText(TITLE, "th", "machine"));
    s.setText(HOME, "th", "by hand");
    s.endGroup(g);
    s.undo(); // the run
    expect(s.value(TITLE, "th")).toEqual(text("สวัสดี"));
    expect(s.value(HOME, "th")).toEqual(text("by hand"));
    s.undo(); // the hand edit
    expect(s.value(HOME, "th")).toEqual(text("หน้าแรก"));
  });

  it("review fix: rows a sync added during a group survive undoing the group", async () => {
    const { s } = await open();
    const g = s.beginGroup();
    s.inGroup(g, () => s.setText(TITLE, "th", "machine"));
    s.external(() => s.insertKey("common::from_sync"));
    s.endGroup(g);
    s.undo();
    expect(s.data.keyOrder).toContain("common::from_sync");
  });

  it("review fix: undoing a rename after a sync added a row restores the key, keeps the new row", async () => {
    const { s } = await open();
    const renamed = s.renameKey(TITLE, "heading");
    s.external(() => s.insertKey("common::from_sync"));
    expect(s.undo()).toEqual({ done: true, skipped: 0 });
    expect(s.data.keyOrder).toContain(TITLE);
    expect(s.data.keyOrder).not.toContain(renamed);
    expect(s.data.keyOrder).toContain("common::from_sync");
    expect(s.value(TITLE, "th")).toEqual(text("สวัสดี"));
  });

  it("review fix: undoing a meta change keeps other meta fields a sync changed since", async () => {
    const w = await openFixtureWorkspace();
    const s = w.session;
    const id = keyId("button", "button_save");
    s.external(() => s.setWorkspaceMeta({ removedInSource: [id] }));
    keepKey(s, id);
    s.external(() => s.setWorkspaceMeta({ duplicates: ["from_sync"] }));
    s.undo();
    expect(s.workspace!.removedInSource).toContain(id);
    expect(s.workspace!.duplicates).toEqual(["from_sync"]);
  });
});
