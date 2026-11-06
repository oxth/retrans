import { useEffect, useRef, useState } from "react";
import { getAutoCheckUpdates, setAutoCheckUpdates } from "../platform/prefs";
import { checkForUpdate, type AvailableUpdate } from "../platform/updates";
import { btnGhost, btnPrimary } from "./Dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "./Icon";

/** Release notes (the updater downloads from the same releases). */
export const RELEASES_URL = "https://github.com/oxth/retrans/releases";
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
    <Group label="Updates">
      <Row label="Check automatically" hint="Look for a new version each time Retrans starts.">
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
      <Row label="What's new" hint="Release notes for every version, on GitHub.">
        <button type="button" className={btnGhost} onClick={() => void Promise.resolve(openUrl(RELEASES_URL)).catch(() => {})}>
          <Icon name="sparkles" size={14} />
          What's new
        </button>
      </Row>
    </Group>
  );
}
