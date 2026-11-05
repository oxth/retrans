/** Key/language management, saving, conflicts. Same jsdom virtualizer stubs as views.test.tsx. */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
const win = vi.hoisted(() => ({
  handler: null as null | ((e: { preventDefault(): void }) => void),
  destroy: vi.fn(async () => {}),
  exit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ exit: win.exit }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (h: (e: { preventDefault(): void }) => void) => {
      win.handler = h;
      return () => {};
    },
    destroy: win.destroy,
  }),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));
// No Tauri runtime in tests: stub the update check and the native MT calls App makes on mount.
vi.mock("../platform/updates", () => ({ checkForUpdate: vi.fn(async () => null) }));
vi.mock("../platform/mt", () => ({
  mtNative: {
    modelsDir: vi.fn(async () => "/models"),
    status: vi.fn(async () => []),
    startDownload: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    deleteModel: vi.fn(async () => {}),
    unload: vi.fn(async () => {}),
    onDownload: vi.fn(async () => () => {}),
  },
  tauriEngine: { generate: vi.fn(), cancel: vi.fn() },
  pickGgufFile: vi.fn(async () => null),
}));

import { journalPath } from "../core/recovery";
import type { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { MemoryFs, loadFixtureDir } from "../platform/memory-fs";
import App from "../App";
import { AppShell } from "./AppShell";
import { UnsavedPrompt } from "./UnsavedPrompt";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures") + "/";
const TH = "/project/public/locales/th/common.json";

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

async function open(fs: MemoryFs, shell: "shell" | "app" = "shell"): Promise<ProjectSession> {
  await useApp.getState().closeProject();
  useApp.setState({ fs });
  const d = (await detectProject(fs, "/project"))!;
  await useApp.getState().openProject("/project", d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
  render(
    shell === "app" ? (
      <App />
    ) : (
      <>
        <AppShell />
        <UnsavedPrompt />
      </>
    ),
  );
  return useApp.getState().session!;
}
const nested = () => loadFixtureDir(FIX + "next-nested");
const rowEl = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement | null;

beforeEach(() => {
  prefs.clear();
  win.handler = null;
  win.destroy.mockClear();
  win.exit.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("keys", () => {
  it("add key dialog shows prefix collision error", async () => {
    const s = await open(nested());
    await userEvent.click(screen.getByRole("button", { name: "+ Key" }));
    const dlg = screen.getByRole("dialog", { name: "Add key" });
    await userEvent.selectOptions(within(dlg).getByLabelText("Namespace"), "common");
    await userEvent.type(within(dlg).getByLabelText("Key"), "nav.home.sub");
    await userEvent.type(within(dlg).getByLabelText("Base text"), "Sub");
    await userEvent.click(within(dlg).getByRole("button", { name: "Add" }));
    expect(await within(dlg).findByText(/Conflicts with existing key nav\.home/)).toBeInTheDocument();
    expect(s.data.keyOrder).not.toContain("common::nav.home.sub");

    await userEvent.clear(within(dlg).getByLabelText("Key"));
    await userEvent.type(within(dlg).getByLabelText("Key"), "title");
    await userEvent.click(within(dlg).getByRole("button", { name: "Add" }));
    expect(await within(dlg).findByText("Key already exists")).toBeInTheDocument();

    await userEvent.clear(within(dlg).getByLabelText("Key"));
    await userEvent.type(within(dlg).getByLabelText("Key"), "brand.new");
    await userEvent.click(within(dlg).getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("dialog", { name: "Add key" })).toBeNull();
    expect(s.value("common::brand.new", "en")).toEqual({ kind: "text", text: "Sub" });
    await waitFor(() => expect(rowEl("common::brand.new")).not.toBeNull());
  });

  it("rename and delete update the views", async () => {
    const s = await open(nested());
    await userEvent.click(within(rowEl("common::only_en")!).getByRole("button", { name: "Actions for only_en" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const dlg = screen.getByRole("dialog", { name: "Rename key" });
    await userEvent.clear(within(dlg).getByLabelText("New key"));
    await userEvent.type(within(dlg).getByLabelText("New key"), "nav.home.x");
    await userEvent.click(within(dlg).getByRole("button", { name: "Rename" }));
    expect(await within(dlg).findByText(/Conflicts with existing key nav\.home/)).toBeInTheDocument();
    await userEvent.clear(within(dlg).getByLabelText("New key"));
    await userEvent.type(within(dlg).getByLabelText("New key"), "renamed");
    await userEvent.click(within(dlg).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(rowEl("common::renamed")).not.toBeNull());
    expect(rowEl("common::only_en")).toBeNull();
    expect(s.value("common::renamed", "en")).toEqual({ kind: "text", text: "English only" });

    await userEvent.click(within(rowEl("common::title")!).getByRole("button", { name: "Actions for title" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const del = screen.getByRole("dialog", { name: "Delete key" });
    expect(del).toHaveTextContent("2 languages");
    await userEvent.click(within(del).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(rowEl("common::title")).toBeNull());
    expect(s.data.keyOrder).not.toContain("common::title");
  });

  it("renaming a plural row renames the whole group", async () => {
    const s = await open(nested());
    await userEvent.click(within(rowEl("common::items_one")!).getByRole("button", { name: "Actions for items_one" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const dlg = screen.getByRole("dialog", { name: "Rename key" });
    const input = within(dlg).getByLabelText("New key");
    expect(input).toHaveValue("items");
    await userEvent.clear(input);
    await userEvent.type(input, "things");
    await userEvent.click(within(dlg).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(rowEl("common::things_other")).not.toBeNull());
    expect(s.data.keyOrder).toContain("common::things_one");
    expect(s.data.keyOrder).not.toContain("common::items_one");
  });
});

describe("languages", () => {
  it("adding a next-i18next language shows the copyable snippet", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const s = await open(nested());
    await userEvent.click(screen.getByRole("button", { name: "Languages" }));
    expect(screen.getByRole("button", { name: "Remove en" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Add language" }));
    const dlg = screen.getByRole("dialog", { name: "Add language" });
    await userEvent.type(within(dlg).getByLabelText("Language"), "fr");
    await userEvent.click(within(dlg).getByRole("radio", { name: /^fr(?!-)/ }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Add" }));
    expect(s.data.locales).toContain("fr");
    expect(await screen.findByText("Update your next-i18next config:")).toBeInTheDocument();
    expect(screen.getByTestId("config-snippet").textContent).toMatch(/'fr'/);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("fr"));

    await userEvent.click(screen.getByRole("button", { name: "Remove fr" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Remove language" })).getByRole("button", { name: "Remove" }));
    expect(s.data.locales).not.toContain("fr");
  });

  it("adds a namespace", async () => {
    const s = await open(nested());
    await userEvent.click(screen.getByRole("button", { name: "Languages" }));
    await userEvent.type(screen.getByLabelText("New namespace"), "footer");
    await userEvent.click(screen.getByRole("button", { name: "Add namespace" }));
    expect(s.data.namespaces).toContain("footer");
  });
});

describe("saving", () => {
  it("Cmd+S saves and clears the unsaved dot", async () => {
    const fs = nested();
    const s = await open(fs);
    expect(screen.queryByText("• Unsaved")).toBeNull();
    act(() => s.setText("common::title", "th", "ใหม่"));
    expect(screen.getByText("• Unsaved")).toBeInTheDocument();
    await userEvent.keyboard("{Meta>}s{/Meta}");
    await waitFor(() => expect(screen.queryByText("• Unsaved")).toBeNull());
    expect(JSON.parse(await fs.readText(TH)).title).toBe("ใหม่");
  });

  it("Cmd+S with nothing dirty is a no-op", async () => {
    const fs = nested();
    await open(fs);
    fs.writes.length = 0;
    await userEvent.keyboard("{Meta>}s{/Meta}");
    expect(fs.writes).toEqual([]);
  });

  it("stale save opens ConflictDialog and resolving then saving writes both changes", async () => {
    const fs = nested();
    const s = await open(fs);
    act(() => {
      s.setText("common::title", "th", "MINE");
      s.setText("common::nav.about", "th", "ABOUT-MINE");
    });
    await fs.writeTextAtomic(
      TH,
      JSON.stringify({ title: "THEIRS", nav: { home: "หน้าแรก" }, orphan: "เศษ", extra: "EXTRA" }, null, 2) + "\n",
    );
    await userEvent.keyboard("{Meta>}s{/Meta}");
    const dlg = await screen.findByRole("dialog", { name: "Resolve conflicts" });
    expect(within(dlg).getByText("MINE")).toBeInTheDocument();
    expect(within(dlg).getByText("THEIRS")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Keep all mine" }));
    expect(screen.queryByRole("dialog", { name: "Resolve conflicts" })).toBeNull();
    expect(useApp.getState().conflicts).toEqual([]);
    await userEvent.keyboard("{Meta>}s{/Meta}");
    await waitFor(() => expect(screen.queryByText("• Unsaved")).toBeNull());
    const out = JSON.parse(await fs.readText(TH));
    expect(out.title).toBe("MINE");
    expect(out.nav.about).toBe("ABOUT-MINE");
    expect(out.extra).toBe("EXTRA");
  });

  it("per-conflict Theirs resolves just that one", async () => {
    const fs = nested();
    const s = await open(fs);
    act(() => s.setText("common::title", "th", "MINE"));
    // "Theirs" takes the current disk value, so the conflict has to be a real one.
    const orig = JSON.parse(await fs.readText(TH));
    await fs.writeTextAtomic(TH, JSON.stringify({ ...orig, title: "THEIRS" }, null, 2) + "\n");
    await act(async () => void (await useApp.getState().save()));
    const dlg = await screen.findByRole("dialog", { name: "Resolve conflicts" });
    await userEvent.click(within(dlg).getByRole("button", { name: "Theirs" }));
    expect(s.value("common::title", "th")).toEqual({ kind: "text", text: "THEIRS" });
    expect(useApp.getState().conflicts).toEqual([]);
  });

  it("read-only write errors surface in the error banner", async () => {
    const fs = nested();
    const s = await open(fs);
    act(() => s.setText("common::title", "th", "X"));
    vi.spyOn(fs, "writeTextAtomic").mockRejectedValue(new Error("disk full"));
    await userEvent.keyboard("{Meta>}s{/Meta}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/disk full/);
  });
});

describe("journal and closing", () => {
  it("writes a debounced journal while dirty and clears it after saving", async () => {
    const fs = nested();
    const s = await open(fs);
    const path = journalPath("/appdata", "/project");
    vi.useFakeTimers({ shouldAdvanceTime: false });
    act(() => s.setText("common::title", "th", "J1"));
    act(() => s.setText("common::title", "th", "J2"));
    await vi.advanceTimersByTimeAsync(900);
    expect(await fs.exists(path)).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await fs.exists(path)).toBe(true);
    expect(await fs.readText(path)).toContain("J2");
    vi.useRealTimers();
    await act(() => useApp.getState().save());
    expect(await fs.exists(path)).toBe(false);
  });

  const blockSave = () =>
    act(() => useApp.setState({ conflicts: [{ id: "common::title", locale: "th", mine: { kind: "text", text: "W" } }] }));

  it("Close project right after an edit saves it and closes without asking", async () => {
    const fs = nested();
    const s = await open(fs);
    act(() => s.setText("common::title", "th", "Z"));
    await userEvent.click(screen.getByRole("button", { name: "Close project" }));
    await waitFor(() => expect(useApp.getState().session).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).toBeNull();
    expect(JSON.parse(await fs.readText(TH)).title).toBe("Z");
  });

  it("Close project with changes that can't be saved asks Save / Discard / Cancel", async () => {
    const fs = nested();
    const s = await open(fs);
    act(() => s.setText("common::title", "th", "Z"));
    blockSave();
    await userEvent.click(screen.getByRole("button", { name: "Close project" }));
    const dlg = await screen.findByRole("dialog", { name: "Unsaved changes" });
    await userEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(useApp.getState().session).toBe(s);
    await userEvent.click(screen.getByRole("button", { name: "Close project" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Unsaved changes" })).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(useApp.getState().session).toBeNull());
    expect(JSON.parse(await fs.readText(TH)).title).toBe("สวัสดี");
  });

  it("window close right after an edit saves it and quits without asking", async () => {
    const fs = nested();
    const s = await open(fs, "app");
    await waitFor(() => expect(win.handler).not.toBeNull());
    const clean = { preventDefault: vi.fn() };
    win.handler!(clean);
    expect(clean.preventDefault).not.toHaveBeenCalled();
    act(() => s.setText("common::title", "th", "W"));
    const e = { preventDefault: vi.fn() };
    win.handler!(e);
    expect(e.preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(win.exit).toHaveBeenCalledWith(0));
    expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).toBeNull();
    expect(JSON.parse(await fs.readText(TH)).title).toBe("W");
  });

  it("window close: Discard on changes that can't be saved clears the journal and quits", async () => {
    const fs = nested();
    const s = await open(fs, "app");
    await waitFor(() => expect(win.handler).not.toBeNull());
    const path = journalPath("/appdata", "/project");
    await fs.writeTextAtomic(path, "{}");
    act(() => s.setText("common::title", "th", "W"));
    blockSave();
    win.handler!({ preventDefault() {} });
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Unsaved changes" })).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(win.exit).toHaveBeenCalledWith(0));
    expect(await fs.exists(path)).toBe(false);
    expect(JSON.parse(await fs.readText(TH)).title).toBe("สวัสดี");
  });
});

describe("settings and load errors", () => {
  it("settings: locales path override marks state dirty", async () => {
    const s = await open(nested());
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText(/Takes effect when you reopen the project/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Locales path"));
    await userEvent.type(screen.getByLabelText("Locales path"), "public/i18n");
    await userEvent.click(screen.getByRole("button", { name: "Save setting" }));
    expect(s.state.project.localesPath).toBe("public/i18n");
    expect(s.isDirty()).toBe(true);
  });

  it("settings links to Preferences for app-wide options", async () => {
    await open(nested());
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: "Preferences…" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Default view")).toBeNull();
  });

  it("load error banner lists the malformed file", async () => {
    const s = await open(loadFixtureDir(FIX + "next-broken"));
    expect(s.errors.length).toBeGreaterThan(0);
    const banner = screen.getByTestId("load-errors");
    expect(banner).toHaveTextContent(new RegExp(`${s.errors.length} files? couldn't be read and (are|is) read-only`));
    await userEvent.click(within(banner).getByRole("button", { name: /details/i }));
    expect(within(banner).getByText(new RegExp(s.errors[0].relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
  });
});

describe("review fixes (UI)", () => {
  it("#1 an empty string on disk renders as a red Missing cell", async () => {
    const fs = new MemoryFs({
      "/project/public/locales/en/common.json": '{"a":"A","b":"B"}\n',
      "/project/public/locales/th/common.json": '{"a":"","b":"บี"}\n',
    });
    await open(fs);
    const cell = rowEl("common::a")!.querySelector('[data-cell="missing"][data-locale="th"]');
    expect(cell).not.toBeNull();
    expect(cell).toHaveTextContent(/empty/i);
  });

  it("#3 Cmd+S does nothing while a modal dialog is open", async () => {
    const fs = nested();
    const s = await open(fs);
    act(() => s.setText("common::title", "th", "W"));
    await userEvent.click(screen.getByRole("button", { name: "+ Key" }));
    await screen.findByRole("dialog");
    fs.writes.length = 0;
    await userEvent.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.writes).toEqual([]);
  });

  it("#3 the close prompt's Save refuses while conflicts are unresolved", async () => {
    const fs = nested();
    const s = await open(fs);
    act(() => s.setText("common::title", "th", "W"));
    act(() => useApp.setState({ conflicts: [{ id: "common::title", locale: "th", mine: { kind: "text", text: "W" } }] }));
    await useApp.getState().requestClose("window");
    fs.writes.length = 0;
    await act(() => useApp.getState().answerClosePrompt("save"));
    expect(win.exit).not.toHaveBeenCalled();
    expect(fs.writes).toEqual([]);
    expect(useApp.getState().error).toMatch(/Resolve conflicts before saving/);
  });

  it("#6 settings: saving the detected locales path creates no override; Reset to detected removes one", async () => {
    const s = await open(nested());
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Save setting" }));
    expect(s.state.project.localesPath).toBeUndefined();
    expect(s.isDirty()).toBe(false);
    await userEvent.clear(screen.getByLabelText("Locales path"));
    await userEvent.type(screen.getByLabelText("Locales path"), "public/i18n");
    await userEvent.click(screen.getByRole("button", { name: "Save setting" }));
    expect(s.state.project.localesPath).toBe("public/i18n");
    await userEvent.click(screen.getByRole("button", { name: "Reset to detected" }));
    expect(s.state.project.localesPath).toBeUndefined();
    expect(screen.getByLabelText("Locales path")).toHaveValue("public/locales");
    expect(s.isDirty()).toBe(false);
  });
});
