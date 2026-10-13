// Making a project: what a person asks Keel for. Keel starts a project one of
// four ways; the form at `/new` offers two, empty or from a public Git
// repository. A fork is asked for from its source's own address, where the
// same form names the source; the template kind is interim.
// Whether a name is free, whether a repository can be imported and who may
// make a project in a namespace are Keel's to say: nothing here decides them.

import type { CreateProjectRequest } from "../contract/keel/index.ts";

/** How the form says a project starts. `ref` is a branch, and blank for the repository's default. */
export type Start =
  | { kind: "empty" }
  | { kind: "import"; url: string; ref: string }
  /** A fork of the project Keel has under this id: Keel names a fork's source by its id, and by nothing else. */
  | { kind: "fork"; project: string };

/** What is sent to Keel: the owner, the name as typed with no space round it, and the start. */
export function requestOf(namespace: string, name: string, start: Start): CreateProjectRequest {
  const ref = start.kind === "import" ? start.ref.trim() : "";
  return {
    namespace,
    name: name.trim(),
    source:
      start.kind === "empty"
        ? { kind: "empty" }
        : start.kind === "fork"
          ? { kind: "fork", project: start.project }
          : { kind: "import", url: start.url.trim(), ...(ref === "" ? {} : { ref }) },
  };
}

/**
 * Whether there is enough to ask Keel with: an owner, a name, a repository where one is to be imported, and
 * the project where one is to be forked.
 */
export function ready(asked: CreateProjectRequest): boolean {
  return (
    asked.namespace !== "" &&
    asked.name !== "" &&
    (asked.source.kind !== "import" || asked.source.url !== "") &&
    (asked.source.kind !== "fork" || asked.source.project !== "")
  );
}

/**
 * The key an attempt is sent under. Asking again for the same thing sends the same key, so Keel finishes a
 * start that was cut short and never makes a second project; anything changed is another request, and Keel
 * refuses an old key used for one. The key is made of nothing that was typed.
 */
export function keys(
  fresh: () => string = () => crypto.randomUUID(),
): (asked: CreateProjectRequest) => string {
  let last: { asked: string; key: string } | undefined;
  return (asked) => {
    const said = JSON.stringify(asked);
    if (last?.asked !== said) last = { asked: said, key: `console:new:${fresh()}` };
    return last.key;
  };
}

/** Whose the new project may be: the person's own account first, then each org Keel lists them in. */
export function ownersOf(
  orgs: readonly { handle: string; name: string }[],
  who: { handle?: string | undefined },
): { handle: string; note: string }[] {
  return [
    ...(who.handle === undefined ? [] : [{ handle: who.handle, note: "you" }]),
    ...orgs.map((org) => ({ handle: org.handle, note: org.name })),
  ];
}
