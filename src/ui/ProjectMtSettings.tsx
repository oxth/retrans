import type { ProjectSession } from "../core/session";
import { PROVIDER_LABELS } from "../mt/translator";
import type { ProviderId } from "../platform/prefs";
import { inputCls } from "./Dialog";
import { fieldBase, Group, Row, SectionLink, useSaveNote } from "./settings-ui";
import { languageWithCode } from "./locales";
import { useMt } from "./mt-store";
import { useSessionVersion } from "./store";

/** Project Settings → Translation: this project's provider (overrides the app-wide one). */
export function ProjectMtSettings({ session }: { session: ProjectSession }) {
  useSessionVersion();
  const global = useMt((s) => s.settings.provider);
  const override = session.state.project.mtProvider ?? "";
  const instr = session.state.project.instructions ?? {};
  const targets = session.displayLocales().filter((l) => l !== session.data.baseLocale);
  const provider = useSaveNote();
  const instructions = useSaveNote();
  const saveInstr = (patch: { all?: string; locale?: [string, string] }) => {
    const cur = session.state.project.instructions ?? {};
    const byLocale = { ...(cur.byLocale ?? {}) };
    if (patch.locale) {
      if (patch.locale[1]) byLocale[patch.locale[0]] = patch.locale[1];
      else delete byLocale[patch.locale[0]];
    }
    const all = "all" in patch ? patch.all : cur.all;
    session.setProjectSetting({
      instructions: { ...(all ? { all } : {}), ...(Object.keys(byLocale).length ? { byLocale } : {}) },
    });
  };
  return (
    <>
      <Group
        label="Provider"
        footer={provider.footer ?? (
          <>Stored in .retrans/state.json, so everyone on the project uses the same provider. Keys and models are set in <SectionLink to="mt">Machine translation</SectionLink>.</>
        )}
      >
        <Row label="Translation provider" hint="Overrides the app setting for this project only." htmlFor="project-provider">
          <select
            id="project-provider"
            aria-label="Translation provider for this project"
            className={`${fieldBase} w-80`}
            value={override}
            onChange={(e) => {
              const v = e.target.value || undefined;
              provider.trackProject(() => session.setProjectSetting({ mtProvider: v }));
            }}
          >
            <option value="">App setting: {PROVIDER_LABELS[global as ProviderId] ?? PROVIDER_LABELS.local}</option>
            {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((p) => (
              <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
            ))}
          </select>
        </Row>
      </Group>
      <Group
        label="Instructions"
        footer={instructions.footer ?? (
          <>Added after the instructions for all projects (<SectionLink to="instructions">AI instructions</SectionLink>), in that order. Stored in .retrans/state.json and shared through git.</>
        )}
      >
        <Row stacked label="For this project" hint="Tone, terminology, words to keep in the original language." htmlFor="instr-all">
          <textarea
            id="instr-all"
            aria-label="Instructions for this project"
            className={`${inputCls} resize-y`}
            rows={3}
            placeholder="e.g. Formal Thai. Keep [Product Name] in English."
            defaultValue={instr.all ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (instr.all ?? "")) instructions.trackProject(() => saveInstr({ all: v }));
            }}
          />
        </Row>
        {targets.map((l) => (
          <Row key={l} stacked label={`For ${languageWithCode(l)}`} htmlFor={`instr-${l}`}>
            <textarea
              id={`instr-${l}`}
              aria-label={`Instructions for ${l}`}
              className={`${inputCls} resize-y`}
              rows={2}
              defaultValue={instr.byLocale?.[l] ?? ""}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (instr.byLocale?.[l] ?? "")) instructions.trackProject(() => saveInstr({ locale: [l, v] }));
              }}
            />
          </Row>
        ))}
      </Group>
    </>
  );
}
