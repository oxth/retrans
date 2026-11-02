import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadFixtureDir } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { keyId } from "./model";
import { STATE_PATH } from "./state-file";
import { KeyError, ProjectSession } from "./session";

const R = "/project";
const NEXT = "public/locales";

async function openFx(name: string) {
  const fs = loadFixtureDir(resolve(__dirname, "../test/fixtures", name));
  const d = (await detectProject(fs, R))!;
  const opts = { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath };
  const s = await ProjectSession.open(fs, R, d, opts);
  return { fs, s };
}

const read = async (fs: { readText(p: string): Promise<string> }, rel: string) => fs.readText(`${R}/${rel}`);
const json = async (fs: { readText(p: string): Promise<string> }, rel: string) => JSON.parse(await read(fs, rel));
const c = (k: string) => keyId("common", k);

describe("ProjectSession", () => {
  it.each(["next-nested", "next-flat-crlf", "next-broken", "paraglide"])(
    "open then save with no edits writes nothing (%s)",
    async (name) => {
      const { fs, s } = await openFx(name);
      const before = fs.snapshot();
      expect(s.isDirty()).toBe(false);
      const r = await s.save();
      expect(fs.writes).toEqual([]);
      expect(r).toEqual({ written: [], deleted: [], stale: [] });
      expect(fs.snapshot()).toEqual(before);
    },
  );

  it("editing one value changes exactly one line in one file", async () => {
    const { fs, s } = await openFx("next-nested");
    const before = await read(fs, `${NEXT}/th/common.json`);
    s.setText(c("nav.home"), "th", "หน้าแรก \"ใหม่\" 🎉");
    expect(s.dirtyCells()).toEqual([{ id: c("nav.home"), locale: "th" }]);
    const r = await s.save();
    expect(r.written.filter((p) => p !== STATE_PATH)).toEqual([`${NEXT}/th/common.json`]);
    const after = await read(fs, `${NEXT}/th/common.json`);
    const a = before.split("\n");
    const b = after.split("\n");
    expect(b.length).toBe(a.length);
    expect(a.filter((l, i) => l !== b[i])).toHaveLength(1);
    expect(after).toContain('"home": "หน้าแรก \\"ใหม่\\" 🎉"');
    expect(s.isDirty()).toBe(false);
  });

  it("CRLF + tab style survives an edit", async () => {
    const { fs, s } = await openFx("next-flat-crlf");
    s.setText(c("a.body"), "th", "เนื้อหา");
    await s.save();
    expect(await read(fs, `${NEXT}/th/common.json`)).toBe(
      '{\r\n\t"a.title": "สวัสดี",\r\n\t"a.body": "เนื้อหา"\r\n}',
    );
  });

  it("clearing a value removes the key from that locale file (no \"\")", async () => {
    const { fs, s } = await openFx("next-nested");
    s.setText(c("title"), "th", "");
    s.setText(c("nav.home"), "th", null);
    await s.save();
    const text = await read(fs, `${NEXT}/th/common.json`);
    expect(JSON.parse(text)).toEqual({ orphan: "เศษ" });
    expect(text).not.toContain('""');
    expect(s.value(c("title"), "th")).toBeUndefined();
  });

  it("edits a literal dotted segment in place, also when creating it in another locale", async () => {
    const { fs, s } = await openFx("next-nested");
    s.setText(c("lit.a.b"), "th", "y");
    s.setText(c("lit.a.b"), "en", "z");
    await s.save();
    expect((await json(fs, `${NEXT}/th/common.json`)).lit).toEqual({ "a.b": "y" });
    expect((await json(fs, `${NEXT}/en/common.json`)).lit).toEqual({ "a.b": "z" });
  });

  it("literal dotted key stays literal after clear -> save -> re-set (base)", async () => {
    const { fs, s } = await openFx("next-nested");
    s.setText(c("lit.a.b"), "en", null);
    await s.save();
    expect((await json(fs, `${NEXT}/en/common.json`)).lit).toBeUndefined();
    s.setText(c("lit.a.b"), "en", "back");
    await s.save();
    expect((await json(fs, `${NEXT}/en/common.json`)).lit).toEqual({ "a.b": "back" });
  });

  it("literal dotted key stays literal in th after the en value was cleared and re-set", async () => {
    const { fs, s } = await openFx("next-nested");
    s.setText(c("lit.a.b"), "en", null);
    await s.save();
    s.setText(c("lit.a.b"), "th", "y");
    await s.save();
    expect((await json(fs, `${NEXT}/th/common.json`)).lit).toEqual({ "a.b": "y" });
    s.setText(c("lit.a.b"), "th", null);
    await s.save();
    s.setText(c("lit.a.b"), "en", "back");
    s.setText(c("lit.a.b"), "th", "again");
    s.addLanguage("fr");
    s.setText(c("lit.a.b"), "fr", "encore");
    await s.save();
    expect((await json(fs, `${NEXT}/en/common.json`)).lit).toEqual({ "a.b": "back" });
    expect((await json(fs, `${NEXT}/th/common.json`)).lit).toEqual({ "a.b": "again" });
    expect((await json(fs, `${NEXT}/fr/common.json`)).lit).toEqual({ "a.b": "encore" });
  });

  it("addKey with an empty base text is invalid", async () => {
    const { s } = await openFx("next-nested");
    expect(() => s.addKey("common", "fresh", "")).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(s.data.keyOrder).not.toContain(c("fresh"));
  });

  it("addKey adds to the base file only; other locales stay absent", async () => {
    const { fs, s } = await openFx("next-nested");
    const thBefore = await read(fs, `${NEXT}/th/common.json`);
    const id = s.addKey("common", "footer.note", "Note");
    expect(id).toBe(c("footer.note"));
    expect(s.data.keyOrder).toContain(id);
    expect(s.value(id, "th")).toBeUndefined();
    const r = await s.save();
    expect(r.written).toEqual([`${NEXT}/en/common.json`]);
    expect((await json(fs, `${NEXT}/en/common.json`)).footer).toEqual({ note: "Note" });
    expect(await read(fs, `${NEXT}/th/common.json`)).toBe(thBefore);
  });

  it("addKey plural creates base categories", async () => {
    const { fs, s } = await openFx("next-nested");
    const id = s.addKey("common", "apples", "{{count}} apples", { plural: true });
    expect(id).toBe(c("apples_other"));
    expect(s.data.keyOrder).toEqual(expect.arrayContaining([c("apples_one"), c("apples_other")]));
    await s.save();
    const en = await json(fs, `${NEXT}/en/common.json`);
    expect(en.apples_one).toBe("{{count}} apples");
    expect(en.apples_other).toBe("{{count}} apples");
  });

  it("rejects prefix collisions", async () => {
    const { s } = await openFx("next-nested");
    const order = s.data.keyOrder;
    const v = s.version;
    const err = (() => {
      try {
        s.addKey("common", "nav.home.sub", "x");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(KeyError);
    expect((err as KeyError).code).toBe("prefix-collision");
    expect(() => s.addKey("common", "nav", "x")).toThrow(expect.objectContaining({ code: "prefix-collision" }));
    expect(() => s.addKey("common", "title", "x")).toThrow(expect.objectContaining({ code: "exists" }));
    for (const bad of ["", ".a", "a.", "a..b", "a::b"]) {
      expect(() => s.addKey("common", bad, "x")).toThrow(expect.objectContaining({ code: "invalid" }));
    }
    expect(() => s.addKey("nope", "x", "x")).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => s.renameKey(c("title"), "nav.home")).toThrow(expect.objectContaining({ code: "exists" }));
    expect(() => s.renameKey(c("title"), "nav")).toThrow(expect.objectContaining({ code: "prefix-collision" }));
    expect(s.data.keyOrder).toBe(order);
    expect(s.version).toBe(v);
    expect(s.isDirty()).toBe(false);
  });

  it("renameKey moves values in every locale and moves state entries", async () => {
    const { fs, s } = await openFx("next-nested");
    s.markReviewed(c("nav.home"), "th");
    await s.save();
    const idx = s.data.keyOrder.indexOf(c("nav.home"));
    const newId = s.renameKey(c("nav.home"), "nav.start");
    expect(newId).toBe(c("nav.start"));
    expect(s.data.keyOrder.indexOf(newId)).toBe(idx);
    expect(s.data.keyOrder).not.toContain(c("nav.home"));
    expect(s.meta(newId, "th").status).toBe("reviewed");
    await s.save();
    expect((await json(fs, `${NEXT}/en/common.json`)).nav).toEqual({ about: "About", start: "Home" });
    expect((await json(fs, `${NEXT}/th/common.json`)).nav).toEqual({ start: "หน้าแรก" });
    const st = await json(fs, STATE_PATH);
    expect(Object.keys(st.entries)).toEqual([newId]);
  });

  it("deleteKey removes from all locale files and state", async () => {
    const { fs, s } = await openFx("next-nested");
    s.markReviewed(c("title"), "th");
    await s.save();
    s.deleteKey(c("title"));
    s.deleteKey(c("items_other"));
    expect(s.data.keyOrder.some((k) => k.startsWith(c("items_")))).toBe(false);
    expect(s.data.keyOrder).not.toContain(c("title"));
    await s.save();
    const en = await json(fs, `${NEXT}/en/common.json`);
    expect(en.title).toBeUndefined();
    expect(en.items_one).toBeUndefined();
    expect(en.items_other).toBeUndefined();
    expect((await json(fs, `${NEXT}/th/common.json`)).title).toBeUndefined();
    expect((await json(fs, STATE_PATH)).entries).toEqual({});
  });

  it("addLanguage creates files copying base style; for next returns snippet", async () => {
    const { fs, s } = await openFx("next-nested");
    expect(s.addLanguage("fr")).toEqual({ configSnippet: "locales: ['en', 'fr', 'th']," });
    expect(s.data.locales).toEqual(["en", "fr", "th"]);
    expect(() => s.addLanguage("fr")).toThrow();
    expect(() => s.addLanguage("not a locale!")).toThrow();
    expect(s.isDirty()).toBe(true);
    s.setText(c("lit.a.b"), "fr", "salut");
    const r = await s.save();
    expect(r.written.sort()).toEqual([STATE_PATH, `${NEXT}/fr/checkout.json`, `${NEXT}/fr/common.json`]);
    expect(await read(fs, `${NEXT}/fr/checkout.json`)).toBe("{}\n");
    expect(await read(fs, `${NEXT}/fr/common.json`)).toBe('{\n  "lit": {\n    "a.b": "salut"\n  }\n}\n');
    expect(await read(fs, "next-i18next.config.js")).toContain("locales: ['en','th']");
  });

  it("addLanguage for paraglide creates a $schema file and updates settings.json", async () => {
    const { fs, s } = await openFx("paraglide");
    expect(s.addLanguage("de")).toEqual({});
    expect(s.data.locales).toEqual(["en", "th", "de"]);
    expect(fs.writes).toEqual([]);
    s.setText(keyId("", "nesting.level1.level2.level3"), "de", "Verschachtelt");
    const r = await s.save();
    expect(r.written).toContain("messages/de.json");
    expect(r.written).toContain("project.inlang/settings.json");
    expect(await read(fs, "messages/de.json")).toBe(
      '{\n\t"$schema": "https://inlang.com/schema/inlang-message-format",\n\t"nesting": {\n\t\t"level1": {\n\t\t\t"level2": {\n\t\t\t\t"level3": "Verschachtelt"\n\t\t\t}\n\t\t}\n\t}\n}\n',
    );
    const settings = await read(fs, "project.inlang/settings.json");
    expect(settings).toContain('"locales": ["en", "th", "de"]');
    expect(settings).toContain('"modules": ["https://cdn.jsdelivr.net');
  });

  it("paraglide: locale listed without a file gets created when a cell is saved", async () => {
    const { fs, s } = await openFx("paraglide");
    await fs.remove(`${R}/messages/th.json`);
    const s2 = await ProjectSession.open(fs, R, (await detectProject(fs, R))!, s.opts);
    expect(s2.files.map((f) => f.relPath)).toEqual(["messages/en.json"]);
    expect(await s2.save()).toEqual({ written: [], deleted: [], stale: [] });
    s2.setText(keyId("", "greeting"), "th", "สวัสดี");
    await s2.save();
    expect(await json(fs, "messages/th.json")).toEqual({
      $schema: "https://inlang.com/schema/inlang-message-format",
      greeting: "สวัสดี",
    });
  });

  it("removeLanguage deletes its files and refuses baseLocale", async () => {
    const { fs, s } = await openFx("next-nested");
    expect(() => s.removeLanguage("en")).toThrow();
    s.markReviewed(c("title"), "th");
    s.removeLanguage("th");
    expect(s.data.locales).toEqual(["en"]);
    expect(s.value(c("title"), "th")).toBeUndefined();
    const r = await s.save();
    expect(r.deleted).toEqual([`${NEXT}/th/common.json`]);
    expect(await fs.exists(`${R}/${NEXT}/th/common.json`)).toBe(false);
    expect(await fs.exists(`${R}/${NEXT}/en/common.json`)).toBe(true);
    expect(await fs.exists(`${R}/${STATE_PATH}`)).toBe(false);
  });

  it("removeLanguage for paraglide updates settings.json", async () => {
    const { fs, s } = await openFx("paraglide");
    s.removeLanguage("th");
    const r = await s.save();
    expect(r.deleted).toEqual(["messages/th.json"]);
    expect(r.written).toEqual(["project.inlang/settings.json"]);
    expect(await read(fs, "project.inlang/settings.json")).toContain('"locales": ["en"]');
  });

  it("addNamespace creates {} files for every locale", async () => {
    const { fs, s } = await openFx("next-nested");
    s.addNamespace("auth");
    expect(s.data.namespaces).toEqual(["auth", "checkout", "common"]);
    expect(() => s.addNamespace("auth")).toThrow();
    const r = await s.save();
    expect(r.written.sort()).toEqual([`${NEXT}/en/auth.json`, `${NEXT}/th/auth.json`]);
    expect(await read(fs, `${NEXT}/en/auth.json`)).toBe("{}\n");
    expect(await read(fs, `${NEXT}/th/auth.json`)).toBe("{}\n");
    s.addKey("auth", "login", "Log in");
    await s.save();
    expect(await read(fs, `${NEXT}/en/auth.json`)).toBe('{\n  "login": "Log in"\n}\n');
  });

  it("addNamespace is not available for paraglide", async () => {
    const { s } = await openFx("paraglide");
    expect(() => s.addNamespace("x")).toThrow();
  });

  it("state.json written only when entries changed", async () => {
    const { fs, s } = await openFx("next-nested");
    s.setText(c("nav.about"), "en", "About us"); // base edit, no other locale has a value
    let r = await s.save();
    expect(r.written).toEqual([`${NEXT}/en/common.json`]);
    s.markReviewed(c("title"), "th");
    r = await s.save();
    expect(r.written).toEqual([STATE_PATH]);
    expect(await read(fs, STATE_PATH)).toMatch(/^\{\n {2}"entries"[\s\S]*\}\n$/);
    expect((await json(fs, STATE_PATH)).entries[c("title")].th.s).toBe("reviewed");
    fs.writes.length = 0;
    r = await s.save();
    expect(fs.writes).toEqual([]);
    // reopening reads the state back
    const s2 = await ProjectSession.open(fs, R, (await detectProject(fs, R))!, s.opts);
    expect(s2.meta(c("title"), "th").status).toBe("reviewed");
    expect(await s2.save()).toEqual({ written: [], deleted: [], stale: [] });
  });

  it("readOnly (malformed) files are never written; edits to their cells throw", async () => {
    const { fs, s } = await openFx("next-broken");
    const broken = await read(fs, `${NEXT}/th/common.json`);
    expect(s.errors.map((e) => e.relPath)).toEqual([`${NEXT}/th/common.json`]);
    expect(() => s.setText(c("title"), "th", "x")).toThrow(/couldn't be read and is read-only/);
    expect(() => s.setComplex(c("title"), "th", { a: 1 })).toThrow(/read-only/);
    s.setText(c("title"), "en", "Hi");
    s.setText(keyId("checkout", "pay"), "th", "จ่าย");
    s.renameKey(c("only_en"), "en_only");
    const r = await s.save();
    expect(r.written.sort()).toEqual([`${NEXT}/en/common.json`, `${NEXT}/th/checkout.json`, STATE_PATH].sort());
    expect(await read(fs, `${NEXT}/th/common.json`)).toBe(broken);
    expect(fs.writes).not.toContain(`${R}/${NEXT}/th/common.json`);
  });

  it("editing base text marks other locales needsReview", async () => {
    const { s } = await openFx("next-nested");
    expect(s.meta(c("title"), "th")).toEqual({ status: "translated", needsReview: false, machine: false });
    s.setText(c("title"), "th", "สวัสดีครับ", { machine: true });
    expect(s.meta(c("title"), "th")).toEqual({ status: "translated", needsReview: false, machine: true });
    s.setText(c("nav.home"), "en", "Start"); // th has a value but no state entry yet
    s.setText(c("title"), "en", "Hi");
    expect(s.meta(c("title"), "th").needsReview).toBe(true);
    expect(s.meta(c("nav.home"), "th").needsReview).toBe(true);
    expect(s.meta(c("title"), "en").needsReview).toBe(false);
    s.markReviewed(c("title"), "th");
    expect(s.meta(c("title"), "th")).toEqual({ status: "reviewed", needsReview: false, machine: false });
    s.setText(c("title"), "th", "อีกครั้ง");
    expect(s.meta(c("title"), "th").status).toBe("translated");
    s.setText(c("title"), "th", "");
    expect(s.meta(c("title"), "th").status).toBe("untranslated");
  });

  it("save returns stale when a file on disk changed since load", async () => {
    const { fs, s } = await openFx("next-nested");
    s.setText(c("title"), "th", "ใหม่");
    s.setText(c("title"), "en", "New");
    const other = '{\n  "title": "someone else"\n}\n';
    await fs.writeTextAtomic(`${R}/${NEXT}/th/common.json`, other);
    fs.writes.length = 0;
    const r = await s.save();
    expect(r.stale).toEqual([`${NEXT}/th/common.json`]);
    expect(r.written).toContain(`${NEXT}/en/common.json`);
    expect(await read(fs, `${NEXT}/th/common.json`)).toBe(other);
    expect(s.dirtyCells()).toEqual([{ id: c("title"), locale: "th" }]);
  });

  it("setComplex stores structured values", async () => {
    const { fs, s } = await openFx("paraglide");
    const id = keyId("", "greeting");
    s.setComplex(id, "th", [{ match: { "x=*": "y" } }]);
    expect(s.value(id, "th")).toEqual({ kind: "complex", raw: [{ match: { "x=*": "y" } }] });
    await s.save();
    expect((await json(fs, "messages/th.json")).greeting).toEqual([{ match: { "x=*": "y" } }]);
  });

  it("warnings report placeholder mismatches and orphans", async () => {
    const { s } = await openFx("next-nested");
    expect(s.warnings(c("orphan"), "th")).toEqual([{ kind: "orphan" }]);
    expect(s.warnings(c("title"), "en")).toEqual([]);
    s.setText(c("items_other"), "th", "{{n}} ชิ้น");
    expect(s.warnings(c("items_other"), "th")).toEqual([
      { kind: "placeholder-missing", names: ["count"] },
      { kind: "placeholder-extra", names: ["n"] },
    ]);
    s.setText(c("items_other"), "th", "{{count}} ชิ้น");
    expect(s.warnings(c("items_other"), "th")).toEqual([]);
  });

  it("stats count applicable cells only", async () => {
    const { s } = await openFx("next-nested");
    const st = s.stats();
    // en: title, nav.home, nav.about, items_one, items_other, lit.a.b, only_en, pay, total (+orphan has no en value)
    expect(st.get("en")).toEqual({ done: 9, total: 10 });
    // th has no "one" category -> items_one not applicable
    expect(st.get("th")).toEqual({ done: 3, total: 9 });
  });

  it("subscribe fires after every mutation and version increments", async () => {
    const { s } = await openFx("next-nested");
    let calls = 0;
    const off = s.subscribe(() => calls++);
    const v = s.version;
    s.setText(c("title"), "th", "x");
    s.markReviewed(c("title"), "th");
    expect(calls).toBe(2);
    expect(s.version).toBe(v + 2);
    off();
    s.setText(c("title"), "th", "y");
    expect(calls).toBe(2);
  });

  it("overlapping saves run one after another; status edits during a save are kept", async () => {
    const { fs, s } = await openFx("next-nested");
    let release!: () => void;
    let stateWriteStarted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (stateWriteStarted = r));
    const write = fs.writeTextAtomic.bind(fs);
    fs.writeTextAtomic = async (p: string, content: string) => {
      if (p.endsWith(STATE_PATH)) {
        stateWriteStarted();
        await gate;
      }
      return write(p, content);
    };
    s.setText(c("title"), "th", "ใหม่");
    const p1 = s.save();
    const p2 = s.save();
    await started;
    s.markReviewed(c("nav.home"), "th");
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.written).toEqual([`${NEXT}/th/common.json`, STATE_PATH]);
    expect(s.meta(c("nav.home"), "th").status).toBe("reviewed");
    // second save ran after the first and picked up the in-flight status edit
    expect(r2).toEqual({ written: [STATE_PATH], deleted: [], stale: [] });
    expect((await json(fs, STATE_PATH)).entries[c("nav.home")].th.s).toBe("reviewed");
    expect(fs.writes.filter((w) => w.endsWith("th/common.json"))).toHaveLength(1);
  });

  it("a status edit during an in-flight save is written by the next save", async () => {
    const { fs, s } = await openFx("next-nested");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const begun = new Promise<void>((r) => (started = r));
    const write = fs.writeTextAtomic.bind(fs);
    fs.writeTextAtomic = async (p: string, content: string) => {
      if (p.endsWith(STATE_PATH)) {
        started();
        await gate;
      }
      return write(p, content);
    };
    s.markReviewed(c("title"), "th");
    const p1 = s.save();
    await begun;
    s.markReviewed(c("nav.home"), "th");
    release();
    await p1;
    expect(s.meta(c("nav.home"), "th").status).toBe("reviewed");
    expect(s.isDirty()).toBe(true);
    const r = await s.save();
    expect(r.written).toEqual([STATE_PATH]);
    expect(Object.keys((await json(fs, STATE_PATH)).entries).sort()).toEqual([c("nav.home"), c("title")].sort());
  });

  it("setProjectSetting marks state dirty and save writes localesPath to state.json", async () => {
    const { fs, s } = await openFx("next-nested");
    expect(s.isDirty()).toBe(false);
    s.setProjectSetting({ localesPath: "public/i18n" });
    expect(s.isDirty()).toBe(true);
    const r = await s.save();
    expect(r.written).toEqual([STATE_PATH]);
    expect((await json(fs, STATE_PATH)).project.localesPath).toBe("public/i18n");
    expect(s.isDirty()).toBe(false);
    s.setProjectSetting({ localesPath: undefined });
    await s.save();
    expect((await json(fs, STATE_PATH)).project.localesPath).toBeUndefined();
  });
});

describe("ProjectSession project id", () => {
  it("setProjectSetting({ id }) marks state touched and persists on save", async () => {
    const { fs, s } = await openFx("next-nested");
    s.setProjectSetting({ id: "p-9" });
    await s.save();
    expect((await json(fs, STATE_PATH)).project.id).toBe("p-9");
  });
});
