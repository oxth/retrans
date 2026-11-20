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

/** The first local port where Retrans answers; ports that are closed or hold another app are skipped. */
export async function findRetrans(fetch: Fetch): Promise<{ base: string; paired: boolean } | null> {
  for (const port of PORTS) {
    const base = `http://localhost:${port}`;
    try {
      const res = await fetch(`${base}/v1/hello`);
      if (!res.ok) continue;
      const body = (await res.json()) as { app?: unknown; paired?: unknown };
      if (body && body.app === "retrans") return { base, paired: body.paired === true };
    } catch {
      /* closed port or not Retrans: try the next one */
    }
  }
  return null;
}

async function call(fetch: Fetch, url: string, init?: RequestInit): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new LinkError("Can't reach Retrans. Is it open?", 0);
  }
  const text = await res.text();
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

export function liveApi(fetch: Fetch, base: string, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const q = encodeURIComponent;
  return {
    async projects(): Promise<Array<{ id: string; name: string; baseLocale: string; locales: string[] }>> {
      return JSON.parse(await call(fetch, `${base}/v1/projects`, { headers }));
    },
    async bundle(project: string, locale: string, includeReviewed: boolean): Promise<PreviewBundle> {
      const text = await call(fetch, `${base}/v1/bundle?project=${q(project)}&locale=${q(locale)}&includeReviewed=${includeReviewed}`, { headers });
      const parsed = parseBundle(text);
      if (!parsed.ok) throw new LinkError(parsed.error, 200);
      return parsed.bundle;
    },
    async send(project: string, results: PreviewResults): Promise<void> {
      await call(fetch, `${base}/v1/results?project=${q(project)}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(results),
      });
    },
  };
}

/** Trades the 6-digit code shown in Retrans for a token. */
export async function pair(fetch: Fetch, base: string, code: string): Promise<string> {
  try {
    const text = await call(fetch, `${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    return (JSON.parse(text) as { token: string }).token;
  } catch (e) {
    if (e instanceof LinkError && e.status === 403) throw new LinkError("That code didn't work. Check it in Retrans and try again.", 403);
    throw e;
  }
}
