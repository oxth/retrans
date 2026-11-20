import { describe, expect, it } from "vitest";
import { type Fetch, LinkError, findRetrans, linkAfterError, liveApi, pickProject, pair, sendResults } from "./live";

const json = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body }) as Response;

/** A fake fetch answering by exact URL; a missing URL rejects like a closed port. */
function fake(routes: Record<string, () => Response>, calls: Array<{ url: string; init?: RequestInit }> = []): Fetch {
  return async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) throw new TypeError("Failed to fetch");
    return r();
  };
}

const hello = (paired: boolean) => () => json(200, { app: "retrans", version: "1", paired });

describe("findRetrans", () => {
  it("skips a closed port and uses the next that answers hello", async () => {
    const f = fake({ "http://localhost:47322/v1/hello": hello(true) });
    expect(await findRetrans(f)).toEqual({ base: "http://localhost:47322", paired: true });
  });
  it("skips a server that is not Retrans", async () => {
    const f = fake({
      "http://localhost:47321/v1/hello": () => json(200, { app: "something-else" }),
      "http://localhost:47322/v1/hello": hello(false),
    });
    expect(await findRetrans(f)).toEqual({ base: "http://localhost:47322", paired: false });
  });
  it("returns null when every port fails", async () => {
    expect(await findRetrans(fake({}))).toBeNull();
  });
});

describe("liveApi", () => {
  const base = "http://localhost:47321";
  it("sends the bearer token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = fake({ [`${base}/v1/projects`]: () => json(200, [{ id: "t1", name: "T", baseLocale: "en", locales: ["en", "th"] }]) }, calls);
    const list = await liveApi(f, base, "tok").projects();
    expect(list[0].id).toBe("t1");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
  it("throws LinkError with the status on 401", async () => {
    const f = fake({ [`${base}/v1/projects`]: () => json(401, { error: "no" }) });
    await expect(liveApi(f, base, "tok").projects()).rejects.toMatchObject({ name: "LinkError", status: 401 });
  });
  it("throws the server's message", async () => {
    const f = fake({ [`${base}/v1/projects`]: () => json(422, { error: "x" }) });
    const err = await liveApi(f, base, "tok").projects().catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect(err.message).toBe("x");
    expect(err.status).toBe(422);
  });
  const bundle = { retransPreview: 1, sourceProjectId: "t1", exportedAt: "2026-01-01T00:00:00Z", baseLocale: "en", locale: "th", strings: [] };
  it("builds the bundle query and parses the body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const url = `${base}/v1/bundle?project=t%201&locale=th&includeReviewed=true`;
    const f = fake({ [url]: () => json(200, bundle) }, calls);
    expect((await liveApi(f, base, "tok").bundle("t 1", "th", true)).locale).toBe("th");
    expect(calls[0].url).toBe(url);
  });
  it("rejects an invalid bundle with the parse error", async () => {
    const f = fake({ [`${base}/v1/bundle?project=t1&locale=th&includeReviewed=false`]: () => json(200, { nope: 1 }) });
    const err = await liveApi(f, base, "tok").bundle("t1", "th", false).catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect(err.message).toBe("This isn't a Retrans preview file.");
  });
  it("posts results", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = fake({ [`${base}/v1/results?project=t1`]: () => json(202, {}) }, calls);
    const results = { retransPreviewResults: 1 as const, sourceProjectId: "t1", locale: "th", checkedAt: "x", results: [] };
    await liveApi(f, base, "tok").send("t1", results);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string).locale).toBe("th");
  });
});

describe("pair", () => {
  const base = "http://localhost:47321";
  it("posts the code and returns the token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = fake({ [`${base}/v1/pair`]: () => json(200, { token: "abc" }) }, calls);
    expect(await pair(f, base, "123456")).toBe("abc");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ code: "123456" });
  });
  it("explains a wrong code", async () => {
    const f = fake({ [`${base}/v1/pair`]: () => json(403, { error: "x" }) });
    const err = await pair(f, base, "000000").catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect(err.message).toBe("That code didn't work. Check it in Retrans and try again.");
    expect(err.status).toBe(403);
  });
});

