/**
 * A generated TS module that doesn't parse is skipped with a warning. The generator is wrapped
 * so one group's module comes out broken.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../tssource/write", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../tssource/write")>();
  return {
    ...mod,
    newTableModule: (group: string, ...rest: unknown[]) =>
      group === "broken" ? "const = {" : (mod.newTableModule as (...a: unknown[]) => string)(group, ...rest),
  };
});

import { importTsLocales } from "../tssource/import";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { planExport } from "./export";

describe("generated TS files that don't parse", () => {
  it("are skipped with a warning (write-back new group, ts-modules)", async () => {
    const w = await openFixtureWorkspace();
    const s = w.session;
    for (const g of ["broken", "reports"]) {
      s.addNamespace(g);
      s.addKey(g, "title", "หัวข้อ");
    }
    const back = await planExport(s, { kind: "ts-writeback" }, await importTsLocales(w.fs, w.root, w.localesDir, "th"));
    const broken = `${w.root}/${w.localesDir}/broken.ts`;
    expect(back.files.map((f) => f.path)).toEqual([`${w.root}/${w.localesDir}/reports.ts`]);
    expect(back.warnings).toEqual([`Couldn't generate ${broken} — skipped.`]);
    expect(back.snippets.join("\n")).not.toContain("broken");

    const mods = await planExport(s, { kind: "ts-modules", dir: "/out" });
    expect(mods.files.map((f) => f.path)).not.toContain("/out/broken.ts");
    expect(mods.files.map((f) => f.path)).toContain("/out/reports.ts");
    expect(mods.warnings).toEqual(["Couldn't generate /out/broken.ts — skipped."]);
  });
});
