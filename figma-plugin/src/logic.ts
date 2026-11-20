import type { PreviewBundle, PreviewFlag, Verdict } from "../../src/preview/format";

export interface PluginState {
  bundle: PreviewBundle | null;
  fileName: string | null;
  rows: Array<{ key: string; text: string; flag: PreviewFlag; found: boolean; verdict: Verdict | null; note?: string }>;
}
