/**
 * The app menu (spec: Preferences, menus, shortcuts). macOS gets its standard app menu with
 * Settings… ⌘,; Windows gets a menu bar in the window with File → Settings… Ctrl+,.
 */
import { getVersion } from "@tauri-apps/api/app";
import { Image } from "@tauri-apps/api/image";
import { type AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import devIconUrl from "../../src-tauri/icons/64x64.png";

type Predefined = "Separator" | "Cut" | "Copy" | "Paste" | "SelectAll" | "Hide" | "HideOthers" | "ShowAll" | "Minimize" | "Maximize" | "Quit" | "About";

export type MenuItemSpec =
  | { id: string; text: string; accelerator?: string; enabled?: boolean }
  | { predefined: Predefined; text?: string };

export interface MenuCtx {
  hasProject: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export type Platform = "macos" | "windows";

const sep: MenuItemSpec = { predefined: "Separator" };

export function menuSpec(platform: Platform, ctx: MenuCtx): Array<{ text: string; items: MenuItemSpec[] }> {
  const p = ctx.hasProject;
  const settings: MenuItemSpec = { id: "settings", text: "Settings…", accelerator: "CmdOrCtrl+," };
  const file: MenuItemSpec[] = [
    { id: "new-project", text: "New Project…", accelerator: "CmdOrCtrl+N" },
    { id: "open-project", text: "Open Project…", accelerator: "CmdOrCtrl+O" },
    sep,
    { id: "close-tab", text: "Close Tab", accelerator: "CmdOrCtrl+W", enabled: p },
    { id: "save", text: "Save", accelerator: "CmdOrCtrl+S", enabled: p },
    sep,
    { id: "import-figma", text: "Import Figma Files…", enabled: p },
    { id: "export", text: "Export…", accelerator: "CmdOrCtrl+E", enabled: p },
    ...(platform === "windows" ? [sep, settings, sep, { predefined: "Quit", text: "Exit" } as MenuItemSpec] : []),
  ];
  const edit: MenuItemSpec[] = [
    { id: "undo", text: "Undo", accelerator: "CmdOrCtrl+Z", enabled: p && ctx.canUndo },
    { id: "redo", text: "Redo", accelerator: "CmdOrCtrl+Shift+Z", enabled: p && ctx.canRedo },
    sep,
    { predefined: "Cut" },
    { predefined: "Copy" },
    { predefined: "Paste" },
    { predefined: "SelectAll" },
    sep,
    { id: "find", text: "Find", accelerator: "CmdOrCtrl+F", enabled: p },
  ];
  const view: MenuItemSpec[] = [
    { id: "view-list", text: "List View", enabled: p },
    { id: "view-table", text: "Table View", enabled: p },
    sep,
    { id: "next-tab", text: "Next Tab", accelerator: "Ctrl+Tab", enabled: p },
    { id: "prev-tab", text: "Previous Tab", accelerator: "Ctrl+Shift+Tab", enabled: p },
  ];
  const help: MenuItemSpec[] = [
    { id: "github", text: "Retrans on GitHub" },
    ...(platform === "windows" ? [{ id: "check-updates", text: "Check for Updates…" }, { predefined: "About", text: "About Retrans" } as MenuItemSpec] : []),
  ];
  if (platform === "windows") {
    return [{ text: "File", items: file }, { text: "Edit", items: edit }, { text: "View", items: view }, { text: "Help", items: help }];
  }
  const app: MenuItemSpec[] = [
    { predefined: "About", text: "About Retrans" },
    sep,
    settings,
    { id: "check-updates", text: "Check for Updates…" },
    sep,
    { predefined: "Hide" },
    { predefined: "HideOthers" },
    { predefined: "ShowAll" },
    sep,
    { predefined: "Quit" },
  ];
  const window: MenuItemSpec[] = [{ predefined: "Minimize" }, { predefined: "Maximize", text: "Zoom" }];
  return [
    { text: "Retrans", items: app },
    { text: "File", items: file },
    { text: "Edit", items: edit },
    { text: "View", items: view },
    { text: "Window", items: window },
    { text: "Help", items: help },
  ];
}

/**
 * The native About window: "Version 0.5.1 (abc1234)". macOS shows `version` as-is and
 * `shortVersion` in parentheses, plus the credits and copyright; Windows appends `shortVersion`
 * the same way and shows comments, website, authors and license instead.
 */
export function aboutMetadata(appVersion: string, commit: string): AboutMetadata {
  return {
    name: "Retrans",
    version: `Version ${appVersion}`,
    ...(commit ? { shortVersion: commit } : {}),
    credits: "A translation editor for next-i18next, Paraglide, TypeScript and Figma\noxth.github.io/retrans · github.com/oxth/retrans",
    comments: "A translation editor for next-i18next, Paraglide, TypeScript and Figma",
    copyright: `© ${new Date().getFullYear()} oxth`,
    authors: ["oxth"],
    license: "MIT",
    website: "https://oxth.github.io/retrans/",
    websiteLabel: "oxth.github.io/retrans",
  };
}

/** The 64×64 app icon as an Image: macOS shows it at one point per pixel, the size of a standard About icon. */
async function devIcon(): Promise<Image> {
  const img = document.createElement("img");
  img.src = devIconUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  return Image.new(new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer), canvas.width, canvas.height);
}

export const currentPlatform = (): Platform => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? "macos" : "windows");

/**
 * Builds the native menu and sets it as the app menu. Returns an updater for enabled states
 * (start screen vs project, undo/redo availability).
 */
export async function installMenu(onAction: (id: string) => void, ctx: MenuCtx): Promise<(ctx: MenuCtx) => Promise<void>> {
  const platform = currentPlatform();
  const byId = new Map<string, MenuItem>();
  const submenus: Submenu[] = [];
  const about = aboutMetadata(await getVersion().catch(() => ""), typeof __COMMIT__ === "string" ? __COMMIT__ : "");
  // The .app bundle's own icon is used when none is given. `tauri dev` runs without a bundle, so it would be a folder.
  if (import.meta.env.DEV) {
    const icon = await devIcon().catch(() => null);
    if (icon) about.icon = icon;
  }
  for (const m of menuSpec(platform, ctx)) {
    const items = [];
    for (const spec of m.items) {
      if ("id" in spec) {
        const it = await MenuItem.new({
          id: spec.id, text: spec.text, accelerator: spec.accelerator, enabled: spec.enabled ?? true,
          action: () => onAction(spec.id),
        });
        byId.set(spec.id, it);
        items.push(it);
      } else if (spec.predefined === "About") {
        items.push(await PredefinedMenuItem.new({ item: { About: about }, text: spec.text }));
      } else {
        items.push(await PredefinedMenuItem.new({ item: spec.predefined, text: spec.text }));
      }
    }
    submenus.push(await Submenu.new({ text: m.text, items }));
  }
  const menu = await Menu.new({ items: submenus });
  await menu.setAsAppMenu();
  return async (next: MenuCtx) => {
    for (const m of menuSpec(platform, next)) {
      for (const spec of m.items) {
        if ("id" in spec) await byId.get(spec.id)?.setEnabled(spec.enabled ?? true);
      }
    }
  };
}
