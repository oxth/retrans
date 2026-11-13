import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const events = vi.hoisted(() => ({ handlers: new Map<string, (e: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, h: (e: { payload: unknown }) => void) => {
    events.handlers.set(name, h);
    return () => events.handlers.delete(name);
  }),
}));

import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { MemoryFs } from "../platform/memory-fs";
import type { ManyRequest, MtEngine } from "./translate";
import { acpTranslator, BATCH_CELLS, cloudTranslator, LOCAL_GROUP, localTranslator, translateMissingMulti } from "./translator";

const R = "/p";
const j = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

/** en base with `n` keys (k0…), th and ja empty. */
async function project(n: number, text = (i: number) => `Hello ${i}`) {
  const en: Record<string, string> = {};
  for (let i = 0; i < n; i++) en[`k${i}`] = text(i);
  const fs = new MemoryFs({
    [`${R}/public/locales/en/common.json`]: j(en),
    [`${R}/public/locales/th/common.json`]: j({}),
    [`${R}/public/locales/ja/common.json`]: j({}),
  });
  const d = (await detectProject(fs, R))!;
  return ProjectSession.open(fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
}

/** A cloud reply translating every string in the request: "<locale>:<masked text>". */
function echoReply(user: string): string {
  const req = JSON.parse(user) as { targets: string[]; strings: Array<{ id: string; text: string }> };
  const out: Record<string, Record<string, string>> = {};
  for (const s of req.strings) out[s.id] = Object.fromEntries(req.targets.map((t) => [t, `${t}:${s.text}`]));
  return JSON.stringify(out);
}

beforeEach(() => {
  invoke.mockReset();
});

describe("translators", () => {
  it("local translator never invokes a cloud or ACP command", async () => {
    const s = await project(3);
    const engine: MtEngine = { generate: vi.fn(async () => "สวัสดี"), cancel: vi.fn(async () => {}) };
    const t = localTranslator(engine, { path: "/m.gguf", template: "qwen3" }, "next-i18next");
    expect(t.remote).toBe(false);
    await translateMissingMulti(s, ["th"], "all", t, () => {}, new AbortController().signal);
    expect(engine.generate).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.filter(([cmd]) => String(cmd).startsWith("mt_cloud") || String(cmd).startsWith("mt_acp"))).toEqual([]);
  });

  it("built-in model: each distinct text once per language, decoded together in groups of 8", async () => {
    const words = ["Save", "Cancel", "Delete this project now", "OK", "Settings"];
    const s = await project(20, (i) => words[i % words.length]); // 20 keys, 5 distinct texts
    let n = 0;
    const generateMany = vi.fn(async (r: ManyRequest) => r.prompts.map(() => ({ ok: true as const, text: `t${n++}` })));
    const engine: MtEngine = { generate: vi.fn(async () => "x"), generateMany, cancel: vi.fn(async () => {}) };
    const t = localTranslator(engine, { path: "/m.gguf", template: "qwen3" }, "next-i18next");
    const r = await translateMissingMulti(s, ["th", "ja"], "all", t, () => {}, new AbortController().signal);
    // 5 texts × 2 languages = 10 translations, not 40: two calls of at most LOCAL_GROUP.
    expect(generateMany.mock.calls.map(([q]) => q.prompts.length)).toEqual([LOCAL_GROUP, 2]);
    expect(engine.generate).not.toHaveBeenCalled();
    expect(r.th.translated).toBe(20);
    expect(r.ja.translated).toBe(20);
    // Keys with the same text got the same translation.
    expect(s.value("common::k0", "th")).toEqual(s.value("common::k5", "th"));
    expect(s.value("common::k0", "th")).not.toEqual(s.value("common::k1", "th"));
    // Shortest first: a group runs until its longest text is done.
    const lengths = generateMany.mock.calls[0][0].prompts.map((p) => p.maxTokens);
    expect([...lengths].sort((a, b) => a - b)).toEqual(lengths);
  });

  it("built-in model: one string that's too long fails alone; the run goes on", async () => {
    const s = await project(3);
    const generateMany = vi.fn(async (r: ManyRequest) =>
      r.prompts.map((_, i) => (i === 1 ? { ok: false as const, message: "Text is too long to translate" } : { ok: true as const, text: "ok" })),
    );
    const t = localTranslator({ generate: vi.fn(), generateMany, cancel: vi.fn(async () => {}) }, { path: "/m.gguf", template: "qwen3" }, "next-i18next");
    const r = await translateMissingMulti(s, ["th"], "all", t, () => {}, new AbortController().signal);
    expect(r.th.translated).toBe(2);
    expect(r.th.failed).toHaveLength(1);
    expect(r.th.failed[0].message).toBe("Text is too long to translate");
  });

  it("built-in model: cancelling stops after the group in flight", async () => {
    const s = await project(30);
    const ctl = new AbortController();
    const cancel = vi.fn(async () => {});
    const generateMany = vi.fn(async (_: ManyRequest) => {
      ctl.abort(); // the user cancels while the first group runs
      throw new Error("cancelled");
    });
    const t = localTranslator({ generate: vi.fn(), generateMany, cancel }, { path: "/m.gguf", template: "qwen3" }, "next-i18next");
    const r = await translateMissingMulti(s, ["th"], "all", t, () => {}, ctl.signal);
    expect(generateMany).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
    expect(r.th.translated).toBe(0);
    expect(r.th.cancelled).toBe(true);
  });

  it("cloud translator batches 120 strings × 2 languages into 3 requests (50 + 50 + 20)", async () => {
    const s = await project(120);
    invoke.mockImplementation(async (cmd: string, args: { req: { user: string } }) => {
      if (cmd === "mt_cloud_chat") return echoReply(args.req.user);
    });
    const t = cloudTranslator({ provider: "openai", model: "gpt-x" }, "next-i18next");
    const r = await translateMissingMulti(s, ["th", "ja"], "all", t, () => {}, new AbortController().signal);
    expect(invoke.mock.calls.filter(([c]) => c === "mt_cloud_chat")).toHaveLength(3);
    expect(r.th.translated).toBe(120);
    expect(r.ja.translated).toBe(120);
    expect(s.value("common::k3", "ja")).toEqual({ kind: "text", text: "ja:Hello 3" });
    const req = invoke.mock.calls[0][1].req;
    expect(req).toMatchObject({ provider: "openai", model: "gpt-x" });
    expect(JSON.parse(req.user).targets).toEqual(["th", "ja"]);
  });

  it("one unsafe string in a batch doesn't sink the batch", async () => {
    const s = await project(3, (i) => (i === 1 ? "Hi {{name}}" : `Plain ${i}`));
    invoke.mockImplementation(async (_cmd: string, args: { req: { user: string } }) => {
      const reply = JSON.parse(echoReply(args.req.user));
      reply["common::k1"].th = "สวัสดี"; // placeholder dropped
      return JSON.stringify(reply);
    });
    const r = await translateMissingMulti(s, ["th"], "all", cloudTranslator({ provider: "anthropic", model: "c" }, "next-i18next"), () => {}, new AbortController().signal);
    expect(r.th.unsafe).toEqual(["common::k1"]);
    expect(r.th.translated).toBe(2);
    expect(s.value("common::k1", "th")).toBeUndefined();
  });

  it("incomplete reply marks only the missing cells failed", async () => {
    const s = await project(2);
    invoke.mockImplementation(async (_cmd: string, args: { req: { user: string } }) => {
      const reply = JSON.parse(echoReply(args.req.user));
      delete reply["common::k0"];
      return "Sure! ```json\n" + JSON.stringify(reply) + "\n```";
    });
    const r = await translateMissingMulti(s, ["th"], "all", cloudTranslator({ provider: "openai", model: "m" }, "next-i18next"), () => {}, new AbortController().signal);
    expect(r.th.translated).toBe(1);
    expect(r.th.failed).toEqual([{ id: "common::k0", message: "The model's reply was incomplete." }]);
  });

  it("translateMissingMulti reports progress per language and cancels everything", async () => {
    const s = await project(30);
    const ac = new AbortController();
    const progress: Array<Record<string, { done: number; total: number }>> = [];
    invoke.mockImplementation(async (cmd: string, args: { req: { user: string } }) => {
      if (cmd !== "mt_cloud_chat") return;
      ac.abort(); // cancel while the first request is in flight
      return echoReply(args.req.user);
    });
    const r = await translateMissingMulti(s, ["th", "ja"], "all", cloudTranslator({ provider: "openai", model: "m" }, "next-i18next"), (p) => progress.push(p.perLocale), ac.signal);
    expect(progress[0]).toEqual({ th: { done: 0, total: 30 }, ja: { done: 0, total: 30 } });
    expect(invoke.mock.calls.filter(([c]) => c === "mt_cloud_chat")).toHaveLength(1);
    expect(invoke.mock.calls.some(([c]) => c === "mt_cloud_cancel")).toBe(true);
    expect(r.th.cancelled && r.ja.cancelled).toBe(true);
    expect(r.th.translated).toBe(0); // the reply that arrived after cancel is not written
  });

  it("results are machine-marked, never reviewed", async () => {
    const s = await project(1);
    invoke.mockImplementation(async (_c: string, a: { req: { user: string } }) => echoReply(a.req.user));
    await translateMissingMulti(s, ["th"], "all", cloudTranslator({ provider: "openai", model: "m" }, "next-i18next"), () => {}, new AbortController().signal);
    const m = s.meta("common::k0", "th");
    expect(m.machine).toBe(true);
    expect(m.status).not.toBe("reviewed");
  });

  it("a provider error stops the run with its message", async () => {
    const s = await project(45);
    invoke.mockRejectedValue("The API key was rejected.");
    const r = await translateMissingMulti(s, ["th"], "all", cloudTranslator({ provider: "openai", model: "m" }, "next-i18next"), () => {}, new AbortController().signal);
    expect(invoke.mock.calls.filter(([c]) => c === "mt_cloud_chat")).toHaveLength(1);
    expect(r.th.failed[0]).toEqual({ id: "common::k0", message: "The API key was rejected." });
    expect(r.th.translated).toBe(0);
  });

  it("ACP translator sends one text block to the agent", async () => {
    const s = await project(2);
    invoke.mockImplementation(async (cmd: string, args: { req: { text: string } }) => {
      if (cmd !== "mt_acp_prompt") return;
      const user = args.req.text.slice(args.req.text.indexOf('{"source"'));
      return echoReply(user);
    });
    const t = acpTranslator({ preset: "custom", command: "agent", args: ["--acp"] }, "next-i18next");
    const r = await translateMissingMulti(s, ["th"], "all", t, () => {}, new AbortController().signal);
    expect(r.th.translated).toBe(2);
    expect(invoke.mock.calls[0][1].req).toMatchObject({ command: "agent", args: ["--acp"] });
  });
});

