import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { KeyId } from "../core/model";
import { buildRows, nextMissing, type Row } from "../core/rows";
import { getViewMode, setViewMode } from "../platform/prefs";
import type { EditActions } from "./Cell";
import { ListView, type RowAction } from "./ListView";
import { LinkDialog, SetCodeKeyDialog } from "./FigmaKeyDialogs";
import { AddKeyDialog, DeleteKeyDialog, RenameKeyDialog } from "./KeyDialogs";
import { ConflictDialog } from "./ConflictDialog";
import { ExportDialog } from "./ExportDialog";
import { LanguagesPage } from "./LanguagesPage";
import { LoadErrors } from "./LoadErrors";
import { SharePage } from "./SharePage";
import { SettingsPage } from "./SettingsPage";
import { type Page, PAGE_LABEL, Sidebar } from "./Sidebar";
import { btnPrimary, btnSecondary } from "./Dialog";
import { Icon } from "./Icon";
import { SOURCE_INVALID_MESSAGE, SOURCE_MISSING_MESSAGE, useApp, useSessionVersion } from "./store";
import { keepKey } from "../workspace/actions";
import { TableView } from "./TableView";
import { activeTranslator, useMt } from "./mt-store";
import { Toolbar } from "./Toolbar";
import { TranslateMissingDialog } from "./TranslateMissingDialog";
import { isTextField } from "./edit-commands";


