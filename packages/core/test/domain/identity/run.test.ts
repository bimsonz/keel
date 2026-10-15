import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Agent,
  agentIdOf,
  givenHandle,
  KeyThumbprint,
  runClaims,
  runIdOf,
} from "../../../src/domain/identity/index.ts";
import { Instant, makeId, RunId, RunLabel } from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const thumbprint = Schema.decodeUnknownSync(KeyThumbprint);
const label = Schema.decodeUnknownSync(RunLabel);
const isRunId = Schema.is(RunId);
const isLabel = Schema.is(RunLabel);

const ACCOUNT_KEY = thumbprint("A".repeat(43));
const RUN_KEY = thumbprint("R".repeat(43));
const OTHER_RUN_KEY = thumbprint("S".repeat(43));
const AGENT_ID = agentIdOf(ACCOUNT_KEY);
const PROJECT = makeId("prj", "0".repeat(26));

const agent: Agent = {
  id: AGENT_ID,
  handle: givenHandle(AGENT_ID),
  name: "builder",
  scopes: ["agent:work", "agent:read"],
  keys: [
    {
      jkt: ACCOUNT_KEY,
      jwk: { kty: "OKP", crv: "Ed25519", x: "x".repeat(43) },
      addedAt: Instant(1_760_000_000_000),
    },
  ],
  state: "active",
  revocationEpoch: 3,
  createdAt: Instant(1_760_000_000_000),
};

const claims = (request: Parameters<typeof runClaims>[1]) =>
  Result.getOrThrow(runClaims(agent, request));
const refusal = (request: Parameters<typeof runClaims>[1]) =>
  Result.match(runClaims(agent, request), {
    onSuccess: () => "granted",
    onFailure: (error) => error._tag,
  });

/** What an agent may call a run: lower-case words joined by `-`, `_` or `.`. */
const labelArb = fc
  .stringMatching(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .filter((text) => isLabel(text))
  .map((text) => label(text));

/** Whether an agent in `state` is given a token's claims, or the refusal's tag. */
const outcome = (state: "active" | "suspended" | "revoked") =>
  Result.match(runClaims({ ...agent, state }, { runKey: RUN_KEY }), {
    onSuccess: () => "granted",
    onFailure: (error) => error._tag,
  });

describe("what a token says of its run", () => {
  it("[token.run] a labelled run keeps its id whatever key asks, and another label or another agent is another run", () => {
    fc.assert(
      fc.property(labelArb, labelArb, (one, other) => {
        const id = runIdOf(AGENT_ID, { label: one, runKey: RUN_KEY });
        expect(isRunId(id)).toBe(true);
        expect(runIdOf(AGENT_ID, { label: one, runKey: OTHER_RUN_KEY })).toBe(id);
        expect(runIdOf(AGENT_ID, { label: one })).toBe(id);
        expect(runIdOf(agentIdOf(RUN_KEY), { label: one })).not.toBe(id);
        fc.pre(one !== other);
        expect(runIdOf(AGENT_ID, { label: other })).not.toBe(id);
      }),
    );
  });

  it("[token.run] a run with no label is its key's: the same key the same run, another key another", () => {
    const byKey = runIdOf(AGENT_ID, { runKey: RUN_KEY });
    expect(isRunId(byKey)).toBe(true);
    expect(runIdOf(AGENT_ID, { runKey: RUN_KEY })).toBe(byKey);
    expect(runIdOf(AGENT_ID, { runKey: OTHER_RUN_KEY })).not.toBe(byKey);
    // A label that spells a key's thumbprint is still a label: the two are never one run.
    const spelt = "r".repeat(43);
    expect(runIdOf(AGENT_ID, { label: label(spelt) })).not.toBe(
      runIdOf(AGENT_ID, { runKey: thumbprint(spelt) }),
    );
  });

  it("[token.run] the claims name the run, its label, the agent's epoch and its handle, and a project only when one is asked for", () => {
    expect(claims({ run: "run-c", runKey: RUN_KEY, project: PROJECT })).toEqual({
      epoch: 3,
      handle: agent.handle,
      prj: PROJECT,
      run: { id: runIdOf(AGENT_ID, { label: label("run-c") }), label: "run-c" },
    });
    expect(claims({ runKey: RUN_KEY })).toEqual({
      epoch: 3,
      handle: agent.handle,
      run: { id: runIdOf(AGENT_ID, { runKey: RUN_KEY }) },
    });
    // A plain bearer that names no run is of no run.
    expect(claims({})).toEqual({ epoch: 3, handle: agent.handle });
  });

  it("[token.run] a label Keel cannot show as one word is refused", () => {
    for (const bad of ["", "Run-C", "run c", "-run", "a".repeat(65), "run/c", "rün"])
      expect(refusal({ run: bad, runKey: RUN_KEY })).toBe("RunLabelRefused");
  });

  it("[token.target] a project named by anything but a project id is refused, and no project is looked up", () => {
    for (const bad of ["", "keel", "prj_", "agt_00000000000000000000000000", `${PROJECT}x`])
      expect(refusal({ project: bad, runKey: RUN_KEY })).toBe("TargetRefused");
    expect(refusal({ project: PROJECT, runKey: RUN_KEY })).toBe("granted");
  });

  it("[token.run-key-apart] a token is never bound to one of the account's own keys", () => {
    expect(refusal({ runKey: ACCOUNT_KEY })).toBe("RunKeyRefused");
    expect(refusal({ run: "run-c", runKey: ACCOUNT_KEY })).toBe("RunKeyRefused");
    expect(refusal({ runKey: RUN_KEY })).toBe("granted");
  });

  it("[token.standing] a revoked agent is given no claims, and a paused one is, to read who it is and its inbox", () => {
    expect(outcome("revoked")).toBe("AgentNotAdmitted");
    expect(outcome("suspended")).toBe("granted");
    expect(outcome("active")).toBe("granted");
  });
});
