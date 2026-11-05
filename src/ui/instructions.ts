import type { ProjectSession } from "../core/session";
import { combineInstructions } from "../mt/cloud-prompt";
import { useMt } from "./mt-store";

/** Custom instructions for a target language: all projects, then this project, then this language. */
export function instructionsFor(session: ProjectSession): (locale: string) => string {
  const global = useMt.getState().settings.instructions;
  const project = session.state.project.instructions;
  return (locale) => combineInstructions(global, project?.all, project?.byLocale?.[locale]);
}
