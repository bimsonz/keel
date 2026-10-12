import { Context, type Effect, type Option } from "effect";
import type { OrgId } from "../../domain/kernel/index.ts";

/** An org as the policy reads it: its name is the first segment of `/<org>/<project>`. */
export interface OrgRecord {
  readonly org: OrgId;
  readonly name: string;
  /** Suspended by whoever runs the instance. */
  readonly suspended: boolean;
}

/**
 * Orgs by id or by name. Better Auth owns them: an org is its `organization`
 * row in D1, its name the row's slug, held lower-case, so a name is found in
 * any case.
 */
export class Orgs extends Context.Service<
  Orgs,
  {
    readonly byId: (org: OrgId) => Effect.Effect<Option.Option<OrgRecord>>;
    readonly byName: (name: string) => Effect.Effect<Option.Option<OrgRecord>>;
  }
>()("keel/Orgs") {}
