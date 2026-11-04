/**
 * Workspace rows in the editor: drafts, empty keys, read-only entries, duplicate keys,
 * removed-in-source, a missing source, sync conflicts and the recovery journal.
 * Layout primitives are stubbed as in views.test.tsx.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
const watch = vi.hoisted(() => ({ cb: null as null | ((paths: string[]) => void) }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
vi.mock("../platform/watch", () => ({
  watchDir: vi.fn(async (_root: string, cb: (paths: string[]) => void) => {
    watch.cb = cb;
    return async () => {};
  }),
}));

import { keyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { journalPath, readJournal, writeJournal } from "../core/recovery";
import { diffPackage } from "../package/diff";
import { detectProject } from "../formats/detect";
import type { MemoryFs } from "../platform/memory-fs";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { AppShell } from "./AppShell";
import { useApp } from "./store";

const LOCALES = "/project/src/assets/locales";

beforeAll(() => {
  const isRow = (el: Element) => el.hasAttribute("data-index");
  const rect = (el: Element) => (isRow(el) ? { w: 1000, h: 40 } : { w: 1000, h: 1000 });
  HTMLElement.prototype.getBoundingClientRect = function () {
    const { w, h } = rect(this);
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON() {} } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return rect(this).h; } });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get() { return rect(this).h; } });
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get() { return rect(this).w; } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return rect(this).w; } });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

/** The fixture workspace on disk, optionally changed (`edit`) before it is opened through the store. */
async function openWs(
  edit?: (fs: MemoryFs) => Promise<void>, opts: { waitSync?: boolean } = {},
): Promise<{ fs: MemoryFs; session: ProjectSession }> {
  const { fs } = await openFixtureWorkspace();
  await edit?.(fs);
  await useApp.getState().closeProject();
  useApp.setState({ fs });
  const d = (await detectProject(fs, "/project"))!;
  await useApp.getState().openProject("/project", d, { baseLocale: "th", localesPath: d.localesPath });
  render(<AppShell />);
  const session = useApp.getState().session!;
  // Sync on open is async; it is done once the read-only row has been added.
  if (opts.waitSync !== false) await waitFor(() => expect(session.data.keyOrder).toContain(keyId("dashboardMaguro", "maguro_brand")));
  return { fs, session };
}