describe("sendResults", () => {
  const base = "http://localhost:47321";
  const results = { retransPreviewResults: 1 as const, sourceProjectId: "proj-1", locale: "th", checkedAt: "x", results: [] };
  it("finds the project by its stable id when the saved tab id is stale (Retrans reopened)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = fake({
      [`${base}/v1/projects`]: () => json(200, [
        { id: "tab-other", name: "Other", projectId: "proj-2", baseLocale: "en", locales: ["en", "th"] },
        { id: "tab-new", name: "Shop", projectId: "proj-1", baseLocale: "en", locales: ["en", "th"] },
      ]),
      [`${base}/v1/results?project=tab-new`]: () => json(202, {}),
    }, calls);
    await sendResults(liveApi(f, base, "tok"), results, "Shop");
    expect(calls.map((c) => c.url)).toEqual([`${base}/v1/projects`, `${base}/v1/results?project=tab-new`]);
    expect(calls[1].init?.method).toBe("POST");
  });
  it("asks to open the project when no open project matches, and posts nothing", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = fake({ [`${base}/v1/projects`]: () => json(200, [{ id: "tab-old", name: "Shop", baseLocale: "en", locales: ["en", "th"] }]) }, calls);
    const err = await sendResults(liveApi(f, base, "tok"), results, "Shop").catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect(err.message).toBe("Open Shop in Retrans to send these results.");
    expect(calls.map((c) => c.url)).toEqual([`${base}/v1/projects`]);
  });
  it("says 'that project' when the name is unknown", async () => {
    const f = fake({ [`${base}/v1/projects`]: () => json(200, []) });
    const err = await sendResults(liveApi(f, base, "tok"), results).catch((e) => e);
    expect(err.message).toBe("Open that project in Retrans to send these results.");
  });
});

describe("linkAfterError", () => {
  const link = { base: "http://localhost:47321", paired: true };
  it("drops the link when Retrans can't be reached or timed out", () => {
    expect(linkAfterError(link, new LinkError("Can't reach Retrans. Is it open?", 0))).toBeNull();
  });
  it("keeps the link for an answer from Retrans or any other error", () => {
    expect(linkAfterError(link, new LinkError("x", 422))).toBe(link);
    expect(linkAfterError(link, new LinkError("x", 401))).toBe(link);
    expect(linkAfterError(link, new Error("x"))).toBe(link);
  });
});

describe("pickProject", () => {
  const list = [
    { id: "tab-a", name: "A", projectId: "proj-a", baseLocale: "en", locales: ["en", "th"] },
    { id: "tab-b", name: "B", projectId: "proj-b", baseLocale: "en", locales: ["en", "th"] },
  ];
  it("keeps the current pick while it is still open", () => {
    expect(pickProject(list, "tab-b", "proj-a")).toBe("tab-b");
  });
  it("otherwise picks the project the loaded drafts came from", () => {
    expect(pickProject(list, "tab-gone", "proj-b")).toBe("tab-b");
  });
  it("otherwise the first project, or none", () => {
    expect(pickProject(list, "", undefined)).toBe("tab-a");
    expect(pickProject([], "tab-a", "proj-a")).toBe("");
  });
});

describe("timeouts", () => {
  const never: Fetch = () => new Promise<Response>(() => {});
  it("findRetrans moves on from a port that never answers", async () => {
    const f: Fetch = (url) => (url.includes(":47321/") ? never(url) : fake({ "http://localhost:47322/v1/hello": hello(false) })(url));
    expect(await findRetrans(f, 20)).toEqual({ base: "http://localhost:47322", paired: false });
  });
  it("findRetrans gives up with null when no port ever answers", async () => {
    expect(await findRetrans(never, 5)).toBeNull();
  });
  it("a hung call rejects with a LinkError", async () => {
    const err = await liveApi(never, "http://localhost:47321", "tok", 20).projects().catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect(err.status).toBe(0);
    expect(err.message).toBe("Retrans didn't answer in time. Is it busy?");
  });
  it("a hung pair rejects with a LinkError", async () => {
    await expect(pair(never, "http://localhost:47321", "123456", 20)).rejects.toBeInstanceOf(LinkError);
  });
});
