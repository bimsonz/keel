import { Option, Schema } from "effect";
import { ProjectId } from "../../domain/kernel/index.ts";
import { projectRepos } from "./project-repos.ts";

/**
 * The repos in the core namespace that anyone may start a project from. The
 * namespace also holds every project's trunk, staging and guards, so a name is
 * a template only by being listed here.
 */
export const PROJECT_TEMPLATES: ReadonlySet<string> = new Set(["fixture-forge-lite"]);

/** A template, by its repo's name in the core namespace. */
export interface TemplateSource {
  readonly _tag: "Template";
  readonly repo: string;
}

/** Another project's trunk: a fork, which the policy decides on that project. */
export interface TrunkSource {
  readonly _tag: "Project";
  readonly projectId: ProjectId;
}

/** A name that is neither: nothing is forked from it. */
export interface UnknownSource {
  readonly _tag: "Unknown";
}

/** What a new project's trunk may be forked from. */
export type ProjectSource = TemplateSource | TrunkSource;

const decodeProjectId = Schema.decodeUnknownOption(ProjectId);
const UNKNOWN: UnknownSource = { _tag: "Unknown" };

/**
 * What the `source` of a new project names. A template is named by its repo.
 * A project is named by its trunk's repo, exactly as `projectRepos` spells it:
 * its staging and guards repos, a name with a namespace before it, the id
 * itself and the name in another case are all unknown, so no repo in the core
 * namespace is reached by guessing at its name.
 */
export const projectSource = (source: string): ProjectSource | UnknownSource => {
  if (PROJECT_TEMPLATES.has(source)) return { _tag: "Template", repo: source };
  // The project whose trunk this would be, if it is one: spelling its trunk again decides.
  const projectId = decodeProjectId(`prj_${source.slice("prj-".length).toUpperCase()}`);
  return Option.isSome(projectId) && projectRepos(projectId.value).trunk.name === source
    ? { _tag: "Project", projectId: projectId.value }
    : UNKNOWN;
};
