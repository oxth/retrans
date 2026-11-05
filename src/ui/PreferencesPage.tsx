import { useEffect, useState } from "react";
import { getDefaultViewMode, setDefaultViewMode } from "../platform/prefs";
import { inputCls } from "./Dialog";
import { MtSettings } from "./MtSettings";
import { StartupSettings } from "./StartupSettings";
import { useApp } from "./store";
import { UpdateSettings } from "./UpdateBanner";

export function PreferencesPage() {
  const closePrefs = useApp((s) => s.closePrefs);
  const [mode, setMode] = useState<"list" | "table">("list");
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closePrefs();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePrefs]);

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-white">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col space-y-6 p-6 text-sm">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Preferences</h1>
          <button className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50" onClick={closePrefs}>Done</button>
        </div>
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Default view</h2>
          <label className="block">
            <span className="sr-only">Default view</span>
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
        </section>
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Startup</h2>
          <StartupSettings />
        </section>
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Machine translation</h2>
          <MtSettings session={null} />
        </section>
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Updates</h2>
          <UpdateSettings />
        </section>
        {note && <div role="status" className="text-xs text-gray-600">{note}</div>}
      </div>
    </div>
  );
}
