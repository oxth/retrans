import { useMemo, useState } from "react";
import { keyId, type KeyId, type MessageValue, parseKeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { linkToKey, setCodeKey, suggestLinks } from "../figma/link";
import { figmaGroups } from "../figma/meta";
import { btnGhost, btnPrimary, Dialog, inputCls } from "./Dialog";
import { type UiConflict, useApp } from "./store";

const textOf = (v: MessageValue | undefined) => (v?.kind === "text" ? v.text : "");

/** A code-key guess from the string's text: lowercase, non-alphanumerics → "_", at most 40 characters. */
export function slugKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
}

function codeGroups(session: ProjectSession): string[] {
  const figma = session.workspace ? figmaGroups(session.workspace) : new Set<string>();
  return session.data.namespaces.filter((ns) => !figma.has(ns));
}

/** Set code key…: moves a Figma string into a code group under a key the code can use. */
export function SetCodeKeyDialog({ session, row, onClose }: { session: ProjectSession; row: KeyId; onClose: () => void }) {
  const groups = codeGroups(session);
  const guess = slugKey(textOf(session.value(row, "en")) || textOf(session.value(row, session.data.baseLocale)));
  const [group, setGroup] = useState(groups[0] ?? "");
  const [key, setKey] = useState(guess);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    try {
      setCodeKey(session, row, keyId(group, key.trim()));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Dialog title="Set code key" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-gray-600">Figma name: <span className="font-mono">{parseKeyId(row).key}</span> (stays as it is in Figma)</p>
        <label className="block">
          Group
          <select aria-label="Group" className={inputCls} value={group} onChange={(e) => setGroup(e.target.value)}>
            {groups.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </label>
        <label className="block">
          Code key
          <input aria-label="Code key" className={inputCls} value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} disabled={!group || !key.trim()} onClick={save}>Save</button>
        </div>
      </div>
    </Dialog>
  );
}

/** Link to code key…: makes a Figma string and an existing code key one translation. */
export function LinkDialog({ session, row, onClose }: { session: ProjectSession; row: KeyId; onClose: () => void }) {
  const base = session.data.baseLocale;
  const suggestions = useMemo(() => suggestLinks(session, row), [session, row]);
  const [search, setSearch] = useState("");
  const [pick, setPick] = useState<KeyId | null>(suggestions[0] ?? null);
  const [error, setError] = useState<string | null>(null);
  const groups = new Set(codeGroups(session));
  const q = search.trim().toLowerCase();
  const matches = q
    ? session.data.keyOrder
        .filter((id) => groups.has(parseKeyId(id).ns))
        .filter((id) => id.toLowerCase().includes(q) || textOf(session.value(id, base)).toLowerCase().includes(q))
        .slice(0, 20)
    : suggestions;
  const link = () => {
    if (!pick) return;
    try {
      const conflicts = linkToKey(session, row, pick);
      if (conflicts.length) {
        const fresh: UiConflict[] = conflicts.map((c) => ({ ...c, origin: "figma" }));
        useApp.setState((s) => ({ conflicts: [...s.conflicts, ...fresh] }));
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Dialog title="Link to code key" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-gray-600">{textOf(session.value(row, base))}</p>
        <input aria-label="Search keys" className={inputCls} placeholder="Search keys or text…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {!q && suggestions.length === 0 && <p className="text-gray-500">No similar keys found. Search for one.</p>}
        <div role="radiogroup" aria-label="Code keys" className="max-h-60 space-y-1 overflow-auto">
          {matches.map((id) => (
            <label key={id} className="flex items-start gap-2">
              <input type="radio" name="link-target" checked={pick === id} onChange={() => setPick(id)} />
              <span>
                <span className="font-mono">{id}</span>
                <span className="block text-gray-500">{textOf(session.value(id, base))}</span>
              </span>
            </label>
          ))}
        </div>
        {error && <p role="alert" className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} disabled={!pick} onClick={link}>Link</button>
        </div>
      </div>
    </Dialog>
  );
}
