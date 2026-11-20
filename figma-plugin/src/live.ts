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
    async projects(): Promise<Array<{ id: string; name: string; baseLocale: string; locales: string[] }>> {
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

/** The Retrans project to send results to: the one drafts came from, else the picked one; null when there is none. */
export function sendTarget(draftsProjectId: string | undefined, pickedId: string): string | null {
  return draftsProjectId || pickedId || null;
}
