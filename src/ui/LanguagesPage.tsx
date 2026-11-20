import { useRef, useState } from "react";
import { localesSnippet } from "../formats/next-i18next";
import type { ProjectSession } from "../core/session";
import { btnGhost, btnPrimary, Dialog, inputCls, btnSecondary, btnDanger } from "./Dialog";
import { Icon } from "./Icon";
import { LocalePicker } from "./LocalePicker";
import { languageWithCode, localeLabel } from "./locales";
import { parseKeyId } from "../core/model";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function LanguagesPage({ session, stats }: { session: ProjectSession; stats: Map<string, { done: number; total: number }> }) {
  const { baseLocale, format } = session.data;
  const isWs = !!session.workspace;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ns, setNs] = useState("");
  const [error, setError] = useState<string | null>(null);

  const showSnippet = () => {
    setCopied(false);
    // A workspace has no next-i18next config to update.
    setSnippet(format === "next-i18next" && !isWs ? localesSnippet(session.data.locales) : null);
  };
  // Display order: the base stays first; ↑ / ↓ move the others, Sort A–Z goes back to the usual order.
  const shown = session.displayLocales();
  const others = shown.filter((l) => l !== baseLocale);
  const custom = !!session.state.project.localeOrder?.length;
  const place = (l: string, to: number) => {
    const order = others.filter((x) => x !== l);
    order.splice(Math.max(0, Math.min(to, order.length)), 0, l);
    if (order.some((x, k) => x !== others[k])) session.setProjectSetting({ localeOrder: order });
  };
  const move = (l: string, delta: -1 | 1) => {
    const i = others.indexOf(l);
    if (i >= 0 && i + delta >= 0 && i + delta < others.length) place(l, i + delta);
  };

  // Dragging a row by its grip: it follows the pointer, the rows it passes make room, and it lands where it's
  // dropped. Pointer events, like the tab bar (the webview's file-drop handling can swallow HTML drag and drop).
  const [drag, setDrag] = useState<{ l: string; dy: number; from: number; to: number; rects: Array<{ top: number; height: number }> } | null>(null);
  const dragRef = useRef(drag);
  const startDrag = (e: React.PointerEvent<HTMLElement>, l: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const list = e.currentTarget.closest("ul");
    if (!list) return;
    const rects = [...list.querySelectorAll<HTMLElement>("[data-lang-row]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });
    const from = others.indexOf(l);
    const startY = e.clientY;
    dragRef.current = { l, dy: 0, from, to: from, rects };
    setDrag(dragRef.current);
    const moveTo = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dy = ev.clientY - startY;
      const me = d.rects[d.from];
      const middle = me.top + me.height / 2 + dy;
      const to = d.rects.filter((r, k) => k !== d.from && r.top + r.height / 2 < middle).length;
      dragRef.current = { ...d, dy, to };
      setDrag(dragRef.current);
    };
    const end = () => {
      window.removeEventListener("pointermove", moveTo);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (d && d.to !== d.from) place(d.l, d.to);
    };
    window.addEventListener("pointermove", moveTo);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  /** How far a row is drawn from its place during a drag. */
  const offset = (k: number): number => {
    if (!drag || k < 0) return 0;
    if (k === drag.from) return drag.dy;
    const room = drag.rects[drag.from].height;
    if (drag.from < drag.to && k > drag.from && k <= drag.to) return -room;
    if (drag.from > drag.to && k >= drag.to && k < drag.from) return room;
    return 0;
  };

  const addNs = () => {
    try {
      session.addNamespace(ns.trim());
      setNs("");
      setError(null);
    } catch (e) {
      setError(msg(e));
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">The languages in this project and how complete each one is. Their order here is the order of the columns.</p>
        <button className={btnPrimary} onClick={() => setAdding(true)}>Add language</button>
      </div>
      {custom && (
        <p className="mb-2 flex items-center justify-end gap-2 text-xs text-muted">
          Your own order, shared through git.
          <button className="rounded px-1.5 py-0.5 font-medium text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg" onClick={() => session.setProjectSetting({ localeOrder: undefined })}>
            Sort A–Z
          </button>
        </p>
      )}
      <ul className="divide-y divide-line rounded-md border border-line">
        {shown.map((l) => {
          const s = stats.get(l) ?? { done: 0, total: 0 };
          const at = others.indexOf(l);
          const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
          const dy = offset(at);
          const dragged = drag?.l === l;
          return (
            <li
              key={l}
              {...(l !== baseLocale ? { "data-lang-row": "" } : {})}
              style={dy ? { transform: `translateY(${dy}px)` } : undefined}
              className={`relative flex items-center gap-3 bg-surface px-3 py-2 text-sm ${
                dragged ? "z-10 shadow-pop" : drag ? "transition-transform duration-150 motion-reduce:transition-none" : ""
              }`}
            >
              {/* The base is always first; the others move by dragging the grip, or with ↑ / ↓. */}
              <div className="flex w-[4.5rem] shrink-0 items-center gap-0.5">
                {l !== baseLocale && (
                  <>
                    <span
                      aria-hidden="true"
                      title="Drag to reorder"
                      className={`touch-none rounded p-1 text-faint hover:bg-hover hover:text-fg ${dragged ? "cursor-grabbing" : "cursor-grab"}`}
                      onPointerDown={(e) => startDrag(e, l)}
                    >
                      <Icon name="grip" size={14} />
                    </span>
                    <button
                      aria-label={`Move ${localeLabel(l)} (${l}) up`}
                      title="Move up"
                      disabled={at === 0}
                      className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-30"
                      onClick={() => move(l, -1)}
                    >
                      <Icon name="chevronDown" size={14} className="rotate-180" />
                    </button>
                    <button
                      aria-label={`Move ${localeLabel(l)} (${l}) down`}
                      title="Move down"
                      disabled={at === others.length - 1}
                      className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-30"
                      onClick={() => move(l, 1)}
                    >
                      <Icon name="chevronDown" size={14} />
                    </button>
                  </>
                )}
              </div>
              <div className="w-48">
                <span className="font-mono font-semibold">{l}</span>{" "}
                <span className="text-muted">{localeLabel(l)}{l === baseLocale ? " (base)" : ""}</span>
              </div>
              <div className="h-1.5 flex-1 rounded bg-sunken">
                <div className={`h-full rounded ${pct < 80 ? "bg-warn-solid" : "bg-ok-solid"}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="w-24 text-right text-xs text-muted">{s.done} / {s.total} ({pct}%)</div>
              <button
                aria-label={`Remove ${l}`}
                disabled={l === baseLocale}
                title={l === baseLocale ? "The base language can't be removed" : undefined}
                className="rounded px-2 py-1 text-xs text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => setRemoving(l)}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>

      {snippet && (
        <div className="mt-4 rounded-md border border-brand-line bg-brand-soft p-3 text-sm">
          <div className="mb-2 font-medium">Update your next-i18next config:</div>
          <pre data-testid="config-snippet" className="overflow-auto rounded bg-surface p-2 font-mono text-xs">{snippet}</pre>
          <div className="mt-2 flex gap-2">
            <button
              className={btnSecondary}
              onClick={() => {
                navigator.clipboard.writeText(snippet).then(
                  () => setCopied(true),
                  (e) => setError(`Could not copy: ${msg(e)}`),
                );
              }}
            >
              Copy
            </button>
            {copied && <span className="self-center text-xs text-ok">Copied</span>}
            <button className={btnGhost} onClick={() => setSnippet(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {format === "next-i18next" && (
        <GroupsSection session={session} name={ns} onName={(v) => { setNs(v); setError(null); }} onAdd={addNs} onError={setError} />
      )}
      {error && <div role="alert" className="mt-3 text-xs text-danger">{error}</div>}

      {adding && <AddLanguageDialog session={session} onClose={() => setAdding(false)} onAdded={showSnippet} />}
      {removing && (
        <Dialog title="Remove language" onClose={() => setRemoving(null)}>
          <p className="text-sm">
            Remove <span className="font-mono font-semibold">{removing}</span>? Its translation files will be deleted when you save.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setRemoving(null)}>Cancel</button>
            <button
              className={btnDanger}
              onClick={() => {
                try {
                  session.removeLanguage(removing);
                  showSnippet();
                } catch (e) {
                  setError(msg(e));
                }
                setRemoving(null);
              }}
            >
              Remove
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Groups (workspace) / namespaces (next-i18next): what they are, which exist with how many keys,
 * and adding one. The same thing under two names: keys split into one file per language each.
 */
function GroupsSection({
  session,
  name,
  onName,
  onAdd,
  onError,
}: {
  session: ProjectSession;
  name: string;
  onName: (v: string) => void;
  onAdd: () => void;
  onError: (message: string | null) => void;
}) {
  const isWs = !!session.workspace;
  const { namespaces, keyOrder, baseLocale } = session.data;
  const counts = new Map<string, number>();
  for (const id of keyOrder) {
    const g = parseKeyId(id).ns;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const word = isWs ? "group" : "namespace";
  const fileOf = (g: string) => `${session.opts.localesPath}/${baseLocale}/${g}.json`;
  return (
    <section aria-labelledby="groups-heading" className="mt-8">
      <h2 id="groups-heading" className="text-sm font-semibold">{isWs ? "Groups" : "Namespaces"}</h2>
      <p className="mt-1 text-xs leading-5 text-muted">
        {isWs ? (
          <>
            Keys are sorted into groups, like folders. Each group is saved as its own file for every language; for a TypeScript import,
            each source file is one group. Use the Group filter on the Translations page to work on one at a time.
          </>
        ) : (
          <>
            Keys are split into namespaces: one JSON file per language each, such as <span className="font-mono">{fileOf(namespaces[0] ?? "common")}</span>. Your
            app loads a namespace by name, e.g. <span className="font-mono">useTranslation("{namespaces[0] ?? "common"}")</span>. Use the Namespace filter on the
            Translations page to work on one at a time.
          </>
        )}
      </p>
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onAdd();
        }}
      >
        <label htmlFor="new-group" className="mb-1 block text-xs font-medium text-fg-2">Add a {word}</label>
        <div className="flex gap-2">
          <input
            id="new-group"
            aria-label={isWs ? "New group" : "New namespace"}
            className={`${inputCls} font-mono`}
            placeholder="e.g. checkout"
            value={name}
            onChange={(e) => onName(e.target.value)}
          />
          <button type="submit" className={btnSecondary + " whitespace-nowrap"} disabled={!name.trim()}>
            {isWs ? "Add group" : "Add namespace"}
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">
          Creates an empty {word} file for every language when the project is saved. Then add keys to it with Add key.
        </p>
      </form>
      <ul aria-label={isWs ? "Groups" : "Namespaces"} className="mt-3 divide-y divide-line rounded-md border border-line">
        {namespaces.map((g) => (
          <GroupRow
            key={g}
            session={session}
            name={g}
            keys={counts.get(g) ?? 0}
            file={isWs ? null : fileOf(g).replace(`/${baseLocale}/`, "/<language>/")}
            word={word}
            onError={onError}
          />
        ))}
      </ul>
    </section>
  );
}

/** One group: its name, file and key count, with Rename (in place) and Delete (confirmed). */
function GroupRow({
  session,
  name,
  keys,
  file,
  word,
  onError,
}: {
  session: ProjectSession;
  name: string;
  keys: number;
  file: string | null;
  word: "group" | "namespace";
  onError: (message: string | null) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const locked = session.namespaceLockReason(name);
  const isWs = word === "group";
  const run = (fn: () => void) => {
    try {
      fn();
      onError(null);
      return true;
    } catch (e) {
      onError(msg(e));
      return false;
    }
  };
  const count = keys === 0 ? "No keys yet" : `${keys} key${keys === 1 ? "" : "s"}`;
  const action = "rounded px-2 py-1 text-xs";

  if (renaming !== null) {
    const next = renaming.trim();
    const save = () => next && next !== name && run(() => session.renameNamespace(name, next)) && setRenaming(null);
    return (
      <li className="space-y-2 px-3 py-2.5 text-sm">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            aria-label={`New name for ${name}`}
            className={`${inputCls} font-mono`}
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(null);
              }
            }}
          />
          <button type="submit" className={btnPrimary} disabled={!next || next === name}>Rename</button>
          <button type="button" className={btnGhost} onClick={() => setRenaming(null)}>Cancel</button>
        </form>
        <p className="text-xs leading-5 text-muted">
          {isWs ? (
            <>Its file is renamed for every language when the project saves.</>
          ) : (
            <>
              Its file is renamed for every language when the project saves. Update{" "}
              <span className="font-mono">useTranslation("{name}")</span> and any <span className="font-mono">{name}:</span> key prefixes
              in your code to the new name, or those texts stop loading.
            </>
          )}
        </p>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          <span className="font-mono font-semibold">{name}</span>
          {file && <span className="ml-2 font-mono text-xs text-muted">{file}</span>}
        </span>
        {locked && (
          <span className="mt-0.5 flex items-start gap-1 text-xs leading-5 text-muted">
            <Icon name="lock" size={12} className="mt-1" />
            <span>{locked}</span>
          </span>
        )}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted">{count}</span>
      {!locked && (
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label={`Rename ${name}`}
            className={`${action} text-fg-2 hover:bg-hover hover:text-fg`}
            onClick={() => setRenaming(name)}
          >
            Rename
          </button>
          <button
            type="button"
            aria-label={`Delete ${name}`}
            className={`${action} text-danger hover:bg-danger-soft`}
            onClick={() => setDeleting(true)}
          >
            Delete
          </button>
        </span>
      )}
      {deleting && (
        <Dialog title={`Delete ${word}`} onClose={() => setDeleting(false)}>
          <p className="text-sm">
            Delete <span className="font-mono font-semibold">{name}</span>
            {keys > 0 ? <> and its {count}, with their translations in every language</> : null}? Its file is deleted for every language when the
            project saves.
          </p>
          <p className="mt-2 text-xs text-muted">This can't be undone with ⌘Z / Ctrl+Z. Git, if you use it, still has the files.</p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setDeleting(false)}>Cancel</button>
            <button
              className={btnDanger}
              onClick={() => {
                run(() => session.deleteNamespace(name));
                setDeleting(false);
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}
    </li>
  );
}

/**
 * Add language. `showConfig`: opened away from the Languages page (the toolbar), so the dialog itself shows
 * the next-i18next config line to update, instead of the page's snippet panel.
 */
export function AddLanguageDialog({ session, onClose, onAdded, showConfig }: {
  session: ProjectSession; onClose: () => void; onAdded: () => void; showConfig?: boolean;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ code: string; snippet: string } | null>(null);
  const [copied, setCopied] = useState(false);
  if (added) {
    return (
      <Dialog title="Add language" onClose={onClose}>
        <p role="status" className="text-sm">
          Added {languageWithCode(added.code)}. Also add it to the locales list in your next-i18next config:
        </p>
        <pre className="mt-2 overflow-auto rounded-md bg-panel p-3 text-xs">{added.snippet}</pre>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className={btnSecondary}
            onClick={() => void navigator.clipboard.writeText(added.snippet).then(() => setCopied(true), () => setCopied(false))}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button className={btnPrimary} onClick={onClose}>Done</button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Add language" onClose={onClose}>
      <LocalePicker label="Language" selected={sel} exclude={session.data.locales} onChange={setSel} />
      {error && <div role="alert" className="mt-2 text-xs text-danger">{error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button
          className={btnPrimary}
          disabled={!sel.length}
          onClick={() => {
            try {
              const r = session.addLanguage(sel[0]);
              onAdded();
              if (showConfig && r.configSnippet) setAdded({ code: sel[0], snippet: r.configSnippet });
              else onClose();
            } catch (e) {
              setError(msg(e));
            }
          }}
        >
          Add
        </button>
      </div>
    </Dialog>
  );
}
