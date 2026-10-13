import { Schema } from "effect";

/**
 * A user's handle, an agent's or an org's name: one segment of
 * `/<org>/<project>`, unique per instance across all of them, as on GitHub.
 * Lower-case letters and digits with single hyphens between them, at most 39
 * characters. The reserved names are kept in `names.ts`; this is only the
 * shape.
 */
export const Handle = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:-?[a-z0-9]){0,38}$/));
export type Handle = typeof Handle.Type;
