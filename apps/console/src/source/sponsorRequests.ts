// The agents asking the signed-in person to sponsor them, and the person's answer to each: Keel's own list of
// them (`GET /v1/users/me/sponsor-requests`, oldest first) and its two moves on one, approve and decline. Keel
// takes an approval only from a passkey sign-in of the last ten minutes; a decline from any session.

import type {
  PendingSponsorRequest,
  PendingSponsorRequests,
  Users_approveSponsorRequestInput,
  Users_declineSponsorRequestInput,
} from "../contract/keel/index.ts";
import { type HttpOptions, answered, refusalOf } from "./http.ts";

export interface KeelSponsorRequests {
  /** The requests waiting for the reader, oldest first. A request lapses after seven days and is then not listed. */
  list(signal?: AbortSignal): Promise<PendingSponsorRequest[]>;
  /** Sponsors the agent whose request waits. `key` is the attempt's own. */
  approve(agentId: string, key: string): Promise<void>;
  /** Declines the agent's request; with `block`, it may not ask the reader again until they unblock it. */
  decline(agentId: string, block: boolean, key: string): Promise<void>;
}

const MINE = "/v1/users/me/sponsor-requests";

export function createHttpSponsorRequests(options: HttpOptions = {}): KeelSponsorRequests {
  const origin = options.origin ?? "";
  // The page's fetch is looked up at each call, so a test's stand-in that arrives later is read through too.
  const request = (path: string, init: RequestInit): Promise<Response> =>
    (options.fetch ?? fetch)(`${origin}${path}`, init);
  return {
    async list(signal) {
      const response = await request(MINE, {
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw await refusalOf(response);
      return (await answered<Partial<PendingSponsorRequests>>(response)).items ?? [];
    },
    async approve(agentId, key) {
      const { agentId: named, "idempotency-key": attempt }: Users_approveSponsorRequestInput = {
        agentId,
        "idempotency-key": key,
      };
      const response = await request(`${MINE}/${encodeURIComponent(named)}`, {
        method: "PUT",
        headers: { "idempotency-key": attempt },
      });
      if (!response.ok) throw await refusalOf(response);
    },
    async decline(agentId, block, key) {
      const {
        agentId: named,
        block: blocking,
        "idempotency-key": attempt,
      }: Users_declineSponsorRequestInput = { agentId, block, "idempotency-key": key };
      const query = blocking ? "?block=true" : "";
      const response = await request(`${MINE}/${encodeURIComponent(named)}${query}`, {
        method: "DELETE",
        headers: { "idempotency-key": attempt },
      });
      if (!response.ok) throw await refusalOf(response);
    },
  };
}
