/**
 * The workspace Export dialog: targets, folder picker, the save → sync → plan → write flow,
 * blocked exports (duplicates, conflicts), the result panel and the remembered target.
 * Layout primitives are stubbed as in workspace-cells.test.tsx.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
const dlg = vi.hoisted(() => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => dlg);
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { keyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import type { MemoryFs } from "../platform/memory-fs";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { BASELINE_PATH, parseWorkspaceMeta, WORKSPACE_META_PATH } from "../workspace/meta";
import { AppShell } from "./AppShell";
import { useApp } from "./store";

const R = "/project";
const LOCALES = `${R}/src/assets/locales`;
const BUTTON = `${LOCALES}/button.tsx`;

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

beforeEach(() => {
  prefs.clear();
  dlg.open.mockReset();
  dlg.save.mockReset();
});
afterEach(async () => {
  cleanup();
  await useApp.getState().closeProject();
});

/** The fixture workspace opened through the store, synced, with the editor shown. */
async function openWs(): Promise<{ fs: MemoryFs; session: ProjectSession }> {
  const { fs } = await openFixtureWorkspace();
  await useApp.getState().closeProject();
  useApp.setState({ fs });
  const d = (await detectProject(fs, R))!;
  await useApp.getState().openProject(R, d, { baseLocale: "th", localesPath: d.localesPath });
  render(<AppShell />);
  const session = useApp.getState().session!;
  await waitFor(() => expect(session.data.keyOrder).toContain(keyId("dashboardMaguro", "maguro_brand")));
  // The open-time sync only records a baseline; start from a saved, clean session.
  if (session.isDirty()) await useApp.getState().save();
  return { fs, session };
}

async function sourceFiles(fs: MemoryFs): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await fs.listFiles(`${R}/src`, 8)) out[f] = await fs.readText(`${R}/src/${f}`);
  return out;
}

async function replaceIn(fs: MemoryFs, path: string, from: string, to: string) {
  const text = await fs.readText(path);
  if (!text.includes(from)) throw new Error(`"${from}" not in ${path}`);
  await fs.writeTextAtomic(path, text.replace(from, to));
}

async function openDialog(user = userEvent.setup()) {
  await user.click(screen.getByRole("button", { name: "Export…" }));
  return screen.getByRole("dialog", { name: "Export" });
}

async function exportNow(dialog: HTMLElement, user = userEvent.setup()) {
  await user.click(within(dialog).getByRole("button", { name: "Export" }));
}

const diskMeta = async (fs: MemoryFs) => parseWorkspaceMeta(await fs.readText(`${R}/${WORKSPACE_META_PATH}`))!;

