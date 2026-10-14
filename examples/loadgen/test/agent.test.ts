import { KeelProblem, KeelTokenError } from "@keeltown/sdk";
import { describe, expect, it } from "vitest";
import { retryIn } from "../src/agent.ts";

const problem = (status: number, code: string, retryAfterMs?: number) =>
  new KeelProblem({
    type: `urn:keel:problem:${code}`,
    title: code,
    status,
    code,
    requestId: "req_test",
    nextActions: [],
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

describe("a synthetic agent's patience", () => {
  it("[loadgen.agent-retry] waits as Keel asks for a pool still forking, the limit and a server fault, and takes any other refusal as the answer", () => {
    expect({
      pool: retryIn(problem(503, "workspace.pool_exhausted", 15_000), 40),
      poolUntold: retryIn(problem(503, "workspace.pool_exhausted"), 0),
      limited: retryIn(problem(429, "rate_limited"), 0),
      limitedTold: retryIn(problem(429, "rate_limited", 7_000), 0),
      fault: retryIn(problem(500, "internal"), 1),
      faultFifth: retryIn(problem(500, "internal"), 5),
      refused: retryIn(problem(409, "workspace.head_moved"), 0),
      notFound: retryIn(problem(404, "resource.not_found"), 0),
      tokenLimited: retryIn(new KeelTokenError("rate_limited", 429), 0),
      tokenRefused: retryIn(new KeelTokenError("invalid_client", 401), 0),
      unreached: retryIn(new TypeError("fetch failed"), 0),
      unreachedFifth: retryIn(new TypeError("fetch failed"), 5),
      other: retryIn(new Error("anything else"), 0),
    }).toEqual({
      pool: 15_000,
      poolUntold: 5_000,
      limited: 60_000,
      limitedTold: 7_000,
      fault: 4_000,
      faultFifth: undefined,
      refused: undefined,
      notFound: undefined,
      tokenLimited: 1_000,
      tokenRefused: undefined,
      unreached: 3_000,
      unreachedFifth: undefined,
      other: undefined,
    });
  });
});
