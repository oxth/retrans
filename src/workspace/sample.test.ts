import { describe, expect, it } from "vitest";
import { keyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { MemoryFs } from "../platform/memory-fs";
import { createSampleProject, SAMPLE_NAME } from "./sample";

const open = async () => {
  const fs = new MemoryFs();
  await createSampleProject(fs, "/docs/Retrans/Sample project");
  const d = await detectProject(fs, "/docs/Retrans/Sample project");
  expect(d?.workspace).toBeTruthy();
  return ProjectSession.open(fs, "/docs/Retrans/Sample project", d!, { baseLocale: "en", localesPath: d!.localesPath });
};
const id = (key: string) => keyId("common", key);

describe("createSampleProject", () => {
  it("opens as a workspace in English, French and Japanese", async () => {
    const s = await open();
    expect(s.workspace?.name).toBe(SAMPLE_NAME);
    expect([...s.data.locales].sort()).toEqual(["en", "fr", "ja"]);
  });

  it("has a bit of every status", async () => {
    const s = await open();
    expect(s.meta(id("app_title"), "fr")).toMatchObject({ status: "reviewed", needsReview: false });
    expect(s.meta(id("nav_settings"), "fr")).toMatchObject({ status: "translated", machine: false });
    expect(s.meta(id("button_save"), "ja")).toMatchObject({ status: "translated", machine: true });
    expect(s.meta(id("welcome_message"), "ja")).toMatchObject({ needsReview: true });
    expect(s.meta(id("button_share"), "fr").status).toBe("untranslated");
    expect(s.meta(id("empty_favorites"), "ja").status).toBe("untranslated");
  });
});
