/** Answers live preview requests for the Figma plugin. */
import type { ProjectSession } from "../core/session";
import { buildPreviewBundle } from "./build";
import { parseResults } from "./format";
import { diffResults, type ResultsDiff } from "./results";

export interface LiveProject { id: string; name: string; session: ProjectSession }

export type LiveRequest =
  | { id: number; kind: "projects"; params: Record<string, string> }
  | { id: number; kind: "bundle"; params: { project: string; locale: string; includeReviewed?: string } }
  | { id: number; kind: "results"; params: { project: string }; body: unknown };

export interface LiveReply { status: number; body: unknown }

const missingProject = (): LiveReply => ({
  status: 404,
  body: { error: "That project isn't open in Retrans any more." },
});

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function answerLive(
  projects: LiveProject[],
  req: LiveRequest,
  onResults: (projectId: string, diff: ResultsDiff) => void,
): LiveReply {
  if (req.kind === "projects") {
    return {
      status: 200,
      body: projects
        .filter(({ session }) => session.workspace?.figma)
        .map(({ id, name, session }) => ({
          id,
          name,
          ...(session.state.project.id ? { projectId: session.state.project.id } : {}),
          baseLocale: session.data.baseLocale,
          locales: session.data.locales,
        })),
    };
  }

  const project = projects.find(({ id }) => id === req.params.project);
  if (!project) return missingProject();

  if (req.kind === "bundle") {
    try {
      const { bundle } = buildPreviewBundle(project.session, req.params.locale, {
        includeReviewed: req.params.includeReviewed === "true",
      });
      return { status: 200, body: bundle };
    } catch (error) {
      return { status: 422, body: { error: errorMessage(error) } };
    }
  }

  const parsed = parseResults(JSON.stringify(req.body));
  if (!parsed.ok) return { status: 422, body: { error: parsed.error } };
  const diff = diffResults(project.session, parsed.results, parsed.unreadable);
  if (!diff.ok) return { status: 422, body: { error: diff.error } };
  onResults(project.id, diff.diff);
  return { status: 202, body: {} };
}
