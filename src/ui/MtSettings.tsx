import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ProjectSession } from "../core/session";
import { CATALOG, type CatalogModel, formatBytes, type PromptTemplate } from "../mt/catalog";
import { nextReqId, translateText } from "../mt/translate";
import { pickGgufFile } from "../platform/mt";
import { btnGhost, btnPrimary, Dialog, inputCls, btnDanger } from "./Dialog";
import { activeModel, spaceUsed, useMt } from "./mt-store";
import { type ModelList, ProviderFields, RemoteTest } from "./ProviderSettings";
import { accountOf, applyDraft, consentNeeded, draftError, draftFrom, isCloud, isDirty, type MtDraft, trimBase } from "./mt-draft";
import { PROVIDER_LABELS } from "../mt/translator";
import type { ProviderId } from "../platform/prefs";
import { hasSecret } from "../platform/secrets";
import {
  btnRow,
  defaultPair,
  fieldBase,
  Group,
  LanguagePair,
  languageOptions,
  languagePairError,
  Row,
  SaveBar,
  sameAsInput,
  Switch,
  UNCHANGED_NOTE,
  useReportUnsaved,
} from "./settings-ui";

const GEMMA_TERMS = "https://ai.google.dev/gemma/terms";
const GEMMA_PROHIBITED = "https://ai.google.dev/gemma/prohibited_use_policy";

function ExtLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      className="text-brand-ink underline"
      onClick={(e) => {
        e.preventDefault();
        void Promise.resolve(openUrl(href)).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

function ModelCard({ model, onDownload, selected, onSelect }: { model: CatalogModel; onDownload: (m: CatalogModel) => void; selected: boolean; onSelect: () => void }) {
  const s = useMt();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dl = s.downloads[model.id];
  const file = s.files[model.file];
  const running = dl?.state === "progress";
  const complete = !running && !!file?.complete;
  const partial = !running && !complete && !!file && !file.complete && dl?.state !== "error";
  const percent = dl && dl.total > 0 ? Math.min(100, Math.round((dl.received / dl.total) * 100)) : 0;
  return (
    <div role="group" aria-label={model.name} className="space-y-3 px-4 py-3.5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{model.name}</span>
            {model.recommended && <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand-ink">Recommended</span>}
            {complete && s.settings.modelId === model.id && <span className="rounded bg-ok-soft px-1.5 py-0.5 text-[11px] font-medium text-ok">In use</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span>Download: {formatBytes(model.sizeBytes)}</span>
            <span>RAM: {model.ramGb}</span>
            <span>Languages: {model.languages}</span>
            <span>
              License: <ExtLink href={model.license.url}>{model.license.name}</ExtLink>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {partial && (
            <>
              <button type="button" className={btnRow} onClick={() => onDownload(model)}>Resume</button>
              <button type="button" className={btnGhost} onClick={() => void s.cancel(model.id)}>Cancel</button>
            </>
          )}
          {complete && (
            <>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="radio" name="mt-model" checked={selected} onChange={onSelect} />
                Use this model
              </label>
              <button type="button" className={btnGhost} onClick={() => setConfirmDelete(true)}>Delete model</button>
            </>
          )}
          {!running && !complete && !partial && dl?.state !== "error" && (
            <button type="button" className={model.recommended ? btnPrimary : btnRow} onClick={() => onDownload(model)}>Download</button>
          )}
        </div>
      </div>
      {dl?.state === "error" && (
        <div className="flex items-center gap-2 text-xs text-danger">
          <span>{dl.message}</span>
          <button type="button" className={btnGhost} onClick={() => onDownload(model)}>Retry</button>
        </div>
      )}
      {running && (
        <div className="flex items-center gap-2">
          <div role="progressbar" aria-label={`${model.name} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
          <span className="w-9 text-right text-xs tabular-nums text-muted">{percent}%</span>
          <button type="button" className={btnGhost} onClick={() => void s.pause(model.id)}>Pause</button>
          <button type="button" className={btnGhost} onClick={() => void s.cancel(model.id)}>Cancel</button>
        </div>
      )}
      {confirmDelete && (
        <Dialog title="Delete model" onClose={() => setConfirmDelete(false)}>
          <p className="text-sm">
            Delete {model.name}? You'll need to download it again ({formatBytes(model.sizeBytes)}) to use it.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button
              className={btnDanger}
              onClick={() => {
                setConfirmDelete(false);
                void s.deleteModel(model.id);
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function CustomCard({ draft, patch }: { draft: MtDraft; patch: (p: Partial<MtDraft>) => void }) {
  const saved = useMt((x) => x.settings.custom);
  const missing = useMt((x) => x.customMissing) && !!saved && draft.customPath === saved.path;
  const path = draft.customPath;
  return (
    <div role="group" aria-label="Use my own GGUF file" className="space-y-3 px-4 py-3.5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium">Use my own GGUF file</div>
          <div className="mt-1 text-xs text-muted">
            {path ? (
              missing ? <span className="text-danger">File not found</span> : <span className="break-all font-mono">{path}</span>
            ) : (
              "Any model in GGUF format that follows one of the prompt styles."
            )}
          </div>
        </div>
        <button
          type="button"
          className={btnRow}
          onClick={async () => {
            const p = await pickGgufFile().catch(() => null);
            if (p) patch({ customPath: p, modelId: "custom" });
          }}
        >
          Choose file…
        </button>
      </div>
      <div className="flex items-center justify-between gap-6">
        <label className="flex items-center gap-2 text-xs text-muted">
          Prompt style
          <select className={`${fieldBase} w-44`} value={draft.customTemplate} onChange={(e) => patch({ customTemplate: e.target.value as PromptTemplate })}>
            <option value="qwen3">Qwen / ChatML</option>
            <option value="translategemma">TranslateGemma</option>
          </select>
        </label>
        {path && (
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" name="mt-model" checked={draft.modelId === "custom"} disabled={missing} onChange={() => patch({ modelId: "custom" })} />
            Use this model
          </label>
        )}
      </div>
    </div>
  );
}

function TestPanel({ session, dirty }: { session: ProjectSession; dirty: boolean }) {
  const model = useMt(useShallow(activeModel));
  const engine = useMt((s) => s.engine);
  const { format, baseLocale, locales } = session.data;
  const [start] = useState(() => defaultPair(baseLocale, locales));
  const [text, setText] = useState(
    format === "paraglide" ? "Welcome back, {name}! You have new messages." : "Welcome back, {{name}}! You have new messages.",
  );
  const [source, setSource] = useState(start.from);
  const [tgt, setTgt] = useState(start.to);
  const [out, setOut] = useState<string | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const pairError = languagePairError(source, tgt);
  useEffect(() => setOut(null), [model?.path]);
  if (!model) return null;
  return (
    <Group label="Try it">
      <Row
        stacked
        label="Test this model"
        hint={dirty ? "Uses the saved model. Save your changes to try them." : "Translates one sample string. Set From to the language of the text."}
      >
        <LanguagePair from={source} to={tgt} onFrom={setSource} onTo={setTgt} options={languageOptions(locales)} />
        <textarea aria-label="Text to translate" className={`${inputCls} resize-y`} rows={2} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 text-xs text-danger">{pairError}</span>
          <button
            type="button"
            className={btnPrimary}
            disabled={dirty || busy || !!pairError || !text.trim()}
            onClick={async () => {
              setBusy(true);
              setUnchanged(false);
              const r = await translateText(engine, model, format, source, tgt, text, nextReqId());
              setBusy(false);
              setOut(r.ok ? r.text : r.reason === "unsafe" ? "Couldn't translate safely" : r.reason === "error" ? r.message : "Cancelled");
              setUnchanged(r.ok && sameAsInput(text, r.text));
            }}
          >
            {busy ? "Translating…" : "Translate"}
          </button>
        </div>
        <div role="status" className="min-h-5 rounded-md bg-surface px-3 py-2 text-sm empty:hidden">{out}</div>
        {unchanged && <p className="text-xs text-warn">{UNCHANGED_NOTE}</p>}
      </Row>
    </Group>
  );
}

/** The provider's model list and whether a key is saved, for the provider and address in the draft. */
function useCloud(draft: MtDraft, patch: (p: Partial<MtDraft>) => void): { savedKey: boolean | null; models: ModelList; test: () => Promise<string>; recheckKey: () => void } {
  const savedBase = useMt((x) => x.settings.cloud.compatible?.baseUrl ?? "");
  const p = draft.provider;
  const base = trimBase(draft.baseUrl);
  const account = isCloud(p) ? accountOf(p, base) : null;
  const [savedKey, setSavedKey] = useState<boolean | null>(null);
  const [keyCheck, setKeyCheck] = useState(0);
  const [list, setList] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    let live = true;
    setSavedKey(null);
    if (!account) return;
    hasSecret(account).then(
      (v) => live && setSavedKey(v),
      () => live && setSavedKey(false),
    );
    return () => {
      live = false;
    };
  }, [account, keyCheck]);

  const load = async (): Promise<string[]> => {
    if (!isCloud(p)) return [];
    setLoading(true);
    setError(null);
    try {
      const got = await invoke<string[]>("mt_cloud_models", { provider: p, baseUrl: p === "compatible" ? base : null });
      setList(got);
      // Nothing chosen yet: start from the provider's first model.
      if (got.length && !draftRef.current.models[p]) patch({ models: { ...draftRef.current.models, [p]: got[0] } });
      return got;
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      setError(msg);
      throw new Error(msg);
    } finally {
      setLoading(false);
    }
  };

  // Load on its own once it can be asked: a key is saved, or (compatible) the saved address.
  useEffect(() => {
    setList(null);
    setError(null);
    if (!isCloud(p)) return;
    if (p === "compatible" ? !base || base !== savedBase : !savedKey) return;
    void load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, savedKey, p === "compatible" ? base === savedBase : true]);

  const test = async () => {
    const got = await load();
    return `Connected. ${got.length} model${got.length === 1 ? "" : "s"} available.`;
  };
  return { savedKey, models: { list, loading, error, reload: () => void load().catch(() => {}) }, test, recheckKey: () => setKeyCheck((n) => n + 1) };
}

export function MtSettings({ session }: { session: ProjectSession | null }) {
  const s = useMt();
  const used = useMt((x) => spaceUsed(x));
  const [license, setLicense] = useState<CatalogModel | null>(null);
  const [draft, setDraft] = useState<MtDraft>(() => draftFrom(s.settings));
  const patch = useCallback((p: Partial<MtDraft>) => setDraft((d) => ({ ...d, ...p })), []);
  const dirty = isDirty(draft, s.settings);
  const [asking, setAsking] = useState<{ provider: ProviderId; key: string; where: string } | null>(null);
  const [status, setStatus] = useState<{ tone: "saved" | "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const cloud = useCloud(draft, patch);
  useReportUnsaved(dirty);
  useEffect(() => {
    void useMt.getState().init();
  }, []);
  // Settings loaded or changed elsewhere (e.g. a finished download picked its model): follow them
  // unless the user is mid-edit.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) setDraft(draftFrom(s.settings));
  }, [s.settings]);
  // A new edit clears "Saved." and a validation error (a test result stays).
  useEffect(() => {
    if (dirtyRef.current) setStatus((st) => (st?.tone === "saved" || st?.tone === "error" ? null : st));
  }, [draft]);

  const start = (m: CatalogModel) => {
    if (m.license.requiresAcceptance && !s.settings.accepted.includes(m.id)) setLicense(m);
    else void s.download(m.id);
  };

  const commit = async () => {
    setBusy("save");
    try {
      await applyDraft(draft, useMt.getState());
      setDraft(draftFrom(useMt.getState().settings));
      cloud.recheckKey();
      setStatus({ tone: "saved", text: "Saved." });
    } catch (e) {
      setStatus({ tone: "error", text: `Couldn't save: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  };
  const save = () => {
    const problem = draftError(draft);
    if (problem) return setStatus({ tone: "error", text: problem });
    const ask = consentNeeded(draft, s.settings);
    if (ask) setAsking(ask);
    else void commit();
  };
  const test = async () => {
    setBusy("test");
    setStatus(null);
    try {
      setStatus({ tone: "ok", text: await cloud.test() });
    } catch (e) {
      setStatus({ tone: "error", text: `Couldn't connect: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  };
  const canTest = draft.enabled && isCloud(draft.provider);
  const local = draft.provider === "local";

  return (
    <>
      <Group label="Status" footer={!draft.enabled ? "Runs on your computer. Nothing is downloaded until you turn this on and pick a model." : undefined}>
        <Row label="Enable machine translation" hint="Suggest translations for missing text, and translate in bulk.">
          <Switch label="Enable machine translation" checked={draft.enabled} onChange={(v) => patch({ enabled: v })} />
        </Row>
      </Group>
      {draft.enabled && <ProviderFields draft={draft} patch={patch} savedKey={cloud.savedKey} models={cloud.models} />}
      {draft.enabled && local && (
        <>
          <Group label="Built-in models" footer={`Space used: ${formatBytes(used)}`}>
            {CATALOG.map((m) => (
              <ModelCard key={m.id} model={m} onDownload={start} selected={draft.modelId === m.id} onSelect={() => patch({ modelId: m.id })} />
            ))}
            <CustomCard draft={draft} patch={patch} />
          </Group>
          {session && <TestPanel session={session} dirty={dirty} />}
        </>
      )}
      {draft.enabled && !local && s.settings.enabled && (s.settings.provider ?? "local") !== "local" && <RemoteTest dirty={dirty} session={session} />}
      <SaveBar
        status={
          status ? (
            <span role="status" className={status.tone === "error" ? "text-danger" : "text-ok"}>{status.text}</span>
          ) : dirty ? (
            <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-warn-solid" aria-hidden="true" />Unsaved changes</span>
          ) : null
        }
      >
        {dirty && (
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              setDraft(draftFrom(s.settings));
              setStatus(null);
            }}
          >
            Discard
          </button>
        )}
        {canTest && (
          <button
            type="button"
            className={btnRow}
            disabled={busy !== null || !!draft.key.trim() || (draft.provider === "compatible" && !trimBase(draft.baseUrl))}
            title={draft.key.trim() ? "Save the new key to test it" : undefined}
            onClick={() => void test()}
          >
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
        )}
        <button type="button" className={btnPrimary} disabled={!dirty || busy !== null} onClick={save}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </SaveBar>
      {asking && (
        <Dialog title={`Send text to ${PROVIDER_LABELS[asking.provider]}?`} onClose={() => setAsking(null)}>
          <p className="text-sm">
            Text you translate will be sent to {PROVIDER_LABELS[asking.provider]} ({asking.where}). The built-in model keeps everything on
            this computer. Continue?
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setAsking(null)}>Cancel</button>
            <button
              className={btnPrimary}
              onClick={async () => {
                const a = asking;
                setAsking(null);
                await useMt.getState().grantConsent(a.key as ProviderId);
                await commit();
              }}
            >
              Continue
            </button>
          </div>
        </Dialog>
      )}
      {license && (
        <Dialog title={`${license.name} license`} onClose={() => setLicense(null)}>
          <p className="mb-2 text-sm">
            TranslateGemma is made by Google and released under the Gemma Terms of Use. Commercial use is allowed, subject to the Terms and the Prohibited Use Policy.
          </p>
          <ul className="mb-4 space-y-1 text-sm">
            <li><ExtLink href={GEMMA_TERMS}>Gemma Terms of Use</ExtLink></li>
            <li><ExtLink href={GEMMA_PROHIBITED}>Prohibited Use Policy</ExtLink></li>
          </ul>
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setLicense(null)}>Cancel</button>
            <button
              className={btnPrimary}
              onClick={async () => {
                const id = license.id;
                setLicense(null);
                await s.acceptLicense(id);
                await useMt.getState().download(id);
              }}
            >
              Accept &amp; download
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
