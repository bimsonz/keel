/**
 * The one namespace of handles and org names: every user's handle is also its
 * personal org's slug, so an org and a user can never share a name, as on
 * GitHub. A name is one segment of `keel.town/<org>/<project>`, which is why
 * the paths the site serves itself are reserved.
 */

/** Paths keel.town serves at its root, refused as a handle or an org name in any case. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "api",
  "v1",
  "mcp",
  "auth",
  "assets",
  "healthz",
  "login",
  "signup",
  "logout",
  "device",
  "invite",
  "settings",
  "new",
  "orgs",
  "install",
  "admin",
  "terms",
  "privacy",
  "rule",
  ".well-known",
  "robots.txt",
  "favicon.ico",
  "start",
  "llms.txt",
]);

/** Lower-case letters and digits, single hyphens between them, at most 39 characters. */
export const HANDLE = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;

/** Why `name` can't be a handle or an org name, or undefined when it can. Case never matters. */
export function nameRefusal(name: string): string | undefined {
  const lowered = name.toLowerCase();
  if (RESERVED_NAMES.has(lowered))
    return `"${name}" is reserved: keel.town serves /${lowered} itself`;
  if (!HANDLE.test(lowered))
    return `"${name}" must be letters, digits and single hyphens, starting and ending with a letter or digit, at most 39 characters`;
  return undefined;
}
