import { useEffect, useState } from "react";
import type { ProjectSession } from "../core/session";
import { getDefaultViewMode, setDefaultViewMode } from "../platform/prefs";
import { btnGhost, btnPrimary, inputCls } from "./Dialog";
import { useApp } from "./store";

export function SettingsPage({ session }: { session: ProjectSession }) {
  const [mode, setMode] = useState<"list" | "table">("list");
  const detectedPath = useApp((s) => s.detected?.localesPath) ?? session.opts.localesPath;
  const override = session.state.project.localesPath;
  const [path, setPath] = useState(override ?? session.opts.localesPath ?? "");
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
              const p = path.trim();
              // Only a path that differs from the detected one is an override.
              const next = p && p !== detectedPath ? p : undefined;
              session.setProjectSetting({ localesPath: next });
              if (!next) setPath(detectedPath);
              setNote(next || override ? "Will be written to .paratrans/state.json on the next save." : "Using the detected path.");
            }}
          >
            Save setting
          </button>
          {override !== undefined && (
            <button
              className={btnGhost}
              onClick={() => {
                session.setProjectSetting({ localesPath: undefined });
                setPath(detectedPath);
                setNote(`Reset to the detected path (${detectedPath}).`);
              }}
            >
              Reset to detected
            </button>
          )}
          <span className="text-xs text-gray-500">Takes effect when you reopen the project.</span>
        </div>
      </div>
      {note && <div role="status" className="text-xs text-gray-600">{note}</div>}
    </div>
  );
}
