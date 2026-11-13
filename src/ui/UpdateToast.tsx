import { getVersion } from "@tauri-apps/api/app";
import { useEffect } from "react";
import { recordLaunchedVersion } from "../platform/prefs";
import { shouldAnnounceUpdate } from "./changelog";
import { Icon } from "./Icon";
import { TOAST_CLS } from "./UpdateAvailableToast";
import { useApp } from "./store";

/** On launch: remembers this version and, if it's newer than last launch's, sets the toast. */
export function useAnnounceUpdate(): void {
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(getVersion)
      .then(async (v) => {
        const previous = await recordLaunchedVersion(v);
        if (live && shouldAnnounceUpdate(previous, v)) useApp.setState({ updatedTo: v });
      })
      .catch(() => {}); // not running inside Tauri (tests, browser)
    return () => {
      live = false;
    };
  }, []);
}

/** "Updated to Retrans 0.5.2 · See what's new": stays until used or dismissed, so it isn't missed while the app loads. */
export function UpdateToast() {
  const version = useApp((s) => s.updatedTo);
  const whatsNewOpen = useApp((s) => s.whatsNewOpen);
  if (!version || whatsNewOpen) return null;
  const dismiss = () => useApp.setState({ updatedTo: null });
  return (
    <div role="status" className={TOAST_CLS}>
      <Icon name="sparkles" size={16} className="mt-0.5 text-brand" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Updated to Retrans {version}</div>
        <button
          type="button"
          className="mt-0.5 font-medium text-brand-ink hover:underline"
          onClick={() => {
            dismiss();
            useApp.getState().openWhatsNew(version);
          }}
        >
          See what's new
        </button>
      </div>
      <button type="button" aria-label="Dismiss" className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg" onClick={dismiss}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