const row = (id: string) => {
  const el = document.querySelector<HTMLElement>(`[data-row="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el;
};
const cell = (id: string, locale: string) => row(id).querySelector<HTMLElement>(`[data-locale="${locale}"]`)!;

async function replaceIn(fs: MemoryFs, path: string, from: string, to: string) {
  const text = await fs.readText(path);
  if (!text.includes(from)) throw new Error(`"${from}" not in ${path}`);
  await fs.writeTextAtomic(path, text.replace(from, to));
}

beforeEach(() => {
  prefs.clear();
  watch.cb = null;
});
afterEach(async () => {
  cleanup();
  await useApp.getState().closeProject();
});

describe("workspace cells", () => {
  it("a missing cell with a draft shows it; Accept is a hand edit and removes the draft", async () => {
    const { session } = await openWs();
    const id = keyId("button", "button_reset_password");
    const c = cell(id, "en");
    expect(c).toHaveTextContent("Draft: Reset password");
    await userEvent.click(within(c).getByRole("button", { name: "Accept draft" }));
    expect(session.value(id, "en")).toEqual({ kind: "text", text: "Reset password" });
    expect(session.meta(id, "en")).toMatchObject({ status: "translated", machine: false });
    expect(session.workspace!.drafts[id]).toBeUndefined();
    expect(cell(id, "en")).not.toHaveTextContent("Draft:");
    // Other drafts stay.
    expect(session.workspace!.drafts[keyId("common", "only_en")]).toEqual({ en: "Only EN" });
  });

  it("a key with no value in any language is a row whose cells can be edited", async () => {
    const { session } = await openWs();
    const id = keyId("common", "only_en");
    expect(cell(id, "th")).toHaveAttribute("data-cell", "missing");
    expect(cell(id, "en")).toHaveTextContent("Draft: Only EN");
    await userEvent.click(cell(id, "th"));
    const box = await screen.findByRole("textbox");
    await userEvent.type(box, "เฉพาะ{Enter}");
    expect(session.value(id, "th")).toEqual({ kind: "text", text: "เฉพาะ" });
  });

  it("a read-only entry says so and can't be edited", async () => {
    const { session } = await openWs();
    const id = keyId("dashboardMaguro", "maguro_brand");
    for (const l of ["th", "en"]) {
      const c = cell(id, l);
      expect(c).toHaveTextContent("Can't edit here (computed in code)");
      await userEvent.click(c);
    }
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(() => session.setText(id, "en", "x")).toThrow();
    // Other rows of that file stay editable.
    expect(cell(keyId("dashboardMaguro", "maguro_dash_title"), "en")).toHaveAttribute("data-cell", "value");
  });

  it("a duplicate key shows the warning on both rows", async () => {
    await openWs();
    expect(row(keyId("common", "change_pw"))).toHaveTextContent("Duplicate key — also in change-password");
    expect(row(keyId("change-password", "change_pw"))).toHaveTextContent("Duplicate key — also in common");
    expect(row(keyId("common", "email"))).not.toHaveTextContent("Duplicate key");
  });

  it("removed in source: badge; Keep clears it", async () => {
    const { session } = await openWs((fs) => replaceIn(fs, `${LOCALES}/common.ts`, "  logout: { th: 'ออกจากระบบ', en: 'Logout' },\n", ""));
    const id = keyId("common", "logout");
    await waitFor(() => expect(row(id)).toHaveTextContent("Removed in source"));
    await userEvent.click(within(row(id)).getByRole("button", { name: "Actions for logout" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Keep (will be written back to your code)" }));
    expect(session.workspace!.removedInSource).toEqual([]);
    expect(row(id)).not.toHaveTextContent("Removed in source");
    expect(session.data.keyOrder).toContain(id);
  });

  it("removed in source: Delete key removes the row and the mark", async () => {
    const { session } = await openWs((fs) => replaceIn(fs, `${LOCALES}/common.ts`, "  logout: { th: 'ออกจากระบบ', en: 'Logout' },\n", ""));
    const id = keyId("common", "logout");
    await waitFor(() => expect(row(id)).toHaveTextContent("Removed in source"));
    await userEvent.click(within(row(id)).getByRole("button", { name: "Actions for logout" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete key" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Delete key" })).getByRole("button", { name: "Delete" }));
    expect(session.data.keyOrder).not.toContain(id);
    expect(session.workspace!.removedInSource).toEqual([]);
  });

  it("shows a banner when the source files are gone", async () => {
    await openWs((fs) => fs.remove(LOCALES), { waitSync: false });
    expect(await screen.findByText("Source files not found — showing the saved workspace.")).toBeInTheDocument();
    expect(useApp.getState().sourceMissing).toBe(true);
  });

  it("an invalid source folder setting shows its own banner and is never synced from", async () => {
    const { fs, session } = await openWs(async (fs) => {
      const path = "/project/.retrans/workspace.json";
      const meta = JSON.parse(await fs.readText(path));
      meta.source.localesDir = "../elsewhere";
      await fs.writeTextAtomic(path, JSON.stringify(meta));
    }, { waitSync: false });
    expect(
      await screen.findByText("The workspace's source folder setting is invalid — showing the saved workspace."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Source files not found — showing the saved workspace.")).toBeNull();
    expect(session.workspace!.source).toBeUndefined();
    // Saving keeps the setting as it was in the file.
    session.setText(keyId("common", "email"), "en", "E-mail");
    expect(await useApp.getState().save()).toBe(true);
    expect(JSON.parse(await fs.readText("/project/.retrans/workspace.json")).source).toEqual({ type: "ts", localesDir: "../elsewhere" });
  });

  it("source conflicts block Save and are resolved through the sync", async () => {
    const id = keyId("button", "button_save");
    const { session } = await openWs(async (fs) => {
      await replaceIn(fs, `${LOCALES}/button.tsx`, "button_save: 'Save',", "button_save: 'Save it',");
      await replaceIn(fs, "/project/.retrans/workspace/en/button.json", '"button_save": "Save"', '"button_save": "Store"');
    });
    const dlg = await screen.findByRole("dialog", { name: "Resolve conflicts" });
    expect(dlg).toHaveTextContent("Save it");
    expect(useApp.getState().conflicts).toEqual([{ id, locale: "en", mine: { kind: "text", text: "Store" }, theirs: { kind: "text", text: "Save it" }, origin: "source" }]);
    act(() => session.setText(keyId("common", "email"), "en", "E-mail")); // something to save
    await act(async () => {
      expect(await useApp.getState().save()).toBe(false);
    });
    expect(useApp.getState().error).toBe("Resolve conflicts before saving.");
    await userEvent.click(within(dlg).getByRole("button", { name: "Theirs" }));
    expect(session.value(id, "en")).toEqual({ kind: "text", text: "Save it" });
    expect(session.pendingBaseline![id].en).toBe("Save it");
    expect(useApp.getState().conflicts).toEqual([]);
    await act(async () => {
      expect(await useApp.getState().save()).toBe(true);
    });
  });

  it("source conflicts survive a workspace reload (not dropped as file conflicts)", async () => {
    const id = keyId("button", "button_save");
    const { session } = await openWs(async (fs) => {
      await replaceIn(fs, `${LOCALES}/button.tsx`, "button_save: 'Save',", "button_save: 'Save it',");
      await replaceIn(fs, "/project/.retrans/workspace/en/button.json", '"button_save": "Save"', '"button_save": "Store"');
    });
    await screen.findByRole("dialog", { name: "Resolve conflicts" });
    await act(async () => {
      watch.cb!(["/project/.retrans/workspace/th/common.json"]);
      await session.reloadFromDisk();
    });
    expect(useApp.getState().conflicts.map((c) => c.id)).toEqual([id]);
  });

  it("a change under the source folder runs a sync", async () => {
    const { fs, session } = await openWs();
    await replaceIn(fs, `${LOCALES}/button.tsx`, "  button_ok: 'OK'\n", "  button_ok: 'OK',\n  button_export: 'Export'\n");
    await replaceIn(fs, `${LOCALES}/button.tsx`, "  button_ok: 'ตกลง',\n", "  button_ok: 'ตกลง',\n  button_export: 'ส่งออก',\n");
    act(() => watch.cb!([`${LOCALES}/button.tsx`]));
    await waitFor(() => expect(session.value(keyId("button", "button_export"), "en")).toEqual({ kind: "text", text: "Export" }));
    await waitFor(() => expect(document.querySelector(`[data-row="${keyId("button", "button_export")}"]`)).not.toBeNull());
  });
});

describe("recovery journal and workspace meta", () => {
  it("round-trips unsaved meta changes (draft accepted, Keep), never the pending baseline", async () => {
    const a = await openFixtureWorkspace();
    const draftId = keyId("button", "button_reset_password");
    const logout = keyId("common", "logout");
    a.session.setWorkspaceMeta({ removedInSource: [logout] });
    await a.session.save();
    // Unsaved: accept a draft, Keep the removed key, a pending baseline.
    a.session.batch(() => {
      a.session.setText(draftId, "en", "Reset password");
      a.session.setWorkspaceMeta({ drafts: {}, removedInSource: [] });
      a.session.setPendingBaseline({ [logout]: { th: "x" } });
    });
    const j = JSON.parse(JSON.stringify(a.session.toJournal()));
    expect(j.workspaceMeta).toEqual({ drafts: {}, removedInSource: [] });
    expect(JSON.stringify(j)).not.toContain('"x"');
    await a.fs.writeTextAtomic("/j.json", JSON.stringify(j));
    const read = (await readJournal(a.fs, "/j.json"))!;
    expect(read.workspaceMeta).toEqual({ drafts: {}, removedInSource: [] });

    const d = (await detectProject(a.fs, "/project"))!;
    const b = await ProjectSession.open(a.fs, "/project", d, { baseLocale: "th", localesPath: d.localesPath });
    expect(b.workspace!.removedInSource).toEqual([logout]);
    b.applyJournal(read);
    expect(b.workspace!.removedInSource).toEqual([]);
    expect(b.workspace!.drafts).toEqual({});
    expect(b.value(draftId, "en")).toEqual({ kind: "text", text: "Reset password" });
    expect(b.pendingBaseline).toBeNull();
    expect(b.isDirty()).toBe(true);
  });

  it("the store's journal carries the meta patch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { fs, session } = await openWs();
      act(() => session.setWorkspaceMeta({ drafts: {} }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      const files = Object.keys(fs.snapshot()).filter((p) => p.startsWith("/appdata/recovery/"));
      expect(files).toHaveLength(1);
      expect((await readJournal(fs, files[0]))!.workspaceMeta).toEqual({ drafts: {} });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a recovery journal on open is applied before the source sync", () => {
  const SAVE = keyId("button", "button_save");
  /** Journal: en button_save "Save" → "Store" (unsaved). Source then changes it to "Save it". */
  async function journalAndSourceChange(fs: MemoryFs) {
    const d = (await detectProject(fs, "/project"))!;
    const a = await ProjectSession.open(fs, "/project", d, { baseLocale: "th", localesPath: d.localesPath });
    a.setText(SAVE, "en", "Store");
    await writeJournal(fs, journalPath("/appdata", "/project"), a.toJournal());
    await replaceIn(fs, `${LOCALES}/button.tsx`, "button_save: 'Save',", "button_save: 'Save it',");
  }

  it("the journaled edit and the source change surface as a source conflict", async () => {
    const { session } = await openWs(journalAndSourceChange, { waitSync: false });
    expect(useApp.getState().recovery).toBeNull();
    await waitFor(() => expect(useApp.getState().conflicts).toEqual([
      { id: SAVE, locale: "en", mine: { kind: "text", text: "Store" }, theirs: { kind: "text", text: "Save it" }, origin: "source" },
    ]));
    expect(session.value(SAVE, "en")).toEqual({ kind: "text", text: "Store" });
  });
});

describe("renaming a workspace key", () => {
  it("moves emptyKeys, drafts and markers to the new id; the row survives save and reopen", async () => {
    const { fs, session } = await openFixtureWorkspace();
    const from = keyId("common", "only_en");
    const to = keyId("common", "only_english");
    session.renameKey(from, "only_english");
    const m = session.workspace!;
    expect(m.emptyKeys).toEqual([to]);
    expect(m.drafts[to]).toEqual({ en: "Only EN" });
    expect(m.markers[to]).toEqual({ en: "Only EN (EN)" });
    expect(m.drafts[from]).toBeUndefined();
    expect(m.markers[from]).toBeUndefined();
    expect(session.data.keyOrder).toContain(to);
    expect(session.data.keyOrder).not.toContain(from);
    expect(session.toJournal().workspaceMeta).toMatchObject({ emptyKeys: [to] });
    await session.save();
    const d = (await detectProject(fs, "/project"))!;
    const b = await ProjectSession.open(fs, "/project", d, { baseLocale: "th", localesPath: d.localesPath });
    expect(b.data.keyOrder).toContain(to);
    expect(b.data.keyOrder).not.toContain(from);
  });

  it("moves removedInSource and a draft of a key with values", async () => {
    const { session } = await openFixtureWorkspace();
    const from = keyId("button", "button_reset_password");
    const to = keyId("button", "button_reset_pw");
    session.setWorkspaceMeta({ removedInSource: [from] });
    session.renameKey(from, "button_reset_pw");
    expect(session.workspace!.removedInSource).toEqual([to]);
    expect(session.workspace!.drafts[to]).toEqual({ en: "Reset password" });
    expect(session.workspace!.markers[to]).toEqual({ en: "Reset password (EN)" });
  });

  it("refuses to rename a key computed in code", async () => {
    const { session } = await openFixtureWorkspace();
    expect(() => session.renameKey(keyId("dashboardMaguro", "maguro_brand"), "brand")).toThrow(
      "Can't rename — this key is computed in code.",
    );
    expect(session.data.keyOrder).toContain(keyId("dashboardMaguro", "maguro_brand"));
  });
});

describe("translator package import into a workspace", () => {
  it("skips read-only cells (read-only-file) and applies the rest", async () => {
    const cur = (await openFixtureWorkspace()).session;
    const inc = (await openFixtureWorkspace()).session;
    const brand = keyId("dashboardMaguro", "maguro_brand");
    const ok = keyId("button", "button_ok");
    inc.importCell(brand, "en", { kind: "text", text: "Brand" }, undefined);
    inc.importCell(ok, "en", { kind: "text", text: "Okay" }, undefined);
    const diff = diffPackage(cur, inc, null);
    expect(diff.items.map((i) => [i.id, i.locale])).toEqual([[ok, "en"]]);
    expect(diff.skipped).toEqual([{ id: brand, locale: "en", reason: "read-only-file" }]);
  });
});

describe("renames survive the sync (through the store)", () => {
  /** Saves through the store, then closes and opens the same folder again (sync runs on open). */
  async function saveAndReopen(fs: MemoryFs): Promise<ProjectSession> {
    await act(async () => {
      expect(await useApp.getState().save()).toBe(true);
    });
    cleanup();
    await useApp.getState().closeProject();
    const d = (await detectProject(fs, "/project"))!;
    await useApp.getState().openProject("/project", d, { baseLocale: "th", localesPath: d.localesPath });
    render(<AppShell />);
    const session = useApp.getState().session!;
    await waitFor(() => expect(session.data.keyOrder).toContain(keyId("dashboardMaguro", "maguro_brand")));
    return session;
  }

  it("an empty key renamed, saved and reopened stays renamed (and again after the next save)", async () => {
    const { fs, session } = await openWs();
    const from = keyId("common", "only_en");
    const to = keyId("common", "only_english");
    act(() => void session.renameKey(from, "only_english"));
    expect(session.workspace!.renames).toEqual({ [from]: to });
    let s = await saveAndReopen(fs);
    expect(s.data.keyOrder).toContain(to);
    expect(s.data.keyOrder).not.toContain(from);
    expect(s.workspace!.emptyKeys).toEqual([to]);
    expect(s.workspace!.removedInSource).toEqual([]);
    expect(cell(to, "en")).toHaveTextContent("Draft: Only EN");
    act(() => s.setText(keyId("common", "email"), "en", "E-mail"));
    s = await saveAndReopen(fs);
    expect(s.data.keyOrder).toContain(to);
    expect(s.data.keyOrder).not.toContain(from);
  });

  it("a key with a draft and marker keeps them on the new id after reopen", async () => {
    const { fs, session } = await openWs();
    const from = keyId("button", "button_reset_password");
    const to = keyId("button", "button_reset_pw");
    act(() => void session.renameKey(from, "button_reset_pw"));
    const s = await saveAndReopen(fs);
    expect(s.data.keyOrder).not.toContain(from);
    expect(s.workspace!.drafts[to]).toEqual({ en: "Reset password" });
    expect(s.workspace!.markers[to]).toEqual({ en: "Reset password (EN)" });
    expect(s.workspace!.drafts[from]).toBeUndefined();
    expect(cell(to, "en")).toHaveTextContent("Draft: Reset password");
    expect(useApp.getState().conflicts).toEqual([]);
  });

  it("a source change to the old id merges into the renamed key", async () => {
    const { fs, session } = await openWs();
    const from = keyId("button", "button_ok");
    const to = keyId("button", "button_okay");
    act(() => void session.renameKey(from, "button_okay"));
    const s = await saveAndReopen(fs);
    await replaceIn(fs, `${LOCALES}/button.tsx`, "  button_ok: 'OK'\n", "  button_ok: 'Okay!'\n");
    act(() => watch.cb!([`${LOCALES}/button.tsx`]));
    await waitFor(() => expect(s.value(to, "en")).toEqual({ kind: "text", text: "Okay!" }));
    expect(s.data.keyOrder).not.toContain(from);
    expect(s.workspace!.removedInSource).toEqual([]);
    expect(useApp.getState().conflicts).toEqual([]);
  });

  it("changed on both sides: a conflict whose mine is the renamed key's value", async () => {
    const { fs, session } = await openWs();
    const from = keyId("button", "button_ok");
    const to = keyId("button", "button_okay");
    act(() => void session.renameKey(from, "button_okay"));
    const s = await saveAndReopen(fs);
    act(() => s.setText(to, "en", "Fine"));
    await replaceIn(fs, `${LOCALES}/button.tsx`, "  button_ok: 'OK'\n", "  button_ok: 'Okay!'\n");
    act(() => watch.cb!([`${LOCALES}/button.tsx`]));
    await waitFor(() => expect(useApp.getState().conflicts).toEqual([
      { id: to, locale: "en", mine: { kind: "text", text: "Fine" }, theirs: { kind: "text", text: "Okay!" }, origin: "source" },
    ]));
    expect(s.data.keyOrder).not.toContain(from);
  });

  it("chains collapse and renaming back to the source id drops the entry", async () => {
    const { fs, session } = await openWs();
    const a = keyId("button", "button_save");
    const b = keyId("button", "button_store");
    const c = keyId("button", "button_keep");
    act(() => void session.renameKey(a, "button_store"));
    act(() => void session.renameKey(b, "button_keep"));
    expect(session.workspace!.renames).toEqual({ [a]: c });
    let s = await saveAndReopen(fs);
    expect(s.data.keyOrder).toContain(c);
    expect(s.data.keyOrder).not.toContain(a);
    expect(s.data.keyOrder).not.toContain(b);
    act(() => void s.renameKey(c, "button_save"));
    expect(s.workspace!.renames).toEqual({});
    s = await saveAndReopen(fs);
    expect(s.data.keyOrder).toContain(a);
    expect(s.data.keyOrder).not.toContain(c);
    expect(s.value(a, "en")).toEqual({ kind: "text", text: "Save" });
  });
});
