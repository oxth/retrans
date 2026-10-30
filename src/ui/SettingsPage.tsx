import { useEffect, useState } from "react";
import type { ProjectSession } from "../core/session";
import { getDefaultViewMode, setDefaultViewMode } from "../platform/prefs";
import { btnPrimary, inputCls } from "./Dialog";

export function SettingsPage({ session }: { session: ProjectSession }) {
  const [mode, setMode] = useState<"list" | "table">("list");
  const [path, setPath] = useState(session.state.project.localesPath ?? session.opts.localesPath ?? "");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getDefaultViewMode().then(
      (m) => live && setMode(m),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 p-6 text-sm">
      <h1 className="text-lg font-semibold">Settings</h1>
      <label className="block">
        <span className="mb-1 block font-medium">Default view</span>
        <select
          aria-label="Default view"
          className={inputCls}
          value={mode}
          onChange={(e) => {
            const m = e.target.value === "table" ? "table" : "list";
            setMode(m);
            void setDefaultViewMode(m).catch(() => setNote("Could not save the default view"));
          }}
        >
          <option value="list">List</option>
          <option value="table">Table</option>
        </select>
        <span className="mt-1 block text-xs text-gray-500">Used for projects that have no saved view of their own.</span>
      </label>
      <div>
        <label className="block">
          <span className="mb-1 block font-medium">Locales path</span>
          <input aria-label="Locales path" className={`${inputCls} font-mono`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="public/locales" />
        </label>
        <div className="mt-2 flex items-center gap-3">
          <button
            className={btnPrimary}
            onClick={() => {
              session.setProjectSetting({ localesPath: path.trim() || undefined });
              setNote("Will be written to .paratrans/state.json on the next save.");
            }}
          >
            Save setting
          </button>
          <span className="text-xs text-gray-500">Takes effect when you reopen the project.</span>
        </div>
      </div>
      {note && <div role="status" className="text-xs text-gray-600">{note}</div>}
    </div>
  );
}
