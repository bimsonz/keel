// What stands between a person and deleting their account, as Keel names it in refusing, and when the page
// offers the deletion at all. Keel deletes no project with an account and leaves no org without an owner: it
// refuses and names each, and the page shows what it named.

/** An org a person is the one owner of, as Keel's refusal names it. */
export interface OrgStanding {
  id: string;
  handle: string;
  /** The way forward Keel gave for this org, by its title, where it gave one. */
  next?: string;
}

/** What Keel named in refusing to delete an account. Every other refusal names nothing. */
export interface Standing {
  /** The projects in the person's own namespace, by name, in Keel's order. */
  projects: readonly string[];
  orgs: readonly OrgStanding[];
}

export const NOTHING: Standing = { projects: [], orgs: [] };

const field = (given: unknown, name: string): unknown =>
  typeof given === "object" && given !== null ? Reflect.get(given, name) : undefined;

/** The title of the next action Keel gave for one org: the one whose `args` name that org's id. */
function nextFor(actions: unknown, org: string): string | undefined {
  if (!Array.isArray(actions)) return undefined;
  const title = field(
    actions.find((action: unknown) => field(field(action, "args"), "organizationId") === org),
    "title",
  );
  return typeof title === "string" ? title : undefined;
}

/** Reads what a refusal named, from its body as it arrived. */
export function standingOf(refusal: {
  projects?: unknown;
  orgs?: unknown;
  nextActions?: unknown;
}): Standing {
  const projects = Array.isArray(refusal.projects)
    ? refusal.projects.filter((name: unknown) => typeof name === "string")
    : [];
  const orgs = Array.isArray(refusal.orgs)
    ? refusal.orgs.flatMap((org: unknown): OrgStanding[] => {
        const id = field(org, "id");
        const handle = field(org, "slug");
        if (typeof id !== "string" || typeof handle !== "string") return [];
        const next = nextFor(refusal.nextActions, id);
        return [{ id, handle, ...(next === undefined ? {} : { next }) }];
      })
    : [];
  return { projects, orgs };
}

/** Whether deleting an account is offered: to someone with a handle, once they have typed it. */
export function mayClose(who: { handle?: string | undefined }, typed: string): boolean {
  return who.handle !== undefined && typed === who.handle;
}
