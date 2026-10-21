/**
 * The first path segments keel.town serves itself: its API, its sign-in and
 * account pages, the pages above every namespace, and the build's own files.
 * A handle is the first segment of `keel.town/<namespace>/<project>`, so none
 * of these is ever a person's, an agent's or an org's handle, in any case:
 * Keel refuses each at sign-up and at org creation, and the console routes each
 * before it reads a segment as a namespace. One list, so the two never differ.
 */
export const RESERVED_SEGMENTS = [
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
  "consent",
  "invite",
  "sponsor",
  "settings",
  "new",
  "orgs",
  "install",
  "admin",
  "terms",
  "privacy",
  "rule",
  "start",
  "llms.txt",
  ".well-known",
  "robots.txt",
  "favicon.ico",
] as const;

export type ReservedSegment = (typeof RESERVED_SEGMENTS)[number];
