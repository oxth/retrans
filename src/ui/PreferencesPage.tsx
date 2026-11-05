import { useEffect, useState } from "react";
import { getDefaultViewMode, setDefaultViewMode } from "../platform/prefs";
import { inputCls, btnSecondary } from "./Dialog";
import { MtSettings } from "./MtSettings";
import { useMt } from "./mt-store";
import { findModel } from "../mt/catalog";
import { StartupSettings } from "./StartupSettings";
import { useApp } from "./store";
import { UpdateSettings } from "./UpdateBanner";

/** Custom instructions for all projects (combined with each project's and language's own). */
function GlobalInstructions() {
  const instructions = useMt((s) => s.settings.instructions);
  const fixedPrompt = useMt((s) => {
    const { provider, modelId, custom } = s.settings;
    if ((provider ?? "local") !== "local") return false;
    const template = modelId === "custom" ? custom?.template : modelId ? findModel(modelId)?.template : undefined;
    return template === "translategemma";
  });
  return (
    <label className="block">
      <span className="mb-1 block">Instructions for all projects</span>
      <textarea
        aria-label="Instructions for all projects"
        className={inputCls}
        rows={3}
        placeholder="e.g. Keep translations short: this is UI text."
        defaultValue={instructions}
        onBlur={(e) => void useMt.getState().setInstructions(e.target.value.trim())}
      />
      <span className="mt-1 block text-xs text-muted">
        Sent with every translation by cloud providers, AI agents and Qwen models. Each project can add its own in its Settings.
      </span>
      {fixedPrompt && (
        <span className="mt-1 block text-xs text-warn">TranslateGemma uses a fixed prompt and ignores custom instructions.</span>
      )}
    </label>
  );
}

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
    <div role="dialog" aria-label="Preferences" className="fixed inset-0 z-50 overflow-auto bg-surface">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col space-y-6 p-6 text-sm">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Preferences</h1>
          <button className={btnSecondary} onClick={closePrefs}>Done</button>
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
            <span className="mt-1 block text-xs text-muted">Used for projects that have no saved view of their own.</span>
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
          <h2 className="text-base font-semibold">Instructions for the AI</h2>
          <GlobalInstructions />
        </section>
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Updates</h2>
          <UpdateSettings />
        </section>
        {note && <div role="status" className="text-xs text-muted">{note}</div>}
      </div>
    </div>
  );
}
