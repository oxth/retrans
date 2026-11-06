import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { detectProject } from "../formats/detect";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { useApp } from "./store";
import { TabBar } from "./TabBar";

const FIX = resolve(__dirname, "../test/fixtures/next-nested");

async function twoProjects() {
  const fs = new MemoryFs({ ...loadFixtureDir(FIX, "/alpha").snapshot(), ...loadFixtureDir(FIX, "/beta").snapshot() });
  useApp.setState({ fs });
  for (const root of ["/alpha", "/beta"]) {
    const d = (await detectProject(fs, root))!;
    await useApp.getState().openProject(root, d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
  }
  const [a, b] = useApp.getState().tabs;
  return { a, b };
}

beforeEach(async () => {
  await useApp.getState().closeAllTabs();
});
afterEach(cleanup);

describe("TabBar", () => {
  it("shows one tab per open project with the active one selected", async () => {
    await twoProjects();
    render(<TabBar />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([expect.stringContaining("alpha"), expect.stringContaining("beta")]);
    expect(screen.getByRole("tab", { name: /beta/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /alpha/ })).toHaveAttribute("aria-selected", "false");
  });

  it("shows the unsaved dot for a dirty background tab", async () => {
    const { a } = await twoProjects();
    act(() => useApp.getState().switchTab(a.id));
    const s = useApp.getState().session!;
    act(() => s.setText(s.data.keyOrder[0], "th", "changed"));
    act(() => useApp.getState().showStart());
    render(<TabBar />);
    expect(screen.getByRole("tab", { name: /alpha/ })).toContainElement(screen.getByLabelText("Unsaved changes"));
  });

  it("+ shows the start screen and keeps the tabs", async () => {
    await twoProjects();
    render(<TabBar />);
    await userEvent.click(screen.getByRole("button", { name: "Open another project" }));
    expect(useApp.getState().activeId).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByRole("tab", { selected: true })).toBeNull();
  });

  it("clicking a tab switches to it", async () => {
    const { a } = await twoProjects();
    render(<TabBar />);
    await userEvent.click(screen.getByRole("tab", { name: /alpha/ }));
    expect(useApp.getState().activeId).toBe(a.id);
  });

  it("shows Working while the tab is busy", async () => {
    const { b } = await twoProjects();
    render(<TabBar />);
    expect(screen.queryByLabelText("Working")).toBeNull();
    act(() => useApp.getState().markBusy(b.id, 1));
    expect(screen.getByRole("tab", { name: /beta/ })).toContainElement(screen.getByLabelText("Working"));
  });

  it("× closes that tab", async () => {
    await twoProjects();
    render(<TabBar />);
    await userEvent.click(screen.getByRole("button", { name: "Close tab alpha" }));
    expect(useApp.getState().tabs.map((t) => t.name)).toEqual(["beta"]);
  });

  it("shows the notice and lets it be dismissed", async () => {
    await twoProjects();
    act(() => useApp.setState({ notice: "Couldn't reopen gone: the folder is gone." }));
    render(<TabBar />);
    expect(screen.getByText("Couldn't reopen gone: the folder is gone.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useApp.getState().notice).toBeNull();
  });

  it("the gear at the top right opens Settings", async () => {
    await twoProjects();
    useApp.setState({ prefsOpen: false });
    render(<TabBar />);
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(useApp.getState().prefsOpen).toBe(true);
  });
});
