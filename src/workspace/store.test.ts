import { describe, expect, it } from "vitest";
import { MemoryFs } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { keyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { parseState, STATE_PATH } from "../core/state-file";
import {
  BASELINE_PATH, parseBaseline, parseWorkspaceMeta, serializeBaseline, serializeWorkspaceMeta,
  WORKSPACE_DIR, WORKSPACE_META_PATH, type WorkspaceMeta,
} from "./meta";
import { createWorkspace, detectWorkspace } from "./store";

const R = "/project";
const j = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

async function open(fs: MemoryFs) {
  const d = (await detectProject(fs, R))!;
  const s = await ProjectSession.open(fs, R, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
  return { d, s };
}

async function demo() {
  const fs = new MemoryFs({});
  await createWorkspace(fs, R, { name: "Demo", baseLocale: "th", locales: ["th", "en"] });
  return fs;
}

describe("workspace store", () => {
  it("createWorkspace then detect/open: groups, locales, base", async () => {
    const fs = await demo();
    expect(BASELINE_PATH).toBe(".retrans/source-baseline.json");
    expect(await fs.readText(`${R}/${WORKSPACE_DIR}/th/common.json`)).toBe("{}\n");
    expect(await fs.readText(`${R}/${WORKSPACE_DIR}/en/common.json`)).toBe("{}\n");
    expect(parseState(await fs.readText(`${R}/${STATE_PATH}`)).state.project.baseLocale).toBe("th");
    const w = await detectWorkspace(fs, R);
    expect(w?.workspace?.name).toBe("Demo");
    const d = (await detectProject(fs, R))!;
    expect(d.format).toBe("next-i18next");
    expect(d.workspace?.name).toBe("Demo");
    expect(d.localesPath).toBe(".retrans/workspace");
    expect(d.locales).toEqual(["th", "en"]);
    expect(d.baseLocale).toBe("th");
    expect(d.namespaces).toEqual(["common"]);
    const { s } = await open(fs);
    expect(s.workspace?.name).toBe("Demo");
    expect(s.data.locales).toEqual(["th", "en"]);
    expect(s.data.baseLocale).toBe("th");
    expect(s.data.namespaces).toEqual(["common"]);
  });

  it("edits save into .retrans/workspace and meta round-trips", async () => {
    const fs = await demo();
    const { s } = await open(fs);
    s.addKey("common", "hello", "สวัสดี");
    s.setText(keyId("common", "hello"), "en", "Hello");
    s.addKey("common", "nav.home", "หน้าแรก");
    await s.save();
    expect(await fs.readText(`${R}/${WORKSPACE_DIR}/en/common.json`)).toBe('{\n  "hello": "Hello"\n}\n');
    expect(JSON.parse(await fs.readText(`${R}/${WORKSPACE_DIR}/th/common.json`))).toEqual({
      hello: "สวัสดี", "nav.home": "หน้าแรก",
    });

    // A no-op save writes nothing.
    const before = fs.snapshot();
    fs.writes.length = 0;
    expect(s.isDirty()).toBe(false);
    await s.save();
    expect(fs.writes).toEqual([]);
    expect(fs.snapshot()).toEqual(before);

    s.setWorkspaceMeta({ removedInSource: ["common::x"] });
    expect(s.isDirty()).toBe(true);
    const r = await s.save();
    expect(r.written).toEqual([WORKSPACE_META_PATH]);
    expect(s.isDirty()).toBe(false);
    const { s: s2 } = await open(fs);
    expect(s2.workspace?.removedInSource).toEqual(["common::x"]);
    expect(s2.workspace?.name).toBe("Demo");

    // Setting the same value again is not a change.
    fs.writes.length = 0;
    s2.setWorkspaceMeta({ removedInSource: ["common::x"] });
    expect(s2.isDirty()).toBe(false);
    await s2.save();
    expect(fs.writes).toEqual([]);
  });

  it("a meta file changed on disk is not overwritten", async () => {
    const fs = await demo();
    const { s } = await open(fs);
    const external = j({ retransWorkspace: 1, name: "Renamed elsewhere" });
    await fs.writeTextAtomic(`${R}/${WORKSPACE_META_PATH}`, external);
    s.setWorkspaceMeta({ duplicates: ["a"] });
    const r = await s.save();
    expect(r.stale).toEqual([WORKSPACE_META_PATH]);
    expect(await fs.readText(`${R}/${WORKSPACE_META_PATH}`)).toBe(external);
    expect(s.isDirty()).toBe(true);
  });

  it("stale meta: reload merges it (local fields win) and the retried save succeeds", async () => {
    const fs = await demo();
    const { s } = await open(fs);
    const { s: idle } = await open(fs);
    s.setWorkspaceMeta({ duplicates: ["a"] });
    const disk = parseWorkspaceMeta(await fs.readText(`${R}/${WORKSPACE_META_PATH}`))!;
    await fs.writeTextAtomic(`${R}/${WORKSPACE_META_PATH}`, serializeWorkspaceMeta({ ...disk, name: "Renamed", duplicates: ["z"] }));
    expect((await s.save()).stale).toEqual([WORKSPACE_META_PATH]);
    await s.reloadFromDisk();
    expect(s.workspace).toMatchObject({ name: "Renamed", duplicates: ["a"] });
    const r = await s.save();
    expect(r.stale).toEqual([]);
    expect(r.written).toEqual([WORKSPACE_META_PATH]);
    expect(s.isDirty()).toBe(false);
    expect(parseWorkspaceMeta(await fs.readText(`${R}/${WORKSPACE_META_PATH}`))).toMatchObject({ name: "Renamed", duplicates: ["a"] });

    // No local change: the disk meta is adopted and the session stays clean.
    await idle.reloadFromDisk();
    expect(idle.workspace).toMatchObject({ name: "Renamed", duplicates: ["a"] });
    expect(idle.isDirty()).toBe(false);
  });

  it("a malformed meta on reload is never overwritten and is reported", async () => {
    const fs = await demo();
    const { s } = await open(fs);
    await fs.writeTextAtomic(`${R}/${WORKSPACE_META_PATH}`, "<<<<<<< HEAD\n");
    s.setWorkspaceMeta({ duplicates: ["a"] });
    await s.reloadFromDisk();
    expect(s.errors.map((e) => e.relPath)).toContain(WORKSPACE_META_PATH);
    const r = await s.save();
    expect(r.written).not.toContain(WORKSPACE_META_PATH);
    expect(await fs.readText(`${R}/${WORKSPACE_META_PATH}`)).toBe("<<<<<<< HEAD\n");
    expect(s.isDirty()).toBe(true);
  });

  it("an unreadable workspace.json is an error, not another format", async () => {
    const fs = await demo();
    await fs.writeTextAtomic(`${R}/public/locales/en/common.json`, j({ a: "A" }));
    await fs.writeTextAtomic(`${R}/${WORKSPACE_META_PATH}`, "{ broken");
    const msg = "Can't read .retrans/workspace.json — fix it (e.g. resolve merge markers) and open again.";
    await expect(detectWorkspace(fs, R)).rejects.toThrow(msg);
    await expect(detectProject(fs, R)).rejects.toThrow(msg);
  });

  it("new languages and groups in a workspace are flat files", async () => {
    const fs = await demo();
    const { s } = await open(fs);
    s.addKey("common", "a.b", "เอบี");
    s.addLanguage("ja");
    s.addNamespace("menu");
    await s.save();
    s.setText(keyId("common", "a.b"), "ja", "エービー");
    s.addKey("menu", "x.y", "เอ็กซ์");
    await s.save();
    expect(JSON.parse(await fs.readText(`${R}/${WORKSPACE_DIR}/ja/common.json`))).toEqual({ "a.b": "エービー" });
    expect(JSON.parse(await fs.readText(`${R}/${WORKSPACE_DIR}/th/menu.json`))).toEqual({ "x.y": "เอ็กซ์" });
  });

  it("addLanguage in a workspace returns no config snippet", async () => {
    const fs = await demo();
    const { s } = await open(fs);
    expect(s.addLanguage("ja")).toEqual({});
    const r = await s.save();
    expect(r.written).toContain(`${WORKSPACE_DIR}/ja/common.json`);
    expect(await fs.exists(`${R}/next-i18next.config.js`)).toBe(false);
  });

  it("meta parse rejects garbage without throwing", () => {
    expect(parseWorkspaceMeta(null)).toBeNull();
    expect(parseWorkspaceMeta("")).toBeNull();
    expect(parseWorkspaceMeta("{not json")).toBeNull();
    expect(parseWorkspaceMeta("[]")).toBeNull();
    expect(parseWorkspaceMeta('"x"')).toBeNull();
    expect(parseWorkspaceMeta(j({ retransWorkspace: 2, name: "x" }))).toBeNull();
    expect(parseWorkspaceMeta(j({ name: "x" }))).toBeNull();
    expect(parseWorkspaceMeta(j({ retransWorkspace: 1 }))).toBeNull();
    // Malformed optional parts are dropped, not fatal.
    const m = parseWorkspaceMeta(
      j({ retransWorkspace: 1, name: "x", drafts: 5, markers: { "common::a": { en: 1, th: "y" } }, removedInSource: [1, "common::b"], emptyKeys: ["common::z", 2], source: { type: "js" }, lastExport: { target: { kind: "nope" } } }),
    );
    expect(m).toEqual({
      retransWorkspace: 1, name: "x", drafts: {}, markers: { "common::a": { th: "y" } },
      removedInSource: ["common::b"], duplicates: [], emptyKeys: ["common::z"],
    });
    expect(parseBaseline("nope")).toBeNull();
    expect(parseBaseline(null)).toBeNull();
  });

  it("meta and baseline serialize with sorted keys and round-trip", () => {
    const m: WorkspaceMeta = {
      retransWorkspace: 1, name: "N", source: { type: "ts", localesDir: "src/locales" },
      drafts: { "common::a": { en: "draft" } }, markers: {}, removedInSource: [], duplicates: ["a"], emptyKeys: ["common::e"],
      lastExport: { target: { kind: "i18next-json", dir: "out", namespaces: "single" } },
    };
    const text = serializeWorkspaceMeta(m);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.indexOf('"drafts"')).toBeLessThan(text.indexOf('"name"'));
    expect(parseWorkspaceMeta(text)).toEqual(m);
    const b = { "common::a": { th: "ก", en: "A" } };
    expect(parseBaseline(serializeBaseline(b))).toEqual(b);
    expect(serializeBaseline(b)).toBe('{\n  "common::a": {\n    "en": "A",\n    "th": "ก"\n  }\n}\n');
  });

  it("a plain next-i18next project still detects as before", async () => {
    const fs = new MemoryFs({
      [`${R}/public/locales/en/common.json`]: j({ a: "A" }),
      [`${R}/public/locales/th/common.json`]: j({ a: "เอ" }),
      [`${R}/${STATE_PATH}`]: j({ version: 1, project: { baseLocale: "en" }, entries: {} }),
    });
    expect(await detectWorkspace(fs, R)).toBeNull();
    const d = (await detectProject(fs, R))!;
    expect(d).toEqual({
      format: "next-i18next", baseLocale: null, locales: ["en", "th"], namespaces: ["common"],
      localesPath: "public/locales", keyCount: 1,
    });
    expect("workspace" in d).toBe(false);
    const { s } = await open(fs);
    expect(s.workspace).toBeNull();
    expect(s.addLanguage("ja").configSnippet).toBe("locales: ['en', 'ja', 'th'],");
  });
});
