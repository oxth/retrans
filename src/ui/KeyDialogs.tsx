import { useState } from "react";
import { keyId, type KeyId, parseKeyId } from "../core/model";
import type { Row } from "../core/rows";
import { pluralCategories } from "../core/plurals";
import { KeyError, type ProjectSession } from "../core/session";
import { btnGhost, btnPrimary, Dialog, inputCls, btnDanger } from "./Dialog";
import { Segmented } from "./settings-ui";

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

const FORM_NAME: Record<string, string> = { zero: "Zero", one: "One", two: "Two", few: "Few", many: "Many", other: "Other" };

/** A few whole numbers that use each plural form in `locale`, e.g. one → "1", other → "0, 2, 3, …". */
function formExamples(locale: string): Record<string, string> {
  const out: Record<string, number[]> = {};
  let rules: Intl.PluralRules;
  try {
    rules = new Intl.PluralRules(locale);
  } catch {
    return {};
  }
  for (let n = 0; n <= 200; n++) {
    const c = rules.select(n);
    if ((out[c] ??= []).length < 4) out[c].push(n);
  }
  return Object.fromEntries(Object.entries(out).map(([c, ns]) => [c, ns.length > 3 ? `${ns.slice(0, 3).join(", ")}, …` : ns.join(", ")]));
}

export function AddKeyDialog({ session, onClose }: { session: ProjectSession; onClose: () => void }) {
  const { namespaces, format, baseLocale } = session.data;
  const [ns, setNs] = useState(namespaces[0] ?? "");
  const nsLabel = session.workspace ? "Group" : "Namespace";
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  const [plural, setPlural] = useState(false);
  const [forms, setForms] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const categories = pluralCategories(baseLocale);
  const examples = formExamples(baseLocale);
  const canPlural = format === "next-i18next";
  const name = key.trim() || "key";
  // Switching keeps what was typed: the single text becomes the Other form, and back.
  const setKind = (next: "single" | "plural") => {
    setError(null);
    if (next === "plural" && !plural) {
      setForms((f) => ({ ...f, other: f.other || text }));
      setPlural(true);
    } else if (next === "single" && plural) {
      setText((t) => forms.other || t);
      setPlural(false);
    }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (plural && categories.some((c) => !forms[c]?.trim())) {
        setError(`Fill in every form (${categories.map((c) => FORM_NAME[c] ?? c).join(", ")}).`);
        return;
      }
      if (plural) session.addKey(ns, key.trim(), forms.other ?? "", { plural, forms });
      else session.addKey(ns, key.trim(), text, { plural });
      onClose();
    } catch (err) {
      setError(keyMessage(err));
    }
  };
  return (
    <Dialog title="Add key" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <div className={canPlural ? "grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3" : ""}>
          {canPlural && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-fg-2">{nsLabel}</span>
              <select aria-label={nsLabel} className={inputCls} value={ns} onChange={(e) => setNs(e.target.value)}>
                {namespaces.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-fg-2">Key</span>
            <input
              aria-label="Key"
              autoFocus
              placeholder="e.g. cart.items"
              className={`${inputCls} font-mono`}
              value={key}
              onChange={(e) => { setKey(e.target.value); setError(null); }}
            />
          </label>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-fg-2">Text ({baseLocale})</span>
            {canPlural && (
              <Segmented
                label="Text type"
                value={plural ? "plural" : "single"}
                options={[
                  { value: "single", label: "Single" },
                  { value: "plural", label: "Plural" },
                ]}
                onChange={setKind}
              />
            )}
          </div>
          {plural ? (
            <>
              <div className="divide-y divide-line rounded-md border border-line">
                {categories.map((c, i) => (
                  <label key={c} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-28 shrink-0 text-xs">
                      <span className="font-medium text-fg-2">{FORM_NAME[c] ?? c}</span>
                      {examples[c] && <span className="text-muted"> · {examples[c]}</span>}
                    </span>
                    <input
                      aria-label={`Base text, ${FORM_NAME[c] ?? c} form`}
                      autoFocus={i === 0}
                      className={inputCls}
                      placeholder={c === "one" ? "{{count}} item" : c === "other" ? "{{count}} items" : "{{count}} …"}
                      value={forms[c] ?? ""}
                      onChange={(e) => { setForms({ ...forms, [c]: e.target.value }); setError(null); }}
                    />
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted">
                Use <span className="font-mono">{"{{count}}"}</span> for the number · <span className="font-mono">t("{name}", {"{ count }"})</span> picks the
                form. Other languages get the forms they need.
              </p>
            </>
          ) : (
            <>
              <textarea aria-label="Base text" rows={2} className={inputCls} value={text} onChange={(e) => { setText(e.target.value); setError(null); }} />
              {canPlural && <p className="mt-1.5 text-xs text-muted">Choose Plural for text that changes with a number, like "1 item" and "5 items".</p>}
            </>
          )}
        </div>

        {error && <div role="alert" className="text-xs text-danger">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
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
          <span className="mb-1 block text-xs text-muted">
            New key{row.pluralGroup ? " (renames all plural forms)" : ""}
          </span>
          <input aria-label="New key" autoFocus className={`${inputCls} font-mono`} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} />
        </label>
        {error && <div role="alert" className="text-xs text-danger">{error}</div>}
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
      {error && <div role="alert" className="mt-2 text-xs text-danger">{error}</div>}
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={btnGhost}>Cancel</button>
        <button
          className={btnDanger}
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