describe("Export dialog", () => {
  it("offers the targets; write-back is preselected for an imported workspace", async () => {
    await openWs();
    const dialog = await openDialog();
    for (const name of [
      "Write back to the original files",
      "Write TypeScript files to another folder",
      "i18next JSON",
      "Paraglide",
      "TypeScript modules (table style)",
    ]) {
      expect(within(dialog).getByRole("radio", { name })).toBeInTheDocument();
    }
    expect(within(dialog).getByRole("radio", { name: "Write back to the original files" })).toBeChecked();
    expect(within(dialog).queryByRole("button", { name: "Choose folder…" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("radio", { name: "i18next JSON" }));
    expect(within(dialog).getByRole("radio", { name: "One file per group" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "One translation file (translation.json)" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Choose folder…" })).toBeInTheDocument();
    // No folder yet: nothing to export to.
    expect(within(dialog).getByRole("button", { name: "Export" })).toBeDisabled();
  });

  it("is also on the Import / Export page", async () => {
    await openWs();
    await userEvent.click(screen.getByRole("button", { name: "Import / Export" }));
    const section = screen.getByRole("region", { name: "Export translations" });
    await userEvent.click(within(section).getByRole("button", { name: "Export…" }));
    expect(screen.getByRole("dialog", { name: "Export" })).toBeInTheDocument();
  });

  it("write-back saves first and writes only the changed file", async () => {
    const { fs, session } = await openWs();
    const before = await sourceFiles(fs);
    session.setText(keyId("button", "button_ok"), "en", "Okay");
    const dialog = await openDialog();
    await exportNow(dialog);
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Exported 1 file.");
    const after = await sourceFiles(fs);
    for (const f of Object.keys(before)) {
      if (f.endsWith("locales/button.tsx")) expect(after[f]).toContain("  button_ok: 'Okay'\n};");
      else expect(after[f]).toBe(before[f]);
    }
    expect(session.isDirty()).toBe(false);
    expect(JSON.parse(await fs.readText(`${R}/${BASELINE_PATH}`))[keyId("button", "button_ok")].en).toBe("Okay");
    expect((await diskMeta(fs)).lastExport).toEqual({ target: { kind: "ts-writeback" } });
  });

  it("a rename is written back as the new key and leaves the meta; the next export writes nothing", async () => {
    const { fs, session } = await openWs();
    const to = session.renameKey(keyId("button", "button_ok"), "button_okay");
    const dialog = await openDialog();
    await exportNow(dialog);
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Exported 1 file.");
    const text = await fs.readText(BUTTON);
    expect(text).not.toContain("button_ok:");
    expect(text).toContain("  button_okay: 'OK',\n};");
    expect(session.workspace!.renames).toEqual({});
    expect((await diskMeta(fs)).renames).toEqual({});
    expect(session.isDirty()).toBe(false);
    expect(session.data.keyOrder).toContain(to);
    expect(session.data.keyOrder).not.toContain(keyId("button", "button_ok"));

    const before = await sourceFiles(fs);
    await exportNow(dialog);
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Exported 0 files."));
    expect(await sourceFiles(fs)).toEqual(before);
    expect(session.isDirty()).toBe(false);
  });

  it("duplicate keys block a single-namespace JSON export with the exact message", async () => {
    const { fs } = await openWs();
    dlg.open.mockResolvedValue("/out");
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("radio", { name: "i18next JSON" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "One translation file (translation.json)" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    expect(dlg.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(within(dialog).getByText("/out")).toBeInTheDocument();
    await exportNow(dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Can't export while these keys are duplicated: change_pw",
    );
    expect(await fs.exists("/out")).toBe(false);
    expect(within(dialog).queryByRole("status")).toBeNull();
  });

  it("conflicts with the source block write-back and open the conflict dialog", async () => {
    const { fs, session } = await openWs();
    session.setText(keyId("button", "button_ok"), "en", "Okay");
    await replaceIn(fs, BUTTON, "  button_ok: 'OK'", "  button_ok: 'Ok!'");
    const source = await fs.readText(BUTTON);
    const dialog = await openDialog();
    await exportNow(dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Resolve the changes from your code first.");
    expect(screen.getByRole("dialog", { name: "Resolve conflicts" })).toBeInTheDocument();
    expect(await fs.readText(BUTTON)).toBe(source);

    // Still refused while the conflict is open, even with nothing left to save.
    expect(session.isDirty()).toBe(false);
    await exportNow(dialog);
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Resolve the changes from your code first."));
    expect(await fs.readText(BUTTON)).toBe(source);
  });

  it("an open file conflict refuses every export, even with nothing unsaved", async () => {
    const { fs, session } = await openWs();
    dlg.open.mockResolvedValue("/out");
    useApp.setState({ conflicts: [{ id: keyId("common", "email"), locale: "en" }] });
    expect(session.isDirty()).toBe(false);
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("radio", { name: "TypeScript modules (table style)" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    await exportNow(dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Resolve conflicts before saving.");
    expect(await fs.exists("/out")).toBe(false);
  });

  it("shows left-out languages and snippets with Copy buttons", async () => {
    const { session } = await openWs();
    const user = userEvent.setup();
    session.addLanguage("ja");
    session.setText(keyId("button", "button_ok"), "ja", "オーケー");
    session.addNamespace("reports");
    session.addKey("reports", "report_title", "รายงาน");
    const dialog = await openDialog(user);
    await exportNow(dialog, user);
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Exported 1 file.");
    const leftOut = within(dialog).getByRole("region", { name: "Left-out languages" });
    expect(leftOut).toHaveTextContent(
      "Not written to the TypeScript files: ja — export them in another format, or add them to your code:",
    );
    expect(leftOut).toHaveTextContent("'th' | 'en' | 'ja'");
    await user.click(within(leftOut).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toContain("'th' | 'en' | 'ja'");

    const snippets = within(dialog).getByRole("region", { name: "Snippets" });
    expect(snippets).toHaveTextContent("import { reportsTH, reportsEN } from '@/assets/locales/reports';");
    await user.click(within(snippets).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toContain("import { reportsTH, reportsEN }");
  });

  it("lists warnings", async () => {
    const { session } = await openWs();
    dlg.open.mockResolvedValue("/out");
    session.renameKey(keyId("change-password", "change_pw"), "change_pw_title");
    session.setText(keyId("common", "session_expire_in"), "en", "Expires in {{minutes, number}} minutes");
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Paraglide" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    await exportNow(dialog);
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Exported 3 files.");
    expect(within(dialog).getByRole("list", { name: "Warnings" })).toHaveTextContent("Format modifier dropped in session_expire_in");
  });

  it("remembers the last target and preselects it next time", async () => {
    const { fs } = await openWs();
    dlg.open.mockResolvedValue("/out");
    let dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("radio", { name: "i18next JSON" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    await exportNow(dialog);
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Exported 8 files.");
    expect(await fs.readText("/out/en/button.json")).toContain('"button_ok": "OK"');
    expect((await diskMeta(fs)).lastExport).toEqual({ target: { kind: "i18next-json", dir: "/out", namespaces: "per-group" } });
    // Untouched: the TypeScript sources.
    expect(await fs.readText(BUTTON)).toContain("button_ok: 'OK'");

    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Export" })).toBeNull();
    dialog = await openDialog();
    expect(within(dialog).getByRole("radio", { name: "i18next JSON" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "One file per group" })).toBeChecked();
    expect(within(dialog).getByText("/out")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Export" })).toBeEnabled();
  });
});
