import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
const dlg = vi.hoisted(() => ({ save: vi.fn(), open: vi.fn() }));
const zip = vi.hoisted(() => ({ zipWrite: vi.fn(), zipRead: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: vi.fn(async () => {}) }),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => dlg);
vi.mock("../platform/zip", () => zip);
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { keyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { MemoryFs } from "../platform/memory-fs";
import { buildPackage } from "../package/build";
import { MANIFEST_PATH } from "../package/manifest";
import { openIncoming } from "../package/diff";
import { AppShell } from "./AppShell";
import { useApp } from "./store";

const R = "/project";
const j = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const c = (k: string) => keyId("common", k);
const CONFIG = "module.exports = {\n  i18n: { defaultLocale: 'en', locales: ['en', 'th', 'ja'] },\n};\n";
type Entries = Array<{ path: string; text: string }>;

beforeAll(() => {
  const isRow = (el: Element) => el.hasAttribute("data-index");
  const rect = (el: Element) => (isRow(el) ? { w: 1000, h: 40 } : { w: 1000, h: 1000 });
  HTMLElement.prototype.getBoundingClientRect = function () {
    const { w, h } = rect(this);
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON() {} } as DOMRect;
  };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

const files = () => ({
  [`${R}/next-i18next.config.js`]: CONFIG,
  [`${R}/public/locales/en/common.json`]: j({ a: "A", b: "B", c: "C" }),
  [`${R}/public/locales/th/common.json`]: j({ a: "เอ", c: "ซี" }),
  [`${R}/public/locales/ja/common.json`]: j({ a: "エー" }),
});

async function open(fs = new MemoryFs(files()), page = "Import / Export"): Promise<ProjectSession> {
  await useApp.getState().closeProject();
  useApp.setState({ fs });
  const d = (await detectProject(fs, R))!;
  await useApp.getState().openProject(R, d, { baseLocale: "en", localesPath: d.localesPath });
  render(<AppShell />);
  await userEvent.click(screen.getByRole("button", { name: page }));
  return useApp.getState().session!;
}

async function pkgFrom(s: ProjectSession, edit?: (t: ProjectSession) => void): Promise<Entries> {
  const pkg = await buildPackage(s, { locales: ["th", "ja"], now: new Date("2026-11-02T10:00:00Z") });
  if (!edit) return pkg;
  const { session } = await openIncoming(pkg);
  edit(session);
  await session.save();
  const fs = session.fs as MemoryFs;
  return Object.entries(fs.snapshot()).map(([p, text]) => ({ path: p.replace(/^\/incoming\//, ""), text }));
}

beforeEach(() => {
  prefs.clear();
  dlg.save.mockReset();
  dlg.open.mockReset();
  zip.zipWrite.mockReset();
  zip.zipRead.mockReset();
  zip.zipWrite.mockResolvedValue(undefined);
});
afterEach(async () => {
  cleanup();
  await useApp.getState().closeProject();
});

describe("Import / Export page", () => {
  it("sidebar shows Import / Export and navigates", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Import / Export" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Export for translator" })).toBeTruthy();
  });

  it("disables Export with a note while dirty", async () => {
    const s = await open();
    act(() => s.setText(c("b"), "th", "บี"));
    expect((screen.getByRole("button", { name: "Export…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Save your changes first.")).toBeTruthy();
  });

  it("exports: assigns an id, saves, writes the zip with the manifest", async () => {
    const s = await open();
    expect(s.state.project.id).toBeFalsy();
    dlg.save.mockResolvedValue("/out/project-package.zip");
    await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(zip.zipWrite).toHaveBeenCalled());
    expect(s.state.project.id).toBeTruthy();
    expect(zip.zipWrite.mock.calls[0][0]).toBe("/out/project-package.zip");
    const entries = zip.zipWrite.mock.calls[0][1] as Entries;
    expect(entries.map((e) => e.path)).toContain(".retrans/package.json");
    expect(dlg.save.mock.calls[0][0].filters).toEqual([{ name: "Retrans package", extensions: ["zip"] }]);
    expect((await screen.findByRole("status")).textContent).toBe("Exported project-package.zip.");
  });

  it("only exports the checked locales", async () => {
    await open();
    dlg.save.mockResolvedValue("/out/p.zip");
    await userEvent.click(screen.getByRole("checkbox", { name: "ja" }));
    await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(zip.zipWrite).toHaveBeenCalled());
    const paths = (zip.zipWrite.mock.calls[0][1] as Entries).map((e) => e.path);
    expect(paths.some((p) => p.includes("/th/"))).toBe(true);
    expect(paths.some((p) => p.includes("/ja/"))).toBe(false);
  });

  it("cancelling the save dialog does nothing", async () => {
    await open();
    dlg.save.mockResolvedValue(null);
    await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(dlg.save).toHaveBeenCalled());
    expect(zip.zipWrite).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows an ExportError message", async () => {
    const fs = new MemoryFs({ ...files(), [`${R}/.retrans/state.json`]: "<<<<<<< nope" });
    await open(fs);
    await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Fix .retrans/state.json before exporting.");
    expect(zip.zipWrite).not.toHaveBeenCalled();
  });

  it("package projects say Send back to the developer", async () => {
    const dev = await open();
    dev.setProjectSetting({ id: "p1" });
    await useApp.getState().save();
    const pkg = await pkgFrom(dev);
    cleanup();
    const fs = new MemoryFs(Object.fromEntries(pkg.map((e) => [`${R}/${e.path}`, e.text])));
    await open(fs);
    expect(await screen.findByRole("heading", { name: "Send back to the developer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export…" })).toBeTruthy();
  });
});

describe("Import", () => {
  async function devWithPackage(edit: (t: ProjectSession) => void, mutate?: (e: Entries) => Entries) {
    const s = await open();
    s.setProjectSetting({ id: "p1" });
    await useApp.getState().save();
    let back = await pkgFrom(s, edit);
    if (mutate) back = mutate(back);
    zip.zipRead.mockResolvedValue(back);
    dlg.open.mockResolvedValue("/in/back.zip");
    return s;
  }
  const importZip = () => userEvent.click(screen.getByRole("button", { name: "Import package (.zip)…" }));

  it("shows counts, applies picks, and reports", async () => {
    const s = await devWithPackage((t) => {
      t.setText(c("b"), "th", "บี");
      t.setText(c("a"), "th", "เอ2");
    });
    s.setText(c("a"), "th", "เอ-mine");
    await waitFor(() => expect(s.isDirty()).toBe(true));
    await useApp.getState().save();
    await importZip();
    const d = await screen.findByRole("dialog", { name: "Import translator work" });
    expect(within(d).getByText("1 new")).toBeTruthy();
    expect(within(d).getByText("1 conflicts")).toBeTruthy();
    expect(within(d).getByText("0 skipped")).toBeTruthy();
    await userEvent.click(within(d).getByRole("radio", { name: "Use theirs" }));
    await userEvent.click(within(d).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(s.value(c("a"), "th")).toEqual({ kind: "text", text: "เอ2" });
    expect(s.value(c("b"), "th")).toEqual({ kind: "text", text: "บี" });
    expect((await screen.findByRole("status")).textContent).toBe("Imported 2 changes. Review and save.");
  });

  it("Cancel and picker cancel change nothing", async () => {
    const s = await devWithPackage((t) => t.setText(c("b"), "th", "บี"));
    dlg.open.mockResolvedValueOnce(null);
    await importZip();
    expect(zip.zipRead).not.toHaveBeenCalled();
    await importZip();
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s.value(c("b"), "th")).toBeUndefined();
    expect(s.isDirty()).toBe(false);
  });

  it("warns about another project", async () => {
    await devWithPackage(
      (t) => t.setText(c("b"), "th", "บี"),
      (e) => e.map((x) => (x.path === MANIFEST_PATH ? { ...x, text: x.text.replace("p1", "other") } : x)),
    );
    await importZip();
    expect(await screen.findByText("This package came from a different project. Matching keys will still be merged.")).toBeTruthy();
  });

  it("notes a missing manifest", async () => {
    await devWithPackage(
      (t) => t.setText(c("b"), "th", "บี"),
      (e) => e.filter((x) => x.path !== MANIFEST_PATH),
    );
    await importZip();
    expect(await screen.findByText("No package info: only values are merged.")).toBeTruthy();
  });

  it("says Nothing to import.", async () => {
    await devWithPackage(() => {});
    await importZip();
    const d = await screen.findByRole("dialog");
    expect(within(d).getByText("Nothing to import.")).toBeTruthy();
    await userEvent.click(within(d).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a friendly error for an unreadable zip", async () => {
    await open();
    dlg.open.mockResolvedValue("/in/bad.zip");
    zip.zipRead.mockRejectedValue(new Error("No such file (os error 2)"));
    await importZip();
    expect((await screen.findByRole("alert")).textContent).toBe("This file isn't a Retrans package or project.");
  });

  it("caps the list for large diffs", async () => {
    const many = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`k${i}`, `V${i}`]));
    const fs = new MemoryFs({ ...files(), [`${R}/public/locales/en/common.json`]: j(many) });
    const s = await open(fs);
    s.setProjectSetting({ id: "p1" });
    await useApp.getState().save();
    const back = await pkgFrom(s, (t) => {
      for (let i = 0; i < 450; i++) t.setText(c(`k${i}`), "th", `T${i}`);
    });
    zip.zipRead.mockResolvedValue(back);
    dlg.open.mockResolvedValue("/in/b.zip");
    await importZip();
    const d = await screen.findByRole("dialog");
    expect(within(d).getByText("450 new")).toBeTruthy();
    expect(within(d).getByText(/^\+\d+ more/)).toBeTruthy();
    expect(within(d).getAllByRole("listitem").length).toBeLessThanOrEqual(300);
  });
});
