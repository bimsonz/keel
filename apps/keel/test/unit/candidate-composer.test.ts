// What the GitCore composer asks gitcore to restack: identities, times and
// trailers come from the request alone, so a recompose gives the same SHAs.
import { CommitSha, Instant, makeId } from "@keeltown/core/kernel";
import type { CandidateRequest } from "@keeltown/core/ports";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restackSpec } from "../../src/adapters/driven/gitcore/candidate-composer.ts";

const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const AGENT = makeId("agt", "01J9ZZZZZZZZZZZZZZZZZZZZZA");
const CHANGE = makeId("chg", "01J9ZZZZZZZZZZZZZZZZZZZZZB");
const OTHER_AGENT = makeId("agt", "01J9ZZZZZZZZZZZZZZZZZZZZZC");
const OTHER_CHANGE = makeId("chg", "01J9ZZZZZZZZZZZZZZZZZZZZZD");
const CANDIDATE = makeId("cnd", "01J9ZZZZZZZZZZZZZZZZZZZZZE");
/** BatchFormed's time, 11 Oct 2026 09:00:00.250 UTC. */
const AT = Instant(1_791_709_200_250);
const AT_SECONDS = 1_791_709_200;

const REQUEST: CandidateRequest = {
  candidateId: CANDIDATE,
  staging: { namespace: "keel-core", name: "prj-staging" },
  base: sha("a"),
  at: AT,
  members: [
    {
      changeId: CHANGE,
      repo: { namespace: "keel-ws-00", name: "prj-ws-1" },
      base: sha("a"),
      head: sha("b"),
      author: AGENT,
      title: "Retry the webhook on 503",
    },
    {
      changeId: OTHER_CHANGE,
      repo: { namespace: "keel-ws-00", name: "prj-ws-2" },
      base: sha("c"),
      head: sha("d"),
      author: OTHER_AGENT,
      title: "Log the retry count",
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the GitCore composer's restack", () => {
  it("[composer.deterministic] takes every identity and time from the request, never the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
    const once = restackSpec(REQUEST);
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    expect(restackSpec(REQUEST)).toEqual(once);
    expect(once).toEqual({
      ref: `refs/heads/cand/${CANDIDATE}`,
      committer: { name: "Keel", email: "keel@keel.invalid", time: AT_SECONDS },
      members: [
        {
          base: sha("a"),
          head: sha("b"),
          author: { name: AGENT, email: `${AGENT}@agents.keel.invalid`, time: AT_SECONDS },
          message: "Retry the webhook on 503",
          trailers: [["Change-Id", CHANGE]],
        },
        {
          base: sha("c"),
          head: sha("d"),
          author: {
            name: OTHER_AGENT,
            email: `${OTHER_AGENT}@agents.keel.invalid`,
            time: AT_SECONDS,
          },
          message: "Log the retry count",
          trailers: [["Change-Id", OTHER_CHANGE]],
        },
      ],
    });
  });
});
