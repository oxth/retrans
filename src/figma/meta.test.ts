import { describe, expect, it } from "vitest";
import { keyId } from "../core/model";
import type { WorkspaceMeta } from "../workspace/meta";
import { figmaGroupName, figmaGroups, isUnmappedFigmaRow, varIdOfRow } from "./meta";

const meta = (): WorkspaceMeta => ({
  retransWorkspace: 1,
  name: "Demo",
  drafts: {},
  markers: {},
  removedInSource: [],
  duplicates: [],
  emptyKeys: [],
  renames: {},
  deletedKeys: [],
  figma: {
    dir: "design/figma",
    modes: { ENG: "en", TH: "th" },
    vars: {
      "VariableID:1": { collection: "", name: "Button.Save", row: keyId("figma", "Button.Save") },
      "VariableID:2": { collection: "Brand A", name: "Dialog.Close", row: keyId("figma-Brand_A", "Dialog.Close") },
    },
    baseline: {},
  },
});

describe("figma meta helpers", () => {
  it("builds figma group names", () => {
    expect(figmaGroupName("")).toBe("figma");
    expect(figmaGroupName("ALL")).toBe("figma-ALL");
    expect(figmaGroupName("Brand A")).toBe("figma-Brand_A");
  });

  it("lists figma groups and finds a row's variable id", () => {
    const m = meta();
    expect([...figmaGroups(m)]).toEqual(["figma", "figma-Brand_A"]);
    expect(isUnmappedFigmaRow(m, keyId("figma-Brand_A", "Dialog.Close"))).toBe(true);
    expect(isUnmappedFigmaRow(m, keyId("common", "home.title"))).toBe(false);
    expect(varIdOfRow(m, keyId("figma", "Button.Save"))).toBe("VariableID:1");
    expect(varIdOfRow(m, keyId("common", "home.title"))).toBeNull();
  });
});
