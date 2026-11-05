import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));

import { MENU_ACTIONS } from "../ui/menu-actions";
import { type MenuItemSpec, menuSpec } from "./menu";

const ctx = { hasProject: true, canUndo: true, canRedo: true };
const items = (spec: ReturnType<typeof menuSpec>) => spec.flatMap((m) => m.items);
const item = (spec: ReturnType<typeof menuSpec>, id: string) => items(spec).find((i) => "id" in i && i.id === id) as Extract<MenuItemSpec, { id: string }>;

describe("menuSpec", () => {
  it("macOS has Settings… ⌘, in the Retrans menu", () => {
    const spec = menuSpec("macos", ctx);
    expect(spec.map((m) => m.text)).toEqual(["Retrans", "File", "Edit", "View", "Window", "Help"]);
    expect(spec[0].items).toContainEqual(expect.objectContaining({ id: "settings", text: "Settings…", accelerator: "CmdOrCtrl+," }));
  });

  it("Windows has File → Settings… Ctrl+, and no Retrans menu", () => {
    const spec = menuSpec("windows", ctx);
    expect(spec.map((m) => m.text)).toEqual(["File", "Edit", "View", "Help"]);
    const file = spec[0].items;
    expect(file).toContainEqual(expect.objectContaining({ id: "settings", text: "Settings…", accelerator: "CmdOrCtrl+," }));
    expect(file[file.length - 1]).toEqual(expect.objectContaining({ predefined: "Quit", text: "Exit" }));
  });

  it("the usual shortcuts", () => {
    const spec = menuSpec("macos", ctx);
    const acc = (id: string) => item(spec, id).accelerator;
    expect([acc("new-project"), acc("open-project"), acc("close-tab"), acc("save"), acc("export")]).toEqual([
      "CmdOrCtrl+N", "CmdOrCtrl+O", "CmdOrCtrl+W", "CmdOrCtrl+S", "CmdOrCtrl+E",
    ]);
    expect([acc("undo"), acc("redo"), acc("find"), acc("next-tab"), acc("prev-tab")]).toEqual([
      "CmdOrCtrl+Z", "CmdOrCtrl+Shift+Z", "CmdOrCtrl+F", "Ctrl+Tab", "Ctrl+Shift+Tab",
    ]);
    for (const p of ["Cut", "Copy", "Paste", "SelectAll"]) expect(items(spec)).toContainEqual(expect.objectContaining({ predefined: p }));
  });

  it("project items are disabled on the start screen", () => {
    const spec = menuSpec("macos", { hasProject: false, canUndo: false, canRedo: false });
    for (const id of ["save", "close-tab", "export", "import-figma", "undo", "redo", "find", "view-list", "view-table", "next-tab", "prev-tab"]) {
      expect(item(spec, id).enabled, id).toBe(false);
    }
    for (const id of ["new-project", "open-project", "settings"]) expect(item(spec, id).enabled ?? true, id).toBe(true);
  });

  it("undo/redo follow canUndo/canRedo", () => {
    const spec = menuSpec("macos", { hasProject: true, canUndo: false, canRedo: true });
    expect(item(spec, "undo").enabled).toBe(false);
    expect(item(spec, "redo").enabled).toBe(true);
  });

  it("every action id has a handler", () => {
    for (const platform of ["macos", "windows"] as const) {
      for (const i of items(menuSpec(platform, ctx))) {
        if ("id" in i) expect(MENU_ACTIONS[i.id], i.id).toBeTypeOf("function");
      }
    }
  });
});
