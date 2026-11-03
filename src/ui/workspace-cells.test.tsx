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
import { readJournal } from "../core/recovery";
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
    await userEvent.click(screen.getByRole("menuitem", { name: "Keep" }));
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
