import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { MENU_ACTIONS } from "./menu-actions";
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

/** jsdom has no layout: tab i is 100 px wide at x = i * 104 (100 + the 4 px gap). */
function layOutTabs() {
  document.querySelectorAll<HTMLElement>("[data-tab-id]").forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: i * 104, width: 100, top: 0, height: 28, right: i * 104 + 100, bottom: 28, x: i * 104, y: 0, toJSON() {} }) as DOMRect;
  });
}
const names = () => useApp.getState().tabs.map((t) => t.name);

describe("reordering tabs", () => {
  it("dragging a tab past another's middle moves it there, and the order sticks", async () => {
    await twoProjects();
    render(<TabBar />);
    layOutTabs();
    expect(names()).toEqual(["alpha", "beta"]);
    const alpha = screen.getByRole("tab", { name: /alpha/ }).closest<HTMLElement>("[data-tab-id]")!;
    fireEvent.pointerDown(alpha, { button: 0, clientX: 50 });
    fireEvent.pointerMove(window, { clientX: 130 }); // alpha's middle at 50 + 80 = 130: not yet past beta's (154)
    fireEvent.pointerMove(window, { clientX: 160 }); // at 50 + 110 = 160: past it, so alpha lands after beta
    expect(alpha.style.transform).toBe("translateX(110px)");
    fireEvent.pointerUp(window);
    expect(names()).toEqual(["beta", "alpha"]);
  });

  it("a press that barely moves is a click, not a drag", async () => {
    await twoProjects();
    render(<TabBar />);
    layOutTabs();
    const alpha = screen.getByRole("tab", { name: /alpha/ }).closest<HTMLElement>("[data-tab-id]")!;
    fireEvent.pointerDown(alpha, { button: 0, clientX: 50 });
    fireEvent.pointerMove(window, { clientX: 53 });
    fireEvent.pointerUp(window);
    expect(names()).toEqual(["alpha", "beta"]);
  });

  it("pressing a tab's close button never starts a drag", async () => {
    await twoProjects();
    render(<TabBar />);
    layOutTabs();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Close tab alpha" }), { button: 0, clientX: 90 });
    fireEvent.pointerMove(window, { clientX: 200 });
    fireEvent.pointerUp(window);
    expect(names()).toEqual(["alpha", "beta"]);
  });

  it("Move Tab Left / Right move the active tab one place, and stop at the ends", async () => {
    await twoProjects(); // beta is active, last
    act(() => MENU_ACTIONS["move-tab-right"]());
    expect(names()).toEqual(["alpha", "beta"]);
    act(() => MENU_ACTIONS["move-tab-left"]());
    expect(names()).toEqual(["beta", "alpha"]);
    act(() => MENU_ACTIONS["move-tab-left"]());
    expect(names()).toEqual(["beta", "alpha"]);
    expect(useApp.getState().tabs[0].name).toBe("beta"); // still the active one, now first
  });
});

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
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("New Tab");
  });

  it("closing New Tab goes back to the last project", async () => {
    await twoProjects();
    render(<TabBar />);
    await userEvent.click(screen.getByRole("button", { name: "Open another project" }));
    await userEvent.click(screen.getByRole("button", { name: "Close New Tab" }));
    const { tabs, activeId } = useApp.getState();
    expect(activeId).toBe(tabs[tabs.length - 1].id);
    expect(screen.queryByText("New Tab")).toBeNull();
  });

  it("with no project open, New Tab is the only tab and can't be closed", async () => {
    await useApp.getState().closeAllTabs();
    render(<TabBar />);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("New Tab");
    expect(screen.queryByRole("button", { name: "Close New Tab" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();
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

  it("× is a 24px target: 13px icon plus 6px padding on each side (WCAG 2.2 target size)", async () => {
    await twoProjects();
    render(<TabBar />);
    expect(screen.getByRole("button", { name: "Close tab alpha" }).className).toMatch(/\bp-1\.5\b/);
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

  it("dots the Settings gear while an update hasn't been looked at, and opens About", async () => {
    await useApp.getState().closeAllTabs();
    act(() => useApp.setState({ update: { version: "9.9.9", install: async () => {} }, updateSeen: null, prefsOpen: false }));
    render(<TabBar />);
    expect(screen.getByTestId("update-dot")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open settings (update available)" }));
    expect(useApp.getState()).toMatchObject({ prefsOpen: true, prefsSection: "about" });
    act(() => useApp.setState({ updateSeen: "9.9.9", prefsOpen: false }));
    expect(screen.queryByTestId("update-dot")).toBeNull();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();
    act(() => useApp.setState({ update: null, updateSeen: null }));
  });
});
