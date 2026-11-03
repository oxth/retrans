/** Workspace row actions used by the editor (drafts, removed-in-source, duplicate keys). */
import { type KeyId, keyId, parseKeyId } from "../core/model";
import type { ProjectSession } from "../core/session";

/** Accepting a draft is a normal hand edit (status Translated, not machine); the draft is then gone. */
export function acceptDraft(session: ProjectSession, id: KeyId, locale: string): void {
  const meta = session.workspace;
  const text = meta?.drafts[id]?.[locale];
  if (!meta || text === undefined) return;
  session.batch(() => {
    session.setText(id, locale, text, { machine: false });
    const drafts = structuredClone(meta.drafts);
    delete drafts[id][locale];
    if (Object.keys(drafts[id]).length === 0) delete drafts[id];
    session.setWorkspaceMeta({ drafts });
  });
}

/** "Keep" on a key removed in source: it stays in the workspace, no longer marked. */
export function keepKey(session: ProjectSession, id: KeyId): void {
  const meta = session.workspace;
  if (!meta?.removedInSource.includes(id)) return;
  session.setWorkspaceMeta({ removedInSource: meta.removedInSource.filter((x) => x !== id) });
}

/** For a key in meta.duplicates: the other groups that also have it (rows of this workspace). */
export function duplicateGroups(session: ProjectSession, id: KeyId): string[] {
  const { ns, key } = parseKeyId(id);
  if (!session.workspace?.duplicates.includes(key)) return [];
  return session.data.namespaces.filter((g) => g !== ns && session.data.keyOrder.includes(keyId(g, key)));
}
