import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadFixtureDir, type MemoryFs } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { keyId } from "../core/model";
import { parseState, STATE_PATH } from "../core/state-file";
import { ProjectSession } from "../core/session";
import { buildPackage } from "../package/build";
import { extractPackage } from "../package/extract";
import { applyImport, diffPackage, openIncoming } from "../package/diff";
import { MANIFEST_PATH, parseManifest } from "../package/manifest";

const DEV = "/project";
const TR = "/translator/pkg";

async function open(fs: MemoryFs, root: string) {
  const d = (await detectProject(fs, root))!;
  return ProjectSession.open(fs, root, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
}

describe("e2e translator package round trip", () => {
  it("export, translate, re-export, import with a conflict", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "fixtures", "next-nested"));
    const original = fs.snapshot();
    const enPaths = Object.keys(original).filter((p) => p.includes("/locales/en/"));
    expect(enPaths).toHaveLength(2);

    const home = keyId("common", "nav.home");
    const about = keyId("common", "nav.about");
    const onlyEn = keyId("common", "only_en");
    const title = keyId("common", "title");

    // 1. developer exports
    const dev = await open(fs, DEV);
    dev.setProjectSetting({ id: "proj-1" });
    await dev.save();
    const pkg = await buildPackage(dev, { locales: ["th"], now: new Date("2026-11-02T00:00:00Z") });
    const baseline = parseManifest(pkg.find((e) => e.path === MANIFEST_PATH)!.text)!;
    expect(baseline.sourceProjectId).toBe("proj-1");

    // 2. translator extracts and opens it
    await extractPackage(fs, pkg, TR);
    const tr = await open(fs, TR);
    expect(tr.data.baseLocale).toBe("en");

    // 3. translator fills two missing cells (one reviewed), edits a third, saves
    expect(tr.value(about, "th")).toBeUndefined();
    expect(tr.value(onlyEn, "th")).toBeUndefined();
    tr.setText(about, "th", "เกี่ยวกับ");
    tr.markReviewed(about, "th");
    tr.setText(onlyEn, "th", "อังกฤษเท่านั้น");
    tr.setText(title, "th", "สวัสดีจากนักแปล");
    await tr.save();

    // 4. re-export keeps the original baseline
    const back = await buildPackage(tr, { locales: ["th"], now: new Date("2026-11-03T00:00:00Z") });
    const backManifest = parseManifest(back.find((e) => e.path === MANIFEST_PATH)!.text)!;
    expect(backManifest.baseline).toEqual(baseline.baseline);
    expect(backManifest.sourceProjectId).toBe("proj-1");

    // 5. developer meanwhile edits another th cell and the cell the translator changed
    dev.setText(home, "th", "หน้าหลัก");
    dev.setText(title, "th", "สวัสดีจากนักพัฒนา");
    await dev.save();

    // 6. diff
    const inc = await openIncoming(back, dev.data.baseLocale);
    expect(inc.baseKnown).toBe(true);
    const diff = diffPackage(dev, inc.session, inc.manifest);
    expect(diff.otherProject).toBe(false);
    const by = (k: string) => diff.items.filter((i) => i.kind === k).map((i) => `${i.id}|${i.locale}`).sort();
    expect(by("new")).toEqual([`${about}|th`, `${onlyEn}|th`].sort());
    expect(by("status")).toEqual([]);
    expect(by("conflict")).toEqual([`${title}|th`]);
    expect(diff.items).toHaveLength(3);
    expect(diff.items.find((i) => i.id === about)!.theirsEntry?.s).toBe("reviewed");

    // 7. apply, conflict picked theirs
    const picks = new Map<string, "mine" | "theirs">([[`${title}|th`, "theirs"]]);
    expect(applyImport(dev, diff, picks)).toBe(3);
    await dev.save();

    // 8. results
    const after = fs.snapshot();
    const th = JSON.parse(after[`${DEV}/public/locales/th/common.json`]);
    expect(th.nav.about).toBe("เกี่ยวกับ");
    expect(th.only_en).toBe("อังกฤษเท่านั้น");
    expect(th.title).toBe("สวัสดีจากนักแปล");
    expect(th.nav.home).toBe("หน้าหลัก"); // developer's other edit survives
    const { state, error } = parseState(after[`${DEV}/${STATE_PATH}`]);
    expect(error).toBeUndefined();
    expect(state.entries[about].th.s).toBe("reviewed");
    for (const p of enPaths) expect(after[p]).toBe(original[p]);
  });
});
