import { useEffect, useRef, useState } from "react";
import { getAutoCheckUpdates, setAutoCheckUpdates } from "../platform/prefs";
import { checkForUpdate, type AvailableUpdate } from "../platform/updates";
import { btnGhost, btnPrimary } from "./Dialog";
import { Icon } from "./Icon";
import { btnRow, Group, Row, Switch } from "./settings-ui";
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

/** The update toasts' card (this one and "Updated to…"); App stacks them in the bottom-right corner. */
export const TOAST_CLS = "pointer-events-auto flex w-80 items-start gap-3 rounded-lg border border-line bg-surface p-3 text-sm text-fg shadow-pop";

/** How often an open Retrans looks for an update. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Coming back to the window (after sleep, from another app) looks again if the last look is this old. */
export const RECHECK_AFTER_MS = 60 * 60 * 1000;

/**
 * Looks for an update at launch, every few hours while open, and when the window comes back after a
 * while (when automatic checks are on), and shows a toast only if there is one. A toast, not a bar:
 * it can appear mid-session, and a bar would push the page down while you edit. It stays until
 * Install or Later; "Later" hides that version for this run, a newer one shows again.
 */
export function UpdateAvailableToast() {
  const update = useApp((s) => s.update);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { phase, run } = useInstall(update);
  // Refs, not effect locals: they survive React's dev double-mount, so that doesn't check twice.
  const busy = useRef(false);
  const lastCheck = useRef(0);
  const installing = useRef(false);
  installing.current = phase.kind === "installing";

  useEffect(() => {
    let live = true;
    const look = async () => {
      if (busy.current || installing.current) return;
      busy.current = true;
      lastCheck.current = Date.now();
      try {
        if (!(await getAutoCheckUpdates())) return; // read each time: turning it off applies at once
        const found = await checkForUpdate();
        // Same version: keep the object, so an install in progress isn't reset.
        if (live && found && useApp.getState().update?.version !== found.version) useApp.setState({ update: found });
      } catch (e) {
        console.warn("Update check failed", e);
      } finally {
        busy.current = false;
      }
    };
    const onBack = () => {
      if (document.visibilityState !== "hidden" && Date.now() - lastCheck.current >= RECHECK_AFTER_MS) void look();
    };
    void look();
    const timer = setInterval(() => void look(), CHECK_EVERY_MS);
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, []);

  if (!update || dismissed === update.version) return null;
  return (
    <div role="status" className={TOAST_CLS}>
      <Icon name="refresh" size={16} className="mt-0.5 text-brand" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Retrans {update.version} is available.</div>
        {phase.kind !== "idle" && (
          <div className={`mt-0.5 text-xs ${phase.kind === "failed" ? "text-danger" : "text-muted"}`}>
            <InstallStatus phase={phase} />
          </div>
        )}
        {phase.kind !== "installing" && (
          <div className="mt-2.5 flex gap-2">
            <button className={`${btnPrimary} px-2.5 py-1 text-xs`} onClick={() => void run()}>Install and restart</button>
            <button className={`${btnGhost} px-2.5 py-1 text-xs`} onClick={() => setDismissed(update.version)}>Later</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function UpdateSettings() {
  const [auto, setAuto] = useState(true);
  const [result, setResult] = useState<"idle" | "checking" | "current" | "error">("idle");
  // Shared with the toast: an update found automatically shows here at once, ready to install.
  const update = useApp((s) => s.update);
  const { phase, run } = useInstall(update);

  // Seeing it here is what the gear's dot asks for.
  useEffect(() => {
    if (update) useApp.setState({ updateSeen: update.version });
  }, [update]);

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
    try {
      const u = await checkForUpdate();
      if (u?.version !== useApp.getState().update?.version) useApp.setState({ update: u });
      setResult(u ? "idle" : "current");
    } catch (e) {
      console.warn("Update check failed", e);
      setResult("error");
    }
  };

  return (
    <Group label="Updates">
      <Row label="Check automatically" hint="Look for a new version when Retrans starts and every few hours while it is open.">
        <Switch
          label="Check for updates automatically"
          checked={auto}
          onChange={(v) => {
            setAuto(v);
            void setAutoCheckUpdates(v).catch(() => {});
          }}
        />
      </Row>
      <Row
        label={update ? `Retrans ${update.version} is available.` : "Check now"}
        hint={
          result === "current" ? (
            <span role="status">You're up to date.</span>
          ) : result === "error" ? (
            <span role="status" className="text-danger">Couldn't check for updates.</span>
          ) : update ? (
            <span role="status">
              <InstallStatus phase={phase} />
              {phase.kind === "idle" && "Installing restarts Retrans. Unsaved changes are saved or discarded first."}
            </span>
          ) : (
            "Updates are downloaded from GitHub releases."
          )
        }
      >
        {update && phase.kind === "idle" && <button type="button" className={btnPrimary} onClick={() => void run()}>Install and restart</button>}
        <button type="button" className={btnRow} disabled={result === "checking"} onClick={() => void check()}>
          <Icon name="refresh" size={14} className={result === "checking" ? "animate-spin motion-reduce:animate-none" : ""} />
          {result === "checking" ? "Checking…" : "Check for updates"}
        </button>
      </Row>
      <Row label="What's new" hint="Release notes for every version.">
        <button type="button" className={btnGhost} onClick={() => useApp.getState().openWhatsNew()}>
          <Icon name="sparkles" size={14} />
          What's new
        </button>
      </Row>
    </Group>
  );
}
