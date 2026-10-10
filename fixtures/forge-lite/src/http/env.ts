import type { Deps } from "../deps.ts";
import type { Role } from "../domain/roles.ts";
import type { RepoRecord, SessionRecord, UserRecord } from "../store/types.ts";

export interface AppVariables {
  /** Set for every request by createApp. */
  deps: Deps;
  /** Set by authenticate when the request carries a valid bearer token. */
  session: SessionRecord | undefined;
  user: UserRecord | undefined;
  /** Set by requirePermission, so only present on routes it guards. */
  repo: RepoRecord;
  role: Role | null;
}

export interface AppEnv {
  Variables: AppVariables;
}
