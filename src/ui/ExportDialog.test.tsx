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
/** Runs between planning and writing (to change a file in between). */
const hooks = vi.hoisted(() => ({ afterPlan: null as null | (() => Promise<void>) }));
vi.mock("../workspace/export", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../workspace/export")>();
  return {
    ...mod,
    planExport: async (...args: Parameters<typeof mod.planExport>) => {
      const plan = await mod.planExport(...args);
      await hooks.afterPlan?.();
      return plan;
    },
  };
});
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
  hooks.afterPlan = null;
  prefs.clear();
  dlg.open.mockReset();
  dlg.save.mockReset();
});
afterEach(async () => {
  cleanup();
  await useApp.getState().closeProject();
});

/** The fixture workspace opened through the store, synced, with the editor shown. */
async function openWs(edit?: (fs: MemoryFs) => Promise<void>): Promise<{ fs: MemoryFs; session: ProjectSession }> {
  const { fs } = await openFixtureWorkspace();
  await edit?.(fs);
  await useApp.getState().closeProject();
  useApp.setState({ fs });
  const d = (await detectProject(fs, R))!;
  await useApp.getState().openProject(R, d, { baseLocale: "th", localesPath: d.localesPath });
  render(<AppShell />);
  const session = useApp.getState().session!;
  if (session.workspace?.source) {
    await waitFor(() => expect(session.data.keyOrder).toContain(keyId("dashboardMaguro", "maguro_brand")));
  }
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
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Already up to date."));
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
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Resolve conflicts before exporting.");
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

  it("asks before replacing existing files; Cancel writes nothing, Replace writes", async () => {
    const { fs } = await openWs();
    const user = userEvent.setup();
    dlg.open.mockResolvedValue(LOCALES);
    const before = await sourceFiles(fs);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("radio", { name: "TypeScript modules (table style)" }));
    await user.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    await exportNow(dialog, user);
    const ask = await within(dialog).findByRole("region", { name: "Files to replace" });
    expect(ask).toHaveTextContent("These files already exist and will be replaced:");
    expect(within(ask).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      `${LOCALES}/change-password.ts`, `${LOCALES}/common.ts`, `${LOCALES}/mapLocale.ts`,
    ]);
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(within(dialog).queryByRole("region", { name: "Files to replace" })).toBeNull();
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(await sourceFiles(fs)).toEqual(before);
    expect(await fs.exists(`${LOCALES}/button.ts`)).toBe(false);

    await exportNow(dialog, user);
    await user.click(within(await within(dialog).findByRole("region", { name: "Files to replace" })).getByRole("button", { name: "Replace" }));
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Exported 5 files.");
    expect(await fs.readText(`${LOCALES}/mapLocale.ts`)).not.toBe(before["assets/locales/mapLocale.ts"]);
    expect(await fs.exists(`${LOCALES}/button.ts`)).toBe(true);
  });

  it("hides both TypeScript targets without a source", async () => {
    await openWs(async (fs) => {
      const path = `${R}/${WORKSPACE_META_PATH}`;
      const meta = JSON.parse(await fs.readText(path));
      delete meta.source;
      meta.lastExport = { target: { kind: "ts-copy", dir: "/out" } };
      await fs.writeTextAtomic(path, JSON.stringify(meta));
    });
    const dialog = await openDialog();
    expect(within(dialog).queryByRole("radio", { name: "Write back to the original files" })).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: "Write TypeScript files to another folder" })).toBeNull();
    expect(within(dialog).getByRole("radio", { name: "i18next JSON" })).toBeChecked();
  });

  it("refuses to write when the code changed between planning and writing", async () => {
    const { fs, session } = await openWs();
    session.setText(keyId("button", "button_ok"), "en", "Okay");
    hooks.afterPlan = () => replaceIn(fs, BUTTON, "button_save: 'Save'", "button_save: 'Save it'");
    const dialog = await openDialog();
    await exportNow(dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/^Your code changed while exporting\. Export again\.$/);
    const text = await fs.readText(BUTTON);
    expect(text).toContain("button_save: 'Save it'"); // the developer's change
    expect(text).toContain("button_ok: 'OK'"); // the export's isn't written
    expect(within(dialog).queryByRole("status")).toBeNull();
  });

  it("a write failing on the second file says how many were written", async () => {
    const { fs } = await openWs();
    dlg.open.mockResolvedValue("/out");
    const real = fs.writeTextAtomic.bind(fs);
    let outWrites = 0;
    fs.writeTextAtomic = async (path, text) => {
      if (path.startsWith("/out/") && ++outWrites === 2) throw new Error("disk full");
      return real(path, text);
    };
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("radio", { name: "i18next JSON" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    await exportNow(dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/^1 files were written before the error: disk full$/);

    outWrites = 1; // the next write fails: nothing written
    await exportNow(dialog);
    // The file written the first time already exists now.
    const ask = await within(dialog).findByRole("region", { name: "Files to replace" });
    expect(within(ask).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.click(within(ask).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/^Export failed: disk full$/));
  });

  it("a failing sync after a successful write is a warning, not a failure", async () => {
    const { fs, session } = await openWs();
    session.setText(keyId("button", "button_ok"), "en", "Okay");
    const real = fs.writeTextAtomic.bind(fs);
    const exists = fs.exists.bind(fs);
    let written = false;
    fs.writeTextAtomic = async (path, text) => {
      await real(path, text);
      if (path.endsWith(BASELINE_PATH)) written = true;
    };
    fs.exists = async (path) => {
      if (written) throw new Error("watcher hiccup");
      return exists(path);
    };
    const dialog = await openDialog();
    await exportNow(dialog);
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Exported 1 file.");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByRole("list", { name: "Warnings" })).toHaveTextContent(
      "The files were written, but updating the workspace afterwards failed: watcher hiccup",
    );
    expect(await fs.readText(BUTTON)).toContain("button_ok: 'Okay'");
  });

  it("Close is disabled while exporting", async () => {
    const { fs, session } = await openWs();
    session.setText(keyId("button", "button_ok"), "en", "Okay");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = fs.writeTextAtomic.bind(fs);
    fs.writeTextAtomic = async (path, text) => {
      if (path === BUTTON) await gate;
      return real(path, text);
    };
    const dialog = await openDialog();
    await exportNow(dialog);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled());
    release();
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Exported 1 file.");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();
  });
});