export function AppShell() {
  const version = useSessionVersion();
  const session = useApp((s) => s.session);
  const error = useApp((s) => s.error);
  const sourceMissing = useApp((s) => s.sourceMissing);
  const requestClose = useApp((s) => s.requestClose);
  // Page, filters and hidden languages belong to the tab: they survive switching tabs.
  const page = useApp((s) => s.ui.page);
  const filter = useApp((s) => s.ui.filter);
  const hiddenList = useApp((s) => s.ui.hidden);
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const setUi = useApp((s) => s.setUi);
  const setPage = useCallback((p: Page) => setUi({ page: p }), [setUi]);
  const [viewMode, setMode] = useState<"list" | "table">("list");
  const root = session?.data.root;
  const [dialog, setDialog] = useState<
    { kind: "add" | "translate" | "export" } | { kind: "rename" | "delete" | "code-key" | "link"; row: Row } | null
  >(null);
  // Translate missing appears once any provider is ready (a local model, or a cloud/agent provider set up).
  const hasModel = useMt((s) => !!session && activeTranslator(s, session.data.format, session.state.project.mtProvider) !== null);
  const dirty = !!session && (version >= 0 ? session.isDirty() : false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      // Undo / redo: a focused text field keeps its own (the browser handles it there).
      if (k === "z" || k === "y") {
        if (isTextField(document.activeElement) || document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        if (k === "y" || e.shiftKey) useApp.getState().redo();
        else useApp.getState().undo();
        return;
      }
      if (e.shiftKey || k !== "s") return;
      e.preventDefault();
      // Not while a modal (conflicts, unsaved-changes prompt, key dialogs) is up.
      if (document.querySelector('[role="dialog"]')) return;
      // Flush an open editor first (blur commits it).
      const a = document.activeElement;
      if (a instanceof HTMLTextAreaElement) a.blur();
      void useApp.getState().save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!root) return;
    let live = true;
    getViewMode(root).then(
      (m) => live && setMode(m),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [root]);

  // Menu requests for this screen (File → Export…, View → List / Table, Import Figma Files…).
  const uiRequest = useApp((s) => s.uiRequest);
  useEffect(() => {
    if (!uiRequest) return;
    const { kind } = uiRequest;
    if (kind === "export") setDialog({ kind: "export" });
    else if (kind === "view-list" || kind === "view-table") onViewModeRef.current(kind === "view-list" ? "list" : "table");
    else if (kind === "import-figma") setUi({ page: "settings" });
    else return; // a start-screen request
    useApp.getState().clearUiRequest();
  }, [uiRequest, setUi]);

  const onViewMode = useCallback(
    (m: "list" | "table") => {
      setMode(m);
      if (root) void setViewMode(root, m).catch(() => {});
    },
    [root],
  );
  const onViewModeRef = useRef(onViewMode);
  onViewModeRef.current = onViewMode;

  const deferredSearch = useDeferredValue(filter.search);
  const targets = useMemo(
    () => (session ? session.data.locales.filter((l) => l !== session.data.baseLocale) : []),
    [session, version],
  );
  const visible = useMemo(() => targets.filter((l) => !hidden.has(l)), [targets, hidden]);
  const rowFilter = useMemo(() => ({ ...filter, search: deferredSearch, locales: visible }), [filter, deferredSearch, visible]);
  const rows = useMemo(() => (session ? buildRows(session, rowFilter) : []), [session, version, rowFilter]);
  const missingCount = useMemo(
    () => (session ? buildRows(session, { ...rowFilter, missing: true }).length : 0),
    [session, version, rowFilter],
  );

  const stats = useMemo(() => (session ? session.stats() : new Map<string, { done: number; total: number }>()), [session, version]);

  // Only one editor is open at a time; its position lives here so Tab can move between rows.
  const [editing, setEditing] = useState<{ id: KeyId; locale: string } | null>(null);
  const live = useRef({ session, rows, visible });
  live.current = { session, rows, visible };
  useEffect(() => setEditing(null), [session]);

  const actions = useMemo<EditActions>(
    () => ({
      start: (id, locale) => setEditing({ id, locale }),
      cancel: () => setEditing(null),
      commit: (id, locale, text) => {
        const s = live.current.session;
        if (!s) return;
        const cur = s.value(id, locale);
        if (cur?.kind === "complex") {
          const raw = JSON.parse(text);
          if (JSON.stringify(raw) !== JSON.stringify(cur.raw)) s.setComplex(id, locale, raw);
        } else {
          const prev = cur?.kind === "text" ? cur.text : "";
          if (text !== prev) s.setText(id, locale, text === "" ? null : text);
        }
        // Only close if this cell is still the one being edited (blur/unmount flushes may arrive after a switch).
        setEditing((cur) => (cur && cur.id === id && cur.locale === locale ? null : cur));
      },
      commitMachine: (id, locale, text) => {
        live.current.session?.setText(id, locale, text, { machine: true });
        setEditing((cur) => (cur && cur.id === id && cur.locale === locale ? null : cur));
      },
      next: (id, locale) => {
        const { session: s, rows: r, visible: v } = live.current;
        const n = s ? nextMissing(s, r, { id, locale }, v) : null;
        setEditing(n);
        return !!n;
      },
      review: (id, locale) => live.current.session?.markReviewed(id, locale),
      error: (message) => useApp.setState({ error: message }),
    }),
    [],
  );

  const onRowAction = useCallback((row: Row, kind: RowAction) => {
    if (kind === "keep") {
      const s = live.current.session;
      if (s) keepKey(s, row.id);
    } else setDialog({ kind, row });
  }, []);

  if (!session) return null;
  const toggleLocale = (l: string) =>
    setUi({ hidden: hiddenList.includes(l) ? hiddenList.filter((x) => x !== l) : [...hiddenList, l] });

  return (
    <div className="flex min-h-0 flex-1 bg-surface text-fg">
      <Sidebar session={session} stats={stats} page={page} onPage={setPage} onClose={() => void requestClose("project")} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <h1 className="text-sm font-semibold">{PAGE_LABEL[page]}</h1>
          <span aria-live="polite" className="contents">
          {dirty ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn">
              <span className="h-1.5 w-1.5 rounded-full bg-warn-solid" aria-hidden="true" />
              Unsaved
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Icon name="check" size={13} />
              All changes saved
            </span>
          )}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {session.workspace && (
              <button className={btnSecondary} onClick={() => setDialog({ kind: "export" })}>
                <Icon name="upload" size={15} />
                Export…
              </button>
            )}
            <button
              className={dirty ? btnPrimary : btnSecondary}
              disabled={!dirty}
              title="Save (⌘S / Ctrl+S)"
              onClick={() => void useApp.getState().save()}
            >
              <Icon name="save" size={15} />
              Save
            </button>
          </div>
        </header>
        <LoadErrors session={session} />
        {(sourceMissing || session.workspace?.invalidSource) && (
          <div role="status" className="flex items-center gap-2 border-b border-warn-line bg-warn-soft px-4 py-2 text-sm text-warn">
            <Icon name="alert" size={15} />
            {session.workspace?.invalidSource ? SOURCE_INVALID_MESSAGE : SOURCE_MISSING_MESSAGE}
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-center gap-2 border-b border-danger-line bg-danger-soft px-4 py-2 text-sm text-danger">
            <Icon name="alert" size={15} />
            <span className="flex-1">{error}</span>
            <button aria-label="Dismiss error" className="rounded p-1 hover:bg-surface/60" onClick={() => useApp.setState({ error: null })}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
        {page === "translations" ? (
          <>
            <Toolbar
              filter={filter}
              onFilter={(p) => setUi({ filter: { ...useApp.getState().ui.filter, ...p } })}
              missingCount={missingCount}
              namespaces={session.data.namespaces}
              showNamespaces={session.data.format === "next-i18next"}
              nsLabel={session.workspace ? "Group" : "Namespace"}
              targetLocales={targets}
              hidden={hidden}
              onToggleLocale={toggleLocale}
              viewMode={viewMode}
              onViewMode={onViewMode}
              onAddKey={() => setDialog({ kind: "add" })}
              onTranslateMissing={hasModel ? () => setDialog({ kind: "translate" }) : undefined}
            />
            <div className="min-h-0 flex-1">
              {viewMode === "list" ? (
                <ListView session={session} rows={rows} locales={visible} version={version} editing={editing} actions={actions} onRowAction={onRowAction} />
              ) : (
                <TableView session={session} rows={rows} locales={visible} version={version} editing={editing} actions={actions} onRowAction={onRowAction} />
              )}
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            {page === "languages" ? (
              <LanguagesPage session={session} stats={stats} />
            ) : page === "share" ? (
              <SharePage session={session} />
            ) : (
              <SettingsPage session={session} />
            )}
          </div>
        )}
      </main>
      {dialog?.kind === "add" && <AddKeyDialog session={session} onClose={() => setDialog(null)} />}
      {dialog?.kind === "translate" && <TranslateMissingDialog session={session} defaultLocale={visible[0]} onClose={() => setDialog(null)} />}
      {dialog?.kind === "rename" && <RenameKeyDialog session={session} row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && <DeleteKeyDialog session={session} row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === "export" && <ExportDialog session={session} onClose={() => setDialog(null)} />}
      {dialog?.kind === "code-key" && <SetCodeKeyDialog session={session} row={dialog.row.id} onClose={() => setDialog(null)} />}
      {dialog?.kind === "link" && <LinkDialog session={session} row={dialog.row.id} onClose={() => setDialog(null)} />}
      <ConflictDialog />
    </div>
  );
}
