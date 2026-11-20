import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { keyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { syncFromFigma } from "../figma/sync";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { buildPreviewBundle } from "./build";
import { parseBundle, type PreviewResults } from "./format";
import { answerLive, type LiveProject, type LiveRequest } from "./live";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");
const ENG = readFileSync(`${FIX}/ENG.tokens.json`, "utf8");
const TH = readFileSync(`${FIX}/TH.tokens.json`, "utf8");
const WARRANTY = keyId("figma-ALL", "ข้อมูลการรับประกัน");
const NOW = new Date("2026-11-20T10:00:00.000Z");

async function setup(): Promise<ProjectSession> {
  const w = await openFixtureWorkspace();
  const dir = `${w.root}/design/figma/ALL`;
  await w.fs.writeTextAtomic(`${dir}/ENG.tokens.json`, ENG);
  await w.fs.writeTextAtomic(`${dir}/TH.tokens.json`, TH);
  w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {} } });
  await syncFromFigma(w.session);
  w.session.setProjectSetting({ id: "t1" });
  return w.session;
}

const linked = (session: ProjectSession): LiveProject => ({ id: "t1", name: "fixture", session });
const bundleReq = (params: { project: string; locale: string; includeReviewed?: string }): LiveRequest => ({ id: 1, kind: "bundle", params });
const resultsReq = (project: string, body: unknown): LiveRequest => ({ id: 1, kind: "results", params: { project }, body });

/** A results file whose one verdict still matches the draft it was checked against. */
function resultsFor(session: ProjectSession, patch: Partial<PreviewResults> = {}): PreviewResults {
  const { bundle } = buildPreviewBundle(session, "en", { includeReviewed: false, now: NOW });
  const first = bundle.strings[0];
  return {
    retransPreviewResults: 1,
    sourceProjectId: "t1",
    locale: "en",
    checkedAt: NOW.toISOString(),
    results: first ? [{ key: first.key, hash: first.hash, verdict: "fits", flag: null }] : [],
    ...patch,
  };
}

describe("answerLive", () => {
  it("lists only the Figma-linked projects", async () => {
    const session = await setup();
    const plain = (await openFixtureWorkspace()).session;
    const res = answerLive(
      [linked(session), { id: "t2", name: "plain", session: plain }],
      { id: 1, kind: "projects", params: {} },
      vi.fn(),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "t1", name: "fixture", projectId: "t1", baseLocale: "th", locales: session.data.locales }]);
  });

  it("gives each project its stable project id, apart from the tab id", async () => {
    const session = await setup();
    const res = answerLive(
      [{ id: "tab-A", name: "fixture", session }],
      { id: 1, kind: "projects", params: {} },
      vi.fn(),
    );
    expect((res.body as Array<{ id: string; projectId?: string }>)[0]).toMatchObject({ id: "tab-A", projectId: "t1" });
  });

  it("answers a bundle a designer can read, honouring includeReviewed", async () => {
    const session = await setup();
    session.setText(WARRANTY, "en", "Warranty information");
    session.markReviewed(WARRANTY, "en");

    const plain = answerLive([linked(session)], bundleReq({ project: "t1", locale: "en" }), vi.fn());
    expect(plain.status).toBe(200);
    const parsed = parseBundle(JSON.stringify(plain.body));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bundle.strings.map((s) => s.key)).not.toContain(WARRANTY);

    const asked = answerLive([linked(session)], bundleReq({ project: "t1", locale: "en", includeReviewed: "true" }), vi.fn());
    expect(asked.status).toBe(200);
    const withReviewed = parseBundle(JSON.stringify(asked.body));
    if (!withReviewed.ok) throw new Error(withReviewed.error);
    expect(withReviewed.bundle.strings.find((s) => s.key === WARRANTY)?.status).toBe("reviewed");

    const notTrue = answerLive([linked(session)], bundleReq({ project: "t1", locale: "en", includeReviewed: "TRUE" }), vi.fn());
    const stillPlain = parseBundle(JSON.stringify(notTrue.body));
    if (!stillPlain.ok) throw new Error(stillPlain.error);
    expect(stillPlain.bundle.strings.map((s) => s.key)).not.toContain(WARRANTY);
  });

  it("refuses the base language with the builder's message", async () => {
    const session = await setup();
    const res = answerLive([linked(session)], bundleReq({ project: "t1", locale: "th" }), vi.fn());
    expect(res).toEqual({ status: 422, body: { error: "Pick a language other than the base language." } });
  });

  it("accepts results for a project and reports the diff", async () => {
    const session = await setup();
    session.setText(WARRANTY, "en", "Warranty information");
    const onResults = vi.fn();
    const res = answerLive([linked(session)], resultsReq("t1", resultsFor(session)), onResults);
    expect(res).toEqual({ status: 202, body: {} });
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onResults.mock.calls[0][0]).toBe("t1");
    expect(onResults.mock.calls[0][1]).toMatchObject({ locale: "en", otherProject: false, fits: 1, tooLong: 0 });
  });

  it("refuses results it cannot read and results for the base language", async () => {
    const session = await setup();
    session.setText(WARRANTY, "en", "Warranty information");
    const onResults = vi.fn();

    const unreadable = answerLive([linked(session)], resultsReq("t1", { nope: true }), onResults);
    expect(unreadable).toEqual({ status: 422, body: { error: "This isn't a Retrans results file." } });

    const base = answerLive([linked(session)], resultsReq("t1", resultsFor(session, { locale: "th" })), onResults);
    expect(base.status).toBe(422);
    expect(base.body).toMatchObject({ error: expect.any(String) });

    expect(onResults).not.toHaveBeenCalled();
  });

  it("404s for a project that is no longer open", async () => {
    const session = await setup();
    const onResults = vi.fn();
    const gone = { status: 404, body: { error: "That project isn't open in Retrans any more." } };
    expect(answerLive([linked(session)], bundleReq({ project: "gone", locale: "en" }), onResults)).toEqual(gone);
    expect(answerLive([linked(session)], resultsReq("gone", resultsFor(session)), onResults)).toEqual(gone);
    expect(onResults).not.toHaveBeenCalled();
  });
});
