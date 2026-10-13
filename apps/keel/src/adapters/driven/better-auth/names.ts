import { RESERVED_SEGMENTS } from "@keeltown/contracts";

/**
 * The one space of handles: a person's, an agent's and an org's are unique
 * across all three (the `namespaces` table holds that), as on GitHub. A handle
 * is the first segment of `keel.town/<namespace>/<project>`, which is why the
 * segments the site serves itself are reserved.
 */

/** The segments keel.town serves at its root, refused as a handle in any case: the contract's one list. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(RESERVED_SEGMENTS);

/** Lower-case letters and digits, single hyphens between them, at most 39 characters. */
export const HANDLE = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;

/** Why `name` can't be a handle, or undefined when it can. Case never matters. */
export function nameRefusal(name: string): string | undefined {
  const lowered = name.toLowerCase();
  if (RESERVED_NAMES.has(lowered)) return `"${name}" is reserved`;
  if (!HANDLE.test(lowered))
    return `"${name}" must be letters, digits and single hyphens, starting and ending with a letter or digit, at most 39 characters`;
  return undefined;
}
