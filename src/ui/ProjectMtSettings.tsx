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
    </div>
  );
}
