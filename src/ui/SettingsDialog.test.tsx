import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata"), documentDir: vi.fn(async () => "/docs") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));
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

import App from "../App";
import { detectProject } from "../formats/detect";
import { MemoryFs, loadFixtureDir } from "../platform/memory-fs";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures") + "/";

async function setupApp(fs: MemoryFs) {
  await useApp.getState().closeAllTabs();
  useApp.setState({ fs, prefsOpen: false, prefsSection: null });
  return render(<App />);
}

async function openProjectInApp() {
  const fs = loadFixtureDir(FIX + "next-nested");
  await setupApp(fs);
  const d = (await detectProject(fs, "/project"))!;
  await useApp.getState().openProject("/project", d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
}

beforeEach(() => {
  prefs.clear();
});

afterEach(cleanup);

const nav = () => within(screen.getByRole("navigation", { name: "Settings sections" }));
const title = () => screen.getByRole("heading", { level: 2 });

describe("Settings window", () => {
  it("opens from the start screen and closes with the close button", async () => {
    await setupApp(loadFixtureDir(FIX + "next-nested"));
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("with no project open, shows only app sections", async () => {
    await setupApp(loadFixtureDir(FIX + "next-nested"));
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    expect(title()).toHaveTextContent("General"); // the first app section
    await userEvent.click(nav().getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("radiogroup", { name: "Default view" })).toBeInTheDocument();
    expect(nav().queryByRole("button", { name: "Translation" })).toBeNull();
    expect(nav().getByRole("button", { name: "Machine translation" })).toBeInTheDocument();
  });

  it("with a project open, Settings opens on the project's own sections", async () => {
    await openProjectInApp();
    await userEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Locales path")).toBeInTheDocument();
    expect(nav().getByRole("button", { name: "Files", current: "page" })).toBeInTheDocument();
    await userEvent.click(nav().getByRole("button", { name: "Translation" }));
    expect(screen.getByLabelText("Translation provider for this project")).toBeInTheDocument();
    // App sections are one click away in the same window.
    await userEvent.click(nav().getByRole("button", { name: "About" }));
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
  });

  it("search narrows the sections and Enter opens the first match", async () => {
    await openProjectInApp();
    await userEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search settings" }), "api key{Enter}");
    expect(nav().getAllByRole("button").map((b) => b.textContent)).toEqual(["Machine translation"]);
    expect(title()).toHaveTextContent("Machine translation");
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search settings" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search settings" }), "zzz");
    expect(screen.getByText('No settings match "zzz".')).toBeInTheDocument();
  });

  it("Escape closes Settings", async () => {
    await setupApp(loadFixtureDir(FIX + "next-nested"));
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("Machine translation works with no project open", async () => {
    await setupApp(loadFixtureDir(FIX + "next-nested"));
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    await userEvent.click(nav().getByRole("button", { name: "Machine translation" }));
    const checkbox = screen.getByRole("checkbox", { name: "Enable machine translation" });
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it("leaving Machine translation with unsaved changes asks first", async () => {
    await setupApp(loadFixtureDir(FIX + "next-nested"));
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    await userEvent.click(nav().getByRole("button", { name: "Machine translation" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Enable machine translation" }));
    await userEvent.click(nav().getByRole("button", { name: "About" }));
    let ask = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(title()).toHaveTextContent("Machine translation");
    expect(screen.getByRole("checkbox", { name: "Enable machine translation" })).toBeChecked();
    await userEvent.keyboard("{Escape}");
    ask = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("Default view applies to the open project at once; a project's own view can be reset to it", async () => {
    await openProjectInApp();
    const viewSwitch = () => within(screen.getByRole("group", { name: "View mode" }));
    await waitFor(() => expect(viewSwitch().getByRole("button", { name: "list" })).toHaveAttribute("aria-pressed", "true"));
    // No view of its own yet: the default applies straight away.
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    await userEvent.click(nav().getByRole("button", { name: "Appearance" }));
    expect(title()).toHaveTextContent("Appearance");
    const app = () => screen.getByRole("radiogroup", { name: "Default view" });
    await userEvent.click(within(app()).getByRole("radio", { name: "Table" }));
    await waitFor(() => expect(viewSwitch().getByRole("button", { name: "table" })).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
    // The toolbar switch gives the project its own view, which the default no longer overrides.
    await userEvent.click(viewSwitch().getByRole("button", { name: "list" }));
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    await userEvent.click(nav().getByRole("button", { name: "Appearance" }));
    expect(await screen.findByText(/Uses its own view \(List\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use the default (Table)" }));
    await waitFor(() => expect(viewSwitch().getByRole("button", { name: "table" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByText(/Uses its own view/)).toBeNull();
  });

  it("Appearance: theme and interface size apply at once and are saved", async () => {
    await setupApp(loadFixtureDir(FIX + "next-nested"));
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    await userEvent.click(nav().getByRole("button", { name: "Appearance" }));
    expect(title()).toHaveTextContent("Appearance");
    const theme = within(screen.getByRole("radiogroup", { name: "Theme" }));
    expect(theme.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(theme.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Interface size" })).getByRole("radio", { name: "Large" }));
    expect(document.documentElement.style.fontSize).toBe("112.5%");
    await waitFor(() => expect(prefs.get("appearance")).toEqual({ theme: "dark", size: "large" }));
    // System and Default put the page back to following the computer / normal size.
    await userEvent.click(theme.getByRole("radio", { name: "System" }));
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Interface size" })).getByRole("radio", { name: "Default" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.style.fontSize).toBe("");
  });

  it("About shows the app and its updates; Check for updates opens it from the menu", async () => {
    await setupApp(loadFixtureDir(FIX + "next-nested"));
    act(() => useApp.getState().openPrefs("about"));
    expect(title()).toHaveTextContent("About");
    expect(within(screen.getByRole("dialog", { name: "Settings" })).getByText("Retrans")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Check for updates automatically" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(screen.getByRole("dialog", { name: "What's new" })).toBeInTheDocument();
  });
});