describe("review fixes", () => {
  it("a request never carries more than BATCH_CELLS cells", async () => {
    const fs = new MemoryFs({
      [`${R}/public/locales/en/common.json`]: j(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, `Hi ${i}`]))),
      ...Object.fromEntries(["th", "ja", "de", "fr", "es"].map((l) => [`${R}/public/locales/${l}/common.json`, j({})])),
    });
    const d = (await detectProject(fs, R))!;
    const s = await ProjectSession.open(fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
    invoke.mockImplementation(async (cmd: string, args: { req: { user: string } }) => (cmd === "mt_cloud_chat" ? echoReply(args.req.user) : undefined));
    const r = await translateMissingMulti(s, ["th", "ja", "de", "fr", "es"], "all", cloudTranslator({ provider: "anthropic", model: "c" }, "next-i18next"), () => {}, new AbortController().signal);
    const calls = invoke.mock.calls.filter(([c]) => c === "mt_cloud_chat");
    for (const [, a] of calls) {
      const u = JSON.parse(a.req.user);
      expect(u.strings.length * u.targets.length).toBeLessThanOrEqual(BATCH_CELLS);
    }
    expect(calls.length).toBe(2); // 40 strings × 5 languages = 200 cells: 150 + 50
    expect(Object.values(r).every((x) => x.translated === 40)).toBe(true);
  });

  it("a streamed reply writes each translation as soon as its entry is complete", async () => {
    const s = await project(2);
    let release!: (v: string) => void;
    invoke.mockImplementation(async (cmd: string, a: { req: { reqId: number } }) => {
      if (cmd !== "mt_cloud_chat") return;
      const emit = (delta: string) => events.handlers.get("mt-cloud-delta")?.({ payload: { reqId: a.req.reqId, delta } });
      emit('{"common::k0": {"th": "ศูนย์"}, ');
      emit('"common::k1": {"th": "หนึ');
      return new Promise((res) => (release = res));
    });
    const run = translateMissingMulti(s, ["th"], "all", cloudTranslator({ provider: "openai", model: "m" }, "next-i18next"), () => {}, new AbortController().signal);
    await vi.waitFor(() => expect(s.value("common::k0", "th")).toEqual({ kind: "text", text: "ศูนย์" }));
    expect(s.value("common::k1", "th")).toBeUndefined(); // still arriving
    release('{"common::k0": {"th": "ศูนย์"}, "common::k1": {"th": "หนึ่ง"}}');
    const r = await run;
    expect(r.th.translated).toBe(2);
    expect(s.value("common::k1", "th")).toEqual({ kind: "text", text: "หนึ่ง" });
  });
});
