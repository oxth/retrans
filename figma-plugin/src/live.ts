/** Talks to the Retrans app on this computer. `fetch` is injected so it can be tested. */
import { type PreviewBundle, type PreviewResults, parseBundle } from "../../src/preview/format";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export const PORTS = [47321, 47322, 47323, 47324, 47325];

export class LinkError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LinkError";
  }
}

export const PROBE_TIMEOUT_MS = 1500;
/** A little over the 10 s Retrans itself may wait for its window, so a slow but alive Retrans can still answer. */
export const CALL_TIMEOUT_MS = 12000;

/** A project open in Retrans: `id` is the tab id, which changes every time Retrans opens the project. */
export interface RetransProject { id: string; name: string; projectId?: string; baseLocale: string; locales: string[] }

class TimedOut extends Error {}

/** Runs `work` with an abort signal; rejects with TimedOut if it has not finished in `ms`. */
async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new TimedOut());
    }, ms);
  });
  try {
    return await Promise.race([work(ctl.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The first local port where Retrans answers; ports that are closed or hold another app are skipped. */
export async function findRetrans(fetch: Fetch, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ base: string; paired: boolean } | null> {
  for (const port of PORTS) {
    const base = `http://localhost:${port}`;
    try {
      const body = await within(timeoutMs, async (signal) => {
        const res = await fetch(`${base}/v1/hello`, { signal });
        return res.ok ? ((await res.json()) as { app?: unknown; paired?: unknown }) : null;
      });
      if (body && body.app === "retrans") return { base, paired: body.paired === true };
    } catch {
      /* closed port or not Retrans: try the next one */
    }
  }
  return null;
}

async function call(fetch: Fetch, url: string, init: RequestInit | undefined, timeoutMs: number): Promise<string> {
  let res: Response;
  let text: string;
  try {
    ({ res, text } = await within(timeoutMs, async (signal) => {
      const r = await fetch(url, { ...init, signal });
      return { res: r, text: await r.text() };
    }));
  } catch (e) {
    if (e instanceof TimedOut) throw new LinkError("Retrans didn't answer in time. Is it busy?", 0);
    throw new LinkError("Can't reach Retrans. Is it open?", 0);
  }
  if (!res.ok) {
    let message = "Retrans answered with an error.";
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body?.error === "string") message = body.error;
    } catch {
      /* keep the generic message */
    }
    throw new LinkError(message, res.status);
  }
  return text;
}

export function liveApi(fetch: Fetch, base: string, token: string, timeoutMs = CALL_TIMEOUT_MS) {
  const headers = { Authorization: `Bearer ${token}` };
  const q = encodeURIComponent;
  return {
    async projects(): Promise<RetransProject[]> {
      return JSON.parse(await call(fetch, `${base}/v1/projects`, { headers }, timeoutMs));
    },
    async bundle(project: string, locale: string, includeReviewed: boolean): Promise<PreviewBundle> {
      const text = await call(fetch, `${base}/v1/bundle?project=${q(project)}&locale=${q(locale)}&includeReviewed=${includeReviewed}`, { headers }, timeoutMs);
      const parsed = parseBundle(text);
      if (!parsed.ok) throw new LinkError(parsed.error, 200);
      return parsed.bundle;
    },
    async send(project: string, results: PreviewResults): Promise<void> {
      await call(fetch, `${base}/v1/results?project=${q(project)}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(results),
      }, timeoutMs);
    },
  };
}

/** Trades the 6-digit code shown in Retrans for a token. */
export async function pair(fetch: Fetch, base: string, code: string, timeoutMs = CALL_TIMEOUT_MS): Promise<string> {
  try {
    const text = await call(fetch, `${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) }, timeoutMs);
    return (JSON.parse(text) as { token: string }).token;
  } catch (e) {
    if (e instanceof LinkError && e.status === 403) throw new LinkError("That code didn't work. Check it in Retrans and try again.", 403);
    throw e;
  }
}

/**
 * Sends results to the project the drafts came from. Tab ids change when Retrans restarts or
 * reopens a project, so results go by the stable project id.
 */
export async function sendResults(
  api: { projects(): Promise<RetransProject[]>; send(project: string, results: PreviewResults): Promise<void> },
  results: PreviewResults,
  projectName?: string,
): Promise<void> {
  const projects = await api.projects();
  const project = projects.find((p) => p.projectId !== undefined && p.projectId === results.sourceProjectId);
  if (!project) throw new LinkError(`Open ${projectName || "that project"} in Retrans to send these results.`, 404);
  await api.send(project.id, results);
}

/** Drops the link when Retrans can't be reached or timed out; any other error keeps it. */
export function linkAfterError<L>(link: L, err: unknown): L | null {
  return err instanceof LinkError && err.status === 0 ? null : link;
}

/** The project to show: the current pick if still open, else the one the drafts came from, else the first. */
export function pickProject(projects: RetransProject[], current: string, sourceProjectId: string | undefined): string {
  if (projects.some((p) => p.id === current)) return current;
  if (sourceProjectId) {
    const match = projects.find((p) => p.projectId === sourceProjectId);
    if (match) return match.id;
  }
  return projects[0]?.id ?? "";
}
