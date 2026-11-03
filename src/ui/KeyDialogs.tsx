import { useState } from "react";
import { keyId, type KeyId, parseKeyId } from "../core/model";
import type { Row } from "../core/rows";
import { KeyError, type ProjectSession } from "../core/session";
import { btnGhost, btnPrimary, Dialog, inputCls } from "./Dialog";

function keyMessage(e: unknown): string {
  if (e instanceof KeyError) {
    if (e.code === "exists") return "Key already exists";
    if (e.code === "prefix-collision") {
      const m = /collides with "(.*)"$/.exec(e.message);
      return `Conflicts with existing key ${m ? m[1] : ""}`.trim();
    }
  }
  return e instanceof Error ? e.message : String(e);
}

export function AddKeyDialog({ session, onClose }: { session: ProjectSession; onClose: () => void }) {
  const { namespaces, format, baseLocale } = session.data;
  const [ns, setNs] = useState(namespaces[0] ?? "");
  const nsLabel = session.workspace ? "Group" : "Namespace";
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  const [plural, setPlural] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      session.addKey(ns, key.trim(), text, { plural });
      onClose();
    } catch (err) {
      setError(keyMessage(err));
    }
  };
  return (
    <Dialog title="Add key" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        {format === "next-i18next" && (
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">{nsLabel}</span>
            <select aria-label={nsLabel} className={inputCls} value={ns} onChange={(e) => setNs(e.target.value)}>
              {namespaces.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Key</span>
          <input aria-label="Key" autoFocus className={`${inputCls} font-mono`} value={key} onChange={(e) => { setKey(e.target.value); setError(null); }} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">Base text ({baseLocale})</span>
          <textarea aria-label="Base text" rows={2} className={inputCls} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {format === "next-i18next" && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={plural} onChange={(e) => setPlural(e.target.checked)} />
            Plural
          </label>
        )}
        {error && <div role="alert" className="text-xs text-red-600">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
          <button type="submit" className={btnPrimary}>Add</button>
        </div>
      </form>
    </Dialog>
  );
}

/** For a plural row the whole group is acted on, via the group's `_other` key. */
export function targetId(session: ProjectSession, row: Row): KeyId {
  if (!row.pluralGroup) return row.id;
  const other = keyId(row.ns, `${row.pluralGroup}_other`);
  return session.data.keyOrder.includes(other) ? other : row.id;
}

export function RenameKeyDialog({ session, row, onClose }: { session: ProjectSession; row: Row; onClose: () => void }) {
  const [name, setName] = useState(row.pluralGroup ?? row.key);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = name.trim();
    try {
      if (row.pluralGroup) {
        // Renames every variant of the group at once; collisions are validated for all before anything changes.
        session.renameKey(targetId(session, row), `${next}_other`);
      } else {
        session.renameKey(row.id, next);
      }
      onClose();
    } catch (err) {
      setError(keyMessage(err));
    }
  };
  return (
    <Dialog title="Rename key" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs text-gray-500">
            New key{row.pluralGroup ? " (renames all plural forms)" : ""}
          </span>
          <input aria-label="New key" autoFocus className={`${inputCls} font-mono`} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} />
        </label>
        {error && <div role="alert" className="text-xs text-red-600">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
          <button type="submit" className={btnPrimary}>Rename</button>
        </div>
      </form>
    </Dialog>
  );
}

export function DeleteKeyDialog({ session, row, onClose }: { session: ProjectSession; row: Row; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const id = targetId(session, row);
  const { key } = parseKeyId(id);
  const count = session.data.locales.filter((l) => session.value(id, l)).length;
  const name = row.pluralGroup ? `${row.pluralGroup} (all plural forms)` : key;
  return (
    <Dialog title="Delete key" onClose={onClose}>
      <p className="text-sm">
        Delete <span className="font-mono font-semibold">{name}</span>? It has a value in {count} {count === 1 ? "language" : "languages"}, which will be removed.
      </p>
      {error && <div role="alert" className="mt-2 text-xs text-red-600">{error}</div>}
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={btnGhost}>Cancel</button>
        <button
          className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white"
          onClick={() => {
            try {
              session.deleteKey(id);
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Delete
        </button>
      </div>
    </Dialog>
  );
}
