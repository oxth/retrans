import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));
const watch = vi.hoisted(() => ({ cb: null as null | ((paths: string[]) => void) }));
vi.mock("../platform/watch", () => ({
  watchDir: vi.fn(async (_root: string, cb: (paths: string[]) => void) => {
    watch.cb = cb;
    return async () => {};
  }),
}));

import { keyId } from "../core/model";
import { detectProject } from "../formats/detect";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");
const ENG = readFileSync(`${FIX}/ENG.tokens.json`, "utf8");
const TH = readFileSync(`${FIX}/TH.tokens.json`, "utf8");
const WARRANTY = keyId("figma-ALL", "ข้อมูลการรับประกัน");
const text = (t: string) => ({ kind: "text", text: t });

/** The ts-locales fixture workspace with the owner's Figma files and modes, saved, then opened in the app. */
async function openWithFigma(modes: Record<string, string> = { ENG: "en", TH: "th" }) {
  const w = await openFixtureWorkspace();
  await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/ENG.tokens.json`, ENG);
  await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/TH.tokens.json`, TH);
  w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes, vars: {}, baseline: {} } });
  await w.session.save();
  useApp.setState({ fs: w.fs });
  const d = (await detectProject(w.fs, w.root))!;
  await useApp.getState().openProject(w.root, d, { baseLocale: d.baseLocale ?? "th", localesPath: d.localesPath });
  return w;
}

beforeEach(async () => {
  await useApp.getState().closeAllTabs();
  watch.cb = null;
});

describe("Figma in the app", () => {
  it("opening a workspace with meta.figma syncs Figma rows", async () => {
    await openWithFigma();
    await vi.waitFor(() => expect(useApp.getState().session!.data.keyOrder).toContain(WARRANTY));
    expect(useApp.getState().session!.value(WARRANTY, "en")).toEqual(text("Warranty info"));
  });

  it("a Figma file change on disk syncs again", async () => {
    const w = await openWithFigma();
    await vi.waitFor(() => expect(useApp.getState().session!.data.keyOrder).toContain(WARRANTY));
    const p = `${w.root}/design/figma/ALL/ENG.tokens.json`;
    await w.fs.writeTextAtomic(p, ENG.replace('"Warranty info"', '"Warranty"'));
    watch.cb!([p]);
    await vi.waitFor(() => expect(useApp.getState().session!.value(WARRANTY, "en")).toEqual(text("Warranty")));
  });

  it("TS and Figma conflicts live side by side and replace only their own origin", async () => {
    await openWithFigma();
    await vi.waitFor(() => expect(useApp.getState().session!.data.keyOrder).toContain(WARRANTY));
    const s = useApp.getState().session!;
    // A real TypeScript conflict: button_save changed here and in the source.
    s.setText(keyId("button", "button_save"), "en", "Keep");
    const btn = `${s.data.root}/src/assets/locales/button.tsx`;
    await s.fs.writeTextAtomic(btn, (await s.fs.readText(btn)).replace("button_save: 'Save',", "button_save: 'Store',"));
    // …and a Figma one.
    s.setText(WARRANTY, "en", "Guarantee");
    const p = `${s.data.root}/design/figma/ALL/ENG.tokens.json`;
    await s.fs.writeTextAtomic(p, ENG.replace('"Warranty info"', '"Warranty details"'));
    watch.cb!([p, btn]);
    await vi.waitFor(() =>
      expect(useApp.getState().conflicts.filter((c) => c.origin === "figma")).toEqual([
        expect.objectContaining({ id: WARRANTY, locale: "en", base: text("Warranty info"), theirs: text("Warranty details") }),
      ]),
    );
    expect(useApp.getState().conflicts.some((c) => c.origin === "source")).toBe(true);
    // Resolving a Figma conflict uses the Figma resolver: the next sync doesn't bring it back.
    const fc = useApp.getState().conflicts.find((c) => c.origin === "figma")!;
    useApp.getState().resolveConflict(fc, "theirs");
    expect(s.value(WARRANTY, "en")).toEqual(text("Warranty details"));
    await useApp.getState().syncSource(s);
    expect(useApp.getState().conflicts.filter((c) => c.origin === "figma")).toEqual([]);
  });

  it("unmapped modes show one error naming them", async () => {
    await openWithFigma({ TH: "th" });
    await vi.waitFor(() =>
      expect(useApp.getState().error).toBe("Figma modes not mapped to a language: ENG — set them in Settings → Figma."),
    );
  });

  it("resolveConflictWith keeps an edited final text", async () => {
    await openWithFigma();
    await vi.waitFor(() => expect(useApp.getState().session!.data.keyOrder).toContain(WARRANTY));
    const s = useApp.getState().session!;
    s.setText(WARRANTY, "en", "Guarantee");
    await s.fs.writeTextAtomic(`${s.data.root}/design/figma/ALL/ENG.tokens.json`, ENG.replace('"Warranty info"', '"Warranty details"'));
    await useApp.getState().syncSource(s);
    const fc = useApp.getState().conflicts.find((c) => c.origin === "figma")!;
    useApp.getState().resolveConflictWith(fc, "Warranty (final)");
    expect(s.value(WARRANTY, "en")).toEqual(text("Warranty (final)"));
    expect(useApp.getState().conflicts.filter((c) => c.origin === "figma")).toEqual([]);
    await useApp.getState().syncSource(s);
    expect(useApp.getState().conflicts.filter((c) => c.origin === "figma")).toEqual([]);
  });

  it("a failing Figma sync still applies the TypeScript sync and says what failed", async () => {
    await openWithFigma();
    await vi.waitFor(() => expect(useApp.getState().session!.data.keyOrder).toContain(WARRANTY));
    const s = useApp.getState().session!;
    s.setText(keyId("button", "button_save"), "en", "Keep");
    const btn = `${s.data.root}/src/assets/locales/button.tsx`;
    await s.fs.writeTextAtomic(btn, (await s.fs.readText(btn)).replace("button_save: 'Save',", "button_save: 'Store',"));
    const real = s.fs.listFiles.bind(s.fs);
    vi.spyOn(s.fs, "listFiles").mockImplementation(async (root, depth) => {
      if (root.includes("design/figma")) throw new Error("disk error");
      return real(root, depth);
    });
    await useApp.getState().syncSource(s).catch(() => {});
    expect(useApp.getState().conflicts.some((c) => c.origin === "source")).toBe(true);
    expect(useApp.getState().error).toBe("Figma sync failed: disk error");
  });
});
