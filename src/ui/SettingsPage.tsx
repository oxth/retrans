import { useState } from "react";
import type { ProjectSession } from "../core/session";
import { btnGhost, btnPrimary, inputCls } from "./Dialog";
import { useApp } from "./store";
import { FigmaSettings } from "./FigmaSettings";

export function SettingsPage({ session }: { session: ProjectSession }) {
  const openPrefs = useApp((s) => s.openPrefs);
  const detectedPath = useApp((s) => s.detected?.localesPath) ?? session.opts.localesPath;
  const override = session.state.project.localesPath;
  const [path, setPath] = useState(override ?? session.opts.localesPath ?? "");
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 p-6 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Settings</h1>
        <button className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50" onClick={openPrefs}>Preferences…</button>
      </div>
      {!session.workspace && <div>
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
              setNote(next || override ? "Will be written to .retrans/state.json on the next save." : "Using the detected path.");
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
      </div>}
      {session.workspace && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Figma</h2>
          <FigmaSettings session={session} />
        </section>
      )}
      {note && <div role="status" className="text-xs text-gray-600">{note}</div>}
    </div>
  );
}
