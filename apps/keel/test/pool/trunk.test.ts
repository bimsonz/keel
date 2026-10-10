// The Trunk DO in workerd, through its RPC and the Exit envelope.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeId } from "@keeltown/core/kernel";
import { Exit } from "effect";
import { ulid } from "ulid";
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
});
