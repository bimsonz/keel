// The Trunk DO in workerd, through its RPC and the Exit envelope.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CommitSha, makeId } from "@keeltown/core/kernel";
import { Trunks } from "@keeltown/core/ports";
import { Effect, Exit, Schema } from "effect";
import { ulid } from "ulid";
import { TrunksRpc } from "../../src/adapters/driven/do-rpc/trunks.ts";
import { decodeExit, TrunkCodecs } from "../../src/rpc/index.ts";

const trunkStub = (projectId: string) => env.TRUNK.get(env.TRUNK.idFromName(`trunk:${projectId}`));

describe("the Trunk DO", () => {
  it("[trunk.do.init] initialize names trunk's first head once; a retry answers it, another head is refused", async () => {
    const stub = trunkStub(makeId("prj", ulid()));
    const head = "a".repeat(40);
    const first = decodeExit(TrunkCodecs.initialize, await stub.initialize(head, "seed"));
    expect(first).toEqual(Exit.succeed({ head, promotion: "idle", redCount: 0 }));
    const again = decodeExit(TrunkCodecs.initialize, await stub.initialize(head, "seed"));
    expect(again).toEqual(first);
    const other = decodeExit(TrunkCodecs.initialize, await stub.initialize("b".repeat(40), "seed"));
    expect(Exit.isFailure(other) ? JSON.stringify(other.cause) : "succeeded").toContain(
      "PromotionStateRefused",
    );
  });

  it("[trunks.rpc.initialize] the Trunks port reaches trunk:<projectId>: a retry is a no-op, another head is refused", async () => {
    const projectId = makeId("prj", ulid());
    const head = Schema.decodeUnknownSync(CommitSha)("c".repeat(40));
    const run = <A, E>(program: Effect.Effect<A, E, Trunks>) =>
      Effect.runPromiseExit(program.pipe(Effect.provide(TrunksRpc(env.TRUNK))));
    const initialize = (sha: CommitSha) =>
      run(Effect.flatMap(Trunks, (trunks) => trunks.initialize(projectId, sha, "seed")));
    expect(await initialize(head)).toEqual(Exit.void);
    expect(await initialize(head)).toEqual(Exit.void);
    const other = await initialize(Schema.decodeUnknownSync(CommitSha)("d".repeat(40)));
    expect(Exit.isFailure(other) ? JSON.stringify(other.cause) : "succeeded").toContain(
      "PromotionStateRefused",
    );
    const trunk = decodeExit(
      TrunkCodecs.initialize,
      await trunkStub(projectId).initialize(head, "seed"),
    );
    expect(trunk).toEqual(Exit.succeed({ head, promotion: "idle", redCount: 0 }));
  });
});
