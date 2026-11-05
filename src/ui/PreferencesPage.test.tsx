import { cleanup, render, screen } from "@testing-library/react";
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
  useApp.setState({ fs, prefsOpen: false });
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

describe("Preferences page", () => {
  it("opens from the start screen gear and closes with Done", async () => {
    await setupApp(loadFixtureDir(FIX + "next-nested"));
    await userEvent.click(screen.getByRole("button", { name: "Preferences" }));
    expect(await screen.findByRole("heading", { name: "Preferences" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("heading", { name: "Preferences" })).toBeNull();
  });

  it("opens from a project's Settings → Preferences…", async () => {
    await openProjectInApp();
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Preferences…" }));
    expect(await screen.findByRole("heading", { name: "Preferences" })).toBeInTheDocument();
  });

  it("project Settings shows only project items", async () => {
    await openProjectInApp();
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("Locales path")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preferences…" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Default view")).toBeNull();
    expect(screen.queryByText("Machine translation")).toBeNull();
    expect(screen.queryByText("Startup")).toBeNull();
    expect(screen.queryByText("Updates")).toBeNull();
  });

  it("Escape closes Preferences", async () => {
    await setupApp(loadFixtureDir(FIX + "next-nested"));
    await userEvent.click(screen.getByRole("button", { name: "Preferences" }));
    expect(await screen.findByRole("heading", { name: "Preferences" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { name: "Preferences" })).toBeNull();
  });

  it("Machine translation works with no project open", async () => {
    await setupApp(loadFixtureDir(FIX + "next-nested"));
    await userEvent.click(screen.getByRole("button", { name: "Preferences" }));
    expect(await screen.findByRole("heading", { name: "Machine translation" })).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", { name: "Enable machine translation" });
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });
});
