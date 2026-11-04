import type { ProjectSession } from "../core/session";
import { FIGMA_DEFAULT_DIR, type FigmaSource } from "../workspace/meta";
import { useApp } from "./store";

/** Updates the workspace's Figma settings (creating them if needed), then syncs from Figma. */
export function saveFigma(session: ProjectSession, patch: Partial<FigmaSource>): void {
  const cur = session.workspace?.figma ?? { dir: FIGMA_DEFAULT_DIR, modes: {}, vars: {}, baseline: {} };
  session.setWorkspaceMeta({ figma: { ...cur, ...patch } });
  void useApp
    .getState()
    .syncSource(session)
    .catch((e) => console.warn("Figma sync failed", e));
}
