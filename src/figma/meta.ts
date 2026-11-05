import { type KeyId, parseKeyId } from "../core/model";
import type { WorkspaceMeta } from "../workspace/meta";

/** Collection "" is the root Figma group. */
export function figmaGroupName(collection: string): string {
  if (collection === "") return "figma";
  return `figma-${collection.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Every group currently used by Figma variable links. */
export function figmaGroups(meta: WorkspaceMeta): Set<string> {
  const out = new Set<string>();
  if (!meta.figma) return out;
  for (const link of Object.values(meta.figma.vars)) out.add(figmaGroupName(link.collection));
  return out;
}

/** A row with a key in any current Figma group is still unmapped. */
export function isUnmappedFigmaRow(meta: WorkspaceMeta, id: KeyId): boolean {
  return figmaGroups(meta).has(parseKeyId(id).ns);
}

/** The Figma variable id linked to this row, if any. */
export function varIdOfRow(meta: WorkspaceMeta, id: KeyId): string | null {
  if (!meta.figma) return null;
  for (const [varId, link] of Object.entries(meta.figma.vars)) if (link.row === id) return varId;
  return null;
}
