import { getCurrentWindow } from "@tauri-apps/api/window";
import { type Appearance, appearanceOf, getAppearance, type UiSize } from "../platform/prefs";

/** Root font size per interface size: the whole UI is sized in rem, so this scales everything. */
export const UI_SIZE_SCALE: Record<UiSize, string> = { small: "87.5%", default: "100%", large: "112.5%", larger: "125%" };

/** A copy in localStorage so the first frame already has the right theme (the store loads async). */
const CACHE_KEY = "retrans.appearance";

/** Puts an appearance on screen: page theme, interface size, and the native title bar. */
export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  if (a.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = a.theme;
  root.style.fontSize = a.size === "default" ? "" : UI_SIZE_SCALE[a.size];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(a));
  } catch {
    /* private mode / blocked storage: the store still has it */
  }
  try {
    void getCurrentWindow()
      .setTheme(a.theme === "system" ? null : a.theme)
      .catch(() => {});
  } catch {
    /* not running in Tauri (tests, browser preview) */
  }
}

/** On launch: the cached appearance at once, then the saved one (the source of truth). */
export function initAppearance(): void {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) applyAppearance(appearanceOf(JSON.parse(cached)));
  } catch {
    /* no cache yet */
  }
  getAppearance().then(applyAppearance, () => {});
}
