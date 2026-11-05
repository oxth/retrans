import { useEffect, useRef, useState } from "react";
import { getAutoCheckUpdates, setAutoCheckUpdates } from "../platform/prefs";
import { checkForUpdate, type AvailableUpdate } from "../platform/updates";
import { btnGhost, btnPrimary } from "./Dialog";
import { useApp } from "./store";

type Phase = { kind: "idle" } | { kind: "installing"; pct: number } | { kind: "failed" };

function useInstall(update: AvailableUpdate | null) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const run = async () => {
    if (!update) return;
    // Installing restarts the app: unsaved edits are saved or explicitly discarded first.
    if (!(await useApp.getState().confirmUnsaved())) return;
    setPhase({ kind: "installing", pct: 0 });
    try {
      await update.install((done, total) =>
        setPhase({ kind: "installing", pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0 }),
      );
    } catch (e) {
      console.warn("Update install failed", e);
      setPhase({ kind: "failed" });
    }
  };
  return { phase, run };
}

function InstallStatus({ phase }: { phase: Phase }) {
  if (phase.kind === "installing") return <span>Downloading… {phase.pct}%</span>;
  if (phase.kind === "failed") return <span>Update failed. Try again later.</span>;
  return null;
}

/** Checks once per launch (when enabled) and shows a banner only if an update exists. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const started = useRef(false);
  const { phase, run } = useInstall(update);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        if (!(await getAutoCheckUpdates())) return;
        setUpdate(await checkForUpdate());
      } catch (e) {
        console.warn("Update check failed", e);
      }
    })();
  }, []);

  if (!update || dismissed) return null;
  return (
    <div role="status" className="flex shrink-0 items-center justify-between gap-3 border-b border-brand-line bg-brand-soft px-4 py-2 text-sm">
      <span>Retrans {update.version} is available.</span>
      <div className="flex items-center gap-2">
        <InstallStatus phase={phase} />
        {phase.kind !== "installing" && (
          <>
            <button className={btnPrimary} onClick={() => void run()}>Install and restart</button>
            <button className={btnGhost} onClick={() => setDismissed(true)}>Later</button>
          </>
        )}
      </div>
    </div>
  );
}

export function UpdateSettings() {
  const [auto, setAuto] = useState(true);
  const [result, setResult] = useState<"idle" | "checking" | "current" | "error">("idle");
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const { phase, run } = useInstall(update);

  useEffect(() => {
    let live = true;
    getAutoCheckUpdates().then(
      (v) => live && setAuto(v),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const check = async () => {
    setResult("checking");
    setUpdate(null);
    try {
      const u = await checkForUpdate();
      setUpdate(u);
      setResult(u ? "idle" : "current");
    } catch (e) {
      console.warn("Update check failed", e);
      setResult("error");
    }
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAuto(e.target.checked);
            void setAutoCheckUpdates(e.target.checked).catch(() => {});
          }}
        />
        <span>Check for updates automatically</span>
      </label>
      <div className="flex items-center gap-3">
        <button className={btnGhost} disabled={result === "checking"} onClick={() => void check()}>Check for updates</button>
        {result === "current" && <span role="status">You're up to date.</span>}
        {result === "error" && <span role="status">Couldn't check for updates.</span>}
        {update && (
          <>
            <span role="status">Retrans {update.version} is available.</span>
            {phase.kind === "idle" && <button className={btnPrimary} onClick={() => void run()}>Install and restart</button>}
            <InstallStatus phase={phase} />
          </>
        )}
      </div>
    </div>
  );
}
