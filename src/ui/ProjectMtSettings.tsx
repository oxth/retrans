import type { ProjectSession } from "../core/session";
import { PROVIDER_LABELS } from "../mt/translator";
import type { ProviderId } from "../platform/prefs";
import { inputCls } from "./Dialog";
import { useMt } from "./mt-store";
import { useSessionVersion } from "./store";

/** Project Settings → Translation: this project's provider (overrides the app-wide one). */
export function ProjectMtSettings({ session }: { session: ProjectSession }) {
  useSessionVersion();
  const global = useMt((s) => s.settings.provider);
  const override = session.state.project.mtProvider ?? "";
  const instr = session.state.project.instructions ?? {};
  const targets = session.data.locales.filter((l) => l !== session.data.baseLocale);
  const saveInstr = (patch: { all?: string; locale?: [string, string] }) => {
    const cur = session.state.project.instructions ?? {};
    const byLocale = { ...(cur.byLocale ?? {}) };
    if (patch.locale) {
      if (patch.locale[1]) byLocale[patch.locale[0]] = patch.locale[1];
      else delete byLocale[patch.locale[0]];
    }
    const all = "all" in patch ? patch.all : cur.all;
    session.setProjectSetting({
      instructions: { ...(all ? { all } : {}), ...(Object.keys(byLocale).length ? { byLocale } : {}) },
    });
  };
  return (
    <div className="space-y-3">
      <label className="block">
        Translation provider for this project
        <select
          aria-label="Translation provider for this project"
          className={inputCls}
          value={override}
          onChange={(e) => session.setProjectSetting({ mtProvider: e.target.value || undefined })}
        >
          <option value="">Use the app setting ({PROVIDER_LABELS[global as ProviderId] ?? PROVIDER_LABELS.local})</option>
          {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((p) => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-gray-500">
          Saved in .retrans/state.json, so everyone on the project uses the same provider. Keys and models are set in Preferences.
        </span>
      </label>
      <label className="block">
        Instructions for this project
        <textarea
          aria-label="Instructions for this project"
          className={inputCls}
          rows={3}
          placeholder="e.g. Formal Thai. Keep [Product Name] in English."
          defaultValue={instr.all ?? ""}
          onBlur={(e) => saveInstr({ all: e.target.value.trim() })}
        />
      </label>
      {targets.map((l) => (
        <label key={l} className="block">
          Instructions for {l}
          <textarea
            aria-label={`Instructions for ${l}`}
            className={inputCls}
            rows={2}
            defaultValue={instr.byLocale?.[l] ?? ""}
            onBlur={(e) => saveInstr({ locale: [l, e.target.value.trim()] })}
          />
        </label>
      ))}
      <p className="text-xs text-gray-500">
        Added after the instructions for all projects (Preferences), in that order. Stored in .retrans/state.json and shared through git.
      </p>
    </div>
  );
}
