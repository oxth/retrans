import type { PreviewBundle, Verdict } from "../../src/preview/format";
import type { PluginState } from "./logic";

/** Messages from the plugin window to the plugin code. */
export type ToCode =
  | { type: "bundle"; bundle: PreviewBundle; fileName: string }
  | { type: "make-copies" }
  | { type: "remove-copies" }
  | { type: "verdict"; key: string; verdict: Verdict | null; note?: string }
  | { type: "focus"; key: string }
  | { type: "token"; token: string | null };

/** Messages from the plugin code to the plugin window. */
export type ToUi =
  | { type: "state"; state: PluginState; selectedFrames: number; token: string | null }
  | { type: "error"; message: string };
