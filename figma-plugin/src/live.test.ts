import { describe, expect, it } from "vitest";
import { type Fetch, LinkError, findRetrans, liveApi, pair, sendTarget } from "./live";

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

describe("sendTarget", () => {
  it("uses the project picked at Get drafts, not the bundle's own id", () => {
    expect(sendTarget("tab-7", "tab-9")).toBe("tab-7");
  });
  it("falls back to the picker for a file-loaded bundle", () => {
    expect(sendTarget(undefined, "tab-9")).toBe("tab-9");
  });
  it("is null when there is no Retrans project", () => {
    expect(sendTarget(undefined, "")).toBeNull();
  });
  it("posts results to the picked id", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = fake({ "http://localhost:47321/v1/results?project=tab-7": () => json(202, {}) }, calls);
    const results = { retransPreviewResults: 1 as const, sourceProjectId: "uuid-not-a-tab", locale: "th", checkedAt: "x", results: [] };
    await liveApi(f, "http://localhost:47321", "tok").send(sendTarget("tab-7", "")!, results);
    expect(calls[0].url).toBe("http://localhost:47321/v1/results?project=tab-7");
  });
});
