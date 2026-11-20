import { useEffect, useState } from "react";
import { forgetPlugin, linkStart, linkStatus, type LinkStatus, linkStop, pairCode } from "../platform/preview-link";
import { getLiveLink, setLiveLink } from "../platform/prefs";
import { btnRow, Group, Row, Switch, useSaveNote } from "./settings-ui";

/** A pairing code's remaining time, as m:ss. */
const mmss = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

/**
 * Settings → Figma plugin: the live link with the Retrans Preview plugin. App-wide, because pairing
 * is per computer and the listener runs whether or not a project is open.
 */
export function LiveLinkSettings() {
  const [linkOn, setLinkOn] = useState(false);
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; wasPaired: boolean } | null>(null);
  const [left, setLeft] = useState(0);
  // Turning the link on or off saves at once; only a failure needs saying.
  const { track, footer: saveFailed } = useSaveNote();

  useEffect(() => {
    let live = true;
    getLiveLink().then(
      (v) => live && setLinkOn(v),
      () => {},
    );
    linkStatus().then(
      (s) => live && setStatus(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  // The pairing code counts down to 0, then the button comes back; the interval ends with the code.
  // It also watches for the plugin to pair and then clears the spent code.
  useEffect(() => {
    if (!pairing) return;
    let live = true;
    const id = setInterval(() => {
      const secs = Math.ceil((pairing.expiresAt - Date.now()) / 1000);
      if (secs <= 0) setPairing(null);
      else {
        setLeft(secs);
        linkStatus().then(
          (s) => {
            if (!live) return;
            setStatus(s);
            if (s.paired && !pairing.wasPaired) setPairing(null);
          },
          () => {},
        );
      }
    }, 1000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pairing]);

  const refreshStatus = () => {
    void linkStatus().then(setStatus, () => {});
  };
  const toggleLink = (on: boolean) => {
    setLinkOn(on);
    setStartError(null);
    if (!on) setPairing(null);
    track(() => setLiveLink(on), { quiet: true });
    if (on) {
      void linkStart().then(refreshStatus, (e) => {
        setStartError(e instanceof Error ? e.message : String(e));
        refreshStatus();
      });
    } else {
      void linkStop().then(refreshStatus, refreshStatus);
    }
  };
  async function pair() {
    setStartError(null);
    try {
      const { code, expiresInMs } = await pairCode();
      setLinkOn(true);
      track(() => setLiveLink(true), { quiet: true });
      setPairing({ code, expiresAt: Date.now() + expiresInMs, wasPaired: status?.paired ?? false });
      setLeft(Math.ceil(expiresInMs / 1000));
      refreshStatus();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    }
  }
  const forget = () => {
    setStartError(null);
    setPairing(null);
    void forgetPlugin().then(refreshStatus, refreshStatus);
  };
  const liveNote = startError
    ? `Couldn't start: ${startError}`
    : status?.paired
      ? `Paired${status.port !== null ? ` · listening on port ${status.port}` : ""}`
      : "Not paired";

  return (
    <Group label="Live link with Figma" footer={saveFailed ?? liveNote}>
      <Row label="Live link" hint="Lets the Figma plugin talk to Retrans. Pairing is per computer, not per project.">
        <Switch label="Live link with the Figma plugin" checked={linkOn} onChange={toggleLink} />
      </Row>
      <Row
        label="Plugin pairing"
        hint={pairing ? "Enter the code in the Figma plugin before it expires." : "A six-digit code pairs the plugin with this computer."}
      >
        {pairing ? (
          <>
            <span aria-live="polite" className="font-mono text-2xl tracking-widest">{pairing.code}</span>
            <span className="text-xs text-muted">Expires in {mmss(left)}</span>
          </>
        ) : (
          <button type="button" className={btnRow} onClick={() => void pair()}>
            Pair a plugin
          </button>
        )}
      </Row>
      {status?.paired && (
        <Row label="Paired plugin" hint="The plugin can ask for previews until it is forgotten.">
          <button type="button" className={btnRow} onClick={forget}>
            Forget plugin
          </button>
        </Row>
      )}
    </Group>
  );
}
