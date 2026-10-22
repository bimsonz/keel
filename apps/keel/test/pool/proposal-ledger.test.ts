// A project's proposal ledger in its real Project DO, through the
// ProposalLedger port's adapter over the object's RPC: a change id reserved by
// a proposer's key, the cap on what one proposer has open, and a place freed
// by the proposal's end as the object's reaction hears it.
import { env } from "cloudflare:workers";
import { MAX_OPEN_PROPOSALS } from "@keeltown/core/application/coordination";
import {
  type ChangeId,
  EventEnvelope,
  Instant,
  makeId,
  type ProjectId,
  userActor,
} from "@keeltown/core/kernel";
import { ProposalLedger } from "@keeltown/core/ports";
import { PORTS } from "@keeltown/testing";
import { Cause, Effect, Exit, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { ProposalLedgerRpc } from "../../src/adapters/driven/do-rpc/proposal-ledger.ts";
import { drainAfter } from "./helpers.ts";

const projectStub = (projectId: ProjectId) =>
  drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));

const reserve = (projectId: ProjectId, proposer: ReturnType<typeof userActor>, key: string) =>
  Effect.runPromiseExit(
    Effect.flatMap(ProposalLedger, (ledger) =>
      ledger.reserve(projectId, { proposer, idempotencyKey: key, fingerprint: `body-${key}` }),
    ).pipe(Effect.provide(ProposalLedgerRpc((id) => projectStub(id)))),
  );

const reserved = (exit: Exit.Exit<ChangeId, unknown>): ChangeId => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
};

// The port's own suite, through the real object.
PORTS.ProposalLedger.contract("do-rpc", () => ProposalLedgerRpc((id) => projectStub(id)));

describe("a project's proposal ledger, in its object", () => {
  it("[proposals.ledger-do] reserves a proposal's change id per proposer and key across the object's RPC, refuses a sixth open one as ProposalLimit, and frees a place when its proposal ends", async () => {
    const projectId: ProjectId = makeId("prj", ulid());
    const ann = userActor(makeId("usr", ulid()));
    const ids: ChangeId[] = [];
    for (let n = 1; n <= MAX_OPEN_PROPOSALS; n += 1)
      ids.push(reserved(await reserve(projectId, ann, `k${n}`)));
    expect(reserved(await reserve(projectId, ann, "k1"))).toBe(ids[0]);
    const sixth = await reserve(projectId, ann, "k6");
    expect(Exit.isFailure(sixth) ? JSON.stringify(sixth.cause) : "reserved").toContain(
      '"_tag":"ProposalLimit"',
    );
    const withdrawn: EventEnvelope = {
      eventId: makeId("evt", ulid()),
      type: "ChangeWithdrawn",
      entity: { kind: "change", id: ids[0] ?? "" },
      seq: 9,
      at: Instant(Date.now()),
      dedupeKey: `withdrawn-${ids[0]}`,
      affected: [],
      notified: [`project:${projectId}`],
      payload: { _tag: "ChangeWithdrawn", changeId: ids[0], by: "usr_x" },
    };
    await projectStub(projectId).receive([Schema.encodeSync(EventEnvelope)(withdrawn)]);
    expect(ids).not.toContain(reserved(await reserve(projectId, ann, "k6")));
  });
});
