/**
 * The live link with the Figma plugin: the commands Settings calls to start and pair the endpoint,
 * and the bridge that answers the plugin's requests from the projects open in the app.
 */
import { invoke } from "@tauri-apps/api/core";
import { answerLive, type LiveProject, type LiveReply, type LiveRequest } from "../preview/live";
import type { ResultsDiff } from "../preview/results";
import { useApp } from "../ui/store";

export interface LinkStatus {
  running: boolean;
  port: number | null;
  paired: boolean;
}

/** Starts the endpoint (idempotent) and returns the port it listens on. */
export const linkStart = (): Promise<number> => invoke<number>("preview_link_start");

/** Stops the endpoint. */
export const linkStop = (): Promise<void> => invoke<void>("preview_link_stop");

/** Whether the endpoint runs, on which port, and whether a plugin is paired. */
export const linkStatus = (): Promise<LinkStatus> => invoke<LinkStatus>("preview_link_status");

/** Starts the link if needed and shows a fresh six-digit code for the plugin. */
export const pairCode = (): Promise<{ code: string; expiresInMs: number }> => invoke("preview_pair_code");

/** Deletes the paired plugin's token. */
export const forgetPlugin = (): Promise<void> => invoke<void>("preview_forget");

/** The open projects as the plugin sees them: the active tab's live session, the others from their snapshot. */
export function liveProjects(): LiveProject[] {
  const { tabs, activeId, session } = useApp.getState();
  const projects: LiveProject[] = [];
  for (const tab of tabs) {
    const s = tab.id === activeId ? session : tab.snap?.session ?? null;
    if (s) projects.push({ id: tab.id, name: tab.name, session: s });
  }
  return projects;
}

/** Brings the app forward, opens the tab the results belong to, and offers them for review. */
function onResults(projectId: string, diff: ResultsDiff): void {
  void invoke("preview_focus").catch(() => {});
  const store = useApp.getState();
  store.switchTab(projectId);
  store.showPreviewResults(projectId, diff);
}

/**
 * Answers one plugin request and sends the reply over `preview_reply`. Anything that throws while
 * answering, including a request the plugin left incomplete, becomes a 500 reply, so the endpoint's
 * request never waits for its whole timeout.
 */
export async function onPreviewRequest(req: LiveRequest): Promise<void> {
  let reply: LiveReply;
  try {
    const params = (req as { params?: unknown }).params;
    if (typeof params !== "object" || params === null) throw new Error("The plugin sent an incomplete request.");
    reply = answerLive(liveProjects(), req, onResults);
  } catch (error) {
    reply = { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  await invoke("preview_reply", { id: req.id, status: reply.status, body: reply.body });
}
