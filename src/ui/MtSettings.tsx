import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ProjectSession } from "../core/session";
import { CATALOG, type CatalogModel, formatBytes, type PromptTemplate } from "../mt/catalog";
import { nextReqId, translateText } from "../mt/translate";
import { pickGgufFile } from "../platform/mt";
import { btnGhost, btnPrimary, Dialog, inputCls } from "./Dialog";
import { activeModel, spaceUsed, useMt } from "./mt-store";
import { ProviderSettings } from "./ProviderSettings";

const GEMMA_TERMS = "https://ai.google.dev/gemma/terms";
const GEMMA_PROHIBITED = "https://ai.google.dev/gemma/prohibited_use_policy";

function ExtLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      className="text-indigo-600 underline"
      onClick={(e) => {
        e.preventDefault();
        void Promise.resolve(openUrl(href)).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

const cardCls = "space-y-2 rounded-lg border border-gray-200 p-3";

function ModelCard({ model, onDownload }: { model: CatalogModel; onDownload: (m: CatalogModel) => void }) {
  const s = useMt();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dl = s.downloads[model.id];
  const file = s.files[model.file];
  const running = dl?.state === "progress";
  const complete = !running && !!file?.complete;
  const partial = !running && !complete && !!file && !file.complete && dl?.state !== "error";
  const percent = dl && dl.total > 0 ? Math.min(100, Math.round((dl.received / dl.total) * 100)) : 0;
  return (
    <div role="group" aria-label={model.name} className={cardCls}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{model.name}</span>
        {model.recommended && <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700">Recommended</span>}
      </div>
      <div className="space-y-0.5 text-xs text-gray-600">
        <div>Download: {formatBytes(model.sizeBytes)}</div>
        <div>RAM: {model.ramGb}</div>
        <div>Languages: {model.languages}</div>
        <div>
          License: <ExtLink href={model.license.url}>{model.license.name}</ExtLink>
        </div>
      </div>
      {dl?.state === "error" && (
        <div className="flex items-center gap-2 text-xs text-red-600">
          <span>{dl.message}</span>
          <button className={btnGhost} onClick={() => onDownload(model)}>Retry</button>
        </div>
      )}
      {running && (
        <div className="flex items-center gap-2">
          <div role="progressbar" aria-label={`${model.name} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 flex-1 overflow-hidden rounded bg-gray-200">
            <div className="h-full bg-indigo-600" style={{ width: `${percent}%` }} />
          </div>
          <button className={btnGhost} onClick={() => void s.pause(model.id)}>Pause</button>
          <button className={btnGhost} onClick={() => void s.cancel(model.id)}>Cancel</button>
        </div>
      )}
      {partial && (
        <div className="flex gap-2">
          <button className={btnGhost} onClick={() => onDownload(model)}>Resume</button>
          <button className={btnGhost} onClick={() => void s.cancel(model.id)}>Cancel</button>
        </div>
      )}
      {complete && (
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="mt-model" checked={s.settings.modelId === model.id} onChange={() => void s.selectModel(model.id)} />
            Use this model
          </label>
          <button className={btnGhost} onClick={() => setConfirmDelete(true)}>Delete model</button>
        </div>
      )}
      {!running && !complete && !partial && dl?.state !== "error" && (
        <button className={btnPrimary} onClick={() => onDownload(model)}>Download</button>
      )}
      {confirmDelete && (
        <Dialog title="Delete model" onClose={() => setConfirmDelete(false)}>
          <p className="text-sm">
            Delete {model.name}? You'll need to download it again ({formatBytes(model.sizeBytes)}) to use it.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white"
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

function CustomCard() {
  const s = useMt();
  const custom = s.settings.custom;
  const [template, setTemplate] = useState<PromptTemplate>(custom?.template ?? "qwen3");
  return (
    <div role="group" aria-label="Use my own GGUF file" className={cardCls}>
      <div className="font-medium">Use my own GGUF file</div>
      <label className="flex items-center gap-2 text-xs">
        Prompt style
        <select
          className={inputCls}
          value={template}
          onChange={(e) => {
            const t = e.target.value as PromptTemplate;
            setTemplate(t);
            if (custom) void s.setCustom(custom.path, t);
          }}
        >
          <option value="qwen3">Qwen / ChatML</option>
          <option value="translategemma">TranslateGemma</option>
        </select>
      </label>
      <div className="flex items-center gap-2">
        <button
          className={btnGhost}
          onClick={async () => {
            const p = await pickGgufFile().catch(() => null);
            if (p) await s.setCustom(p, template);
          }}
        >
          Choose file…
        </button>
        {custom && (s.customMissing ? <span className="text-xs text-red-600">File not found</span> : <span className="break-all font-mono text-xs">{custom.path}</span>)}
      </div>
      {custom && (
        <label className="flex items-center gap-1.5">
          <input type="radio" name="mt-model" checked={s.settings.modelId === "custom"} disabled={s.customMissing} onChange={() => void s.selectModel("custom")} />
          Use this model
        </label>
      )}
    </div>
  );
}

function TestPanel({ session }: { session: ProjectSession }) {
  const model = useMt(useShallow(activeModel));
  const engine = useMt((s) => s.engine);
  const { format, baseLocale, locales } = session.data;
  const targets = locales.filter((l) => l !== baseLocale);
  const [text, setText] = useState(
    format === "paraglide" ? "Welcome back, {name}! You have new messages." : "Welcome back, {{name}}! You have new messages.",
  );
  const [tgt, setTgt] = useState(targets.includes("th") ? "th" : (targets[0] ?? ""));
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOut(null), [model?.path]);
  if (!model) return null;
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3">
      <div className="font-medium">Test this model</div>
      <textarea aria-label="Text to translate" className={inputCls} rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex items-center gap-2">
        <select aria-label="Target language" className={inputCls} value={tgt} onChange={(e) => setTgt(e.target.value)}>
          {targets.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <button
          className={btnPrimary}
          disabled={busy || !tgt}
          onClick={async () => {
            setBusy(true);
            const r = await translateText(engine, model, format, baseLocale, tgt, text, nextReqId());
            setBusy(false);
            setOut(r.ok ? r.text : r.reason === "unsafe" ? "Couldn't translate safely" : r.reason === "error" ? r.message : "Cancelled");
          }}
        >
          Translate
        </button>
      </div>
      <div role="status" className="min-h-5 text-sm">{out}</div>
    </div>
  );
}

export function MtSettings({ session }: { session: ProjectSession | null }) {
  const s = useMt();
  const used = useMt((x) => spaceUsed(x));
  const [license, setLicense] = useState<CatalogModel | null>(null);
  useEffect(() => {
    void useMt.getState().init();
  }, []);

  const start = (m: CatalogModel) => {
    if (m.license.requiresAcceptance && !s.settings.accepted.includes(m.id)) setLicense(m);
    else void s.download(m.id);
  };

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={s.settings.enabled} onChange={(e) => void s.setEnabled(e.target.checked)} />
        Enable machine translation
      </label>
      {!s.settings.enabled ? (
        <p className="text-xs text-gray-500">Runs on your computer. Nothing is downloaded until you turn this on and pick a model.</p>
      ) : (s.settings.provider ?? "local") !== "local" ? (
        <ProviderSettings />
      ) : (
        <>
          <ProviderSettings />
          {CATALOG.map((m) => (
            <ModelCard key={m.id} model={m} onDownload={start} />
          ))}
          <CustomCard />
          <div className="text-xs text-gray-600">Space used: {formatBytes(used)}</div>
          {session && <TestPanel session={session} />}
        </>
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
    </div>
  );
}
