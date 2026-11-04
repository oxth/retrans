import { useEffect, useState } from "react";
import { getLaunchMode, type LaunchMode, setLaunchMode } from "../platform/prefs";
import { inputCls } from "./Dialog";

/** Settings → Startup: what Retrans shows when it opens. */
export function StartupSettings() {
  const [mode, setMode] = useState<LaunchMode>("restore");
  useEffect(() => {
    let live = true;
    getLaunchMode().then(
      (m) => live && setMode(m),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <label className="block text-sm">
      When Retrans opens
      <select
        className={inputCls}
        value={mode}
        onChange={(e) => {
          const m = e.target.value as LaunchMode;
          setMode(m);
          void setLaunchMode(m).catch(() => {});
        }}
      >
        <option value="restore">Reopen the projects that were open</option>
        <option value="start">Show the start screen</option>
      </select>
    </label>
  );
}
