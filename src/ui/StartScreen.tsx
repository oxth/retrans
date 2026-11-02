import { useEffect, useState } from "react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import type { DetectResult } from "../formats/adapter";
import { detectProject } from "../formats/detect";
import { getRecent, type RecentProject } from "../platform/prefs";
import { NewProjectWizard } from "./NewProjectWizard";
import { OpenProjectDialog } from "./OpenProjectDialog";
import { savedBaseLocale, useApp } from "./store";

export function StartScreen() {
  const { fs, openProject } = useApp();
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [pending, setPending] = useState<{ root: string; detected: DetectResult; savedBase?: string | null } | null>(null);
  const [wizard, setWizard] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void getRecent().then(setRecent).catch(() => {});
  }, []);

  const detect = async (root: string): Promise<DetectResult | null> => {
    setMessage(null);
    try {
      const d = await detectProject(fs, root);
      if (!d) setMessage("No next-i18next or Paraglide project found in this folder.");
      return d;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const chooseFolder = async () => {
    try {
      const p = await pickFolder({ directory: true });
      if (typeof p !== "string") return;
      const root = p.replace(/\\/g, "/");
      const detected = await detect(root);
      if (detected) setPending({ root, detected, savedBase: await savedBaseLocale(fs, root, detected) });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const openRecent = async (r: RecentProject) => {
    const d = await detect(r.root);
    if (!d) return;
    const base = d.baseLocale ?? (await savedBaseLocale(fs, r.root, d));
    if (base === null) return setPending({ root: r.root, detected: d });
    try {
      await openProject(r.root, d, { baseLocale: base, localesPath: d.localesPath });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-8 text-gray-900">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-bold text-indigo-600">Retrans</h1>
        <p className="mt-1 text-gray-500">Edit next-i18next and Paraglide translations side by side.</p>
        <div className="mt-6 flex gap-3">
          <button onClick={chooseFolder} className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700">
            Open project
          </button>
          <button onClick={() => setWizard(true)} className="rounded-lg border border-gray-300 bg-white px-4 py-2 font-medium hover:bg-gray-100">
            New project
          </button>
        </div>
        {message && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>}
        {recent.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-gray-500">Recent projects</h2>
            <ul className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
              {recent.map((r) => (
                <li key={r.root}>
                  <button onClick={() => openRecent(r)} className="block w-full px-4 py-3 text-left hover:bg-gray-50">
                    <span className="font-medium">{r.name}</span>
                    <span className="block truncate font-mono text-xs text-gray-500">{r.root}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {pending && <OpenProjectDialog {...pending} onCancel={() => setPending(null)} />}
      {wizard && <NewProjectWizard onCancel={() => setWizard(false)} />}
    </main>
  );
}