describe("Figma export option", () => {
  const FIG = `${R}/design/figma/ALL`;
  const withFigma = async (fs: MemoryFs) => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const dir = resolve(__dirname, "../test/fixtures/figma/ALL");
    for (const f of ["ENG.tokens.json", "TH.tokens.json"]) await fs.writeTextAtomic(`${FIG}/${f}`, readFileSync(`${dir}/${f}`, "utf8"));
    const metaPath = `${R}/${WORKSPACE_META_PATH}`;
    const meta = JSON.parse(await fs.readText(metaPath));
    meta.figma = { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {} };
    await fs.writeTextAtomic(metaPath, JSON.stringify(meta, null, 2));
  };

  it("shows the unmapped count and the Figma option", async () => {
    const { session } = await openWs(withFigma);
    await waitFor(() => expect(session.data.keyOrder).toContain(keyId("figma-ALL", "ข้อมูลการรับประกัน")));
    const dialog = await openDialog();
    expect(within(dialog).getByText("3 Figma strings have no code key yet — write-back skips them.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "i18next JSON" }));
    expect(within(dialog).getByText("3 Figma strings have no code key yet — they use their Figma names as keys.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Figma Variables (.tokens.json)" }));
    expect(within(dialog).getByText(`${R}/design/figma`)).toBeInTheDocument();
  });

  it("exporting to the Figma folder after one edit changes only that $value", async () => {
    const { fs, session } = await openWs(withFigma);
    const id = keyId("figma-ALL", "ข้อมูลการรับประกัน");
    await waitFor(() => expect(session.data.keyOrder).toContain(id));
    if (session.isDirty()) await useApp.getState().save();
    const before = await fs.readText(`${FIG}/TH.tokens.json`);
    session.setText(id, "th", "ข้อมูลประกัน");
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Figma Variables (.tokens.json)" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Export" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "Replace" }));
    await within(dialog).findByRole("status");
    const after = await fs.readText(`${FIG}/TH.tokens.json`);
    const diff = after.split("\n").filter((l, i) => l !== before.split("\n")[i]);
    expect(diff).toEqual(['    "$value": "ข้อมูลประกัน",']);
  });

  it("no Figma option for a workspace without Figma files", async () => {
    await openWs();
    const dialog = await openDialog();
    expect(within(dialog).queryByRole("radio", { name: "Figma Variables (.tokens.json)" })).toBeNull();
  });
});
