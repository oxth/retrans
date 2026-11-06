import { useEffect, useState } from "react";
import { getLaunchMode, type LaunchMode, setLaunchMode } from "../platform/prefs";
import { fieldBase, Row } from "./settings-ui";

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
    <Row label="When Retrans opens" hint="What you see each time you start the app." htmlFor="launch-mode">
      <select
        id="launch-mode"
        className={`${fieldBase} w-72`}
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
    </Row>
  );
}
