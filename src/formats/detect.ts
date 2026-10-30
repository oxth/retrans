import type { Fs } from "../platform/fs";
import type { DetectResult } from "./adapter";
import { nextI18nextAdapter } from "./next-i18next";
import { paraglideAdapter } from "./paraglide";

/** Paraglide first (throws if its settings.json is malformed), then next-i18next, else null. */
export async function detectProject(fs: Fs, root: string): Promise<DetectResult | null> {
  return (await paraglideAdapter.detect(fs, root)) ?? (await nextI18nextAdapter.detect(fs, root));
}
