// A submission while the namespace of its project has its verification spend
// stopped, through the real doorway, gate and Change DO: refused at the door,
// with what its owner does next, and taken once the namespace is resumed.
import { heldLease } from "@keeltown/testing";
import { env } from "cloudflare:workers";
import { makeId, NamespaceId, UserId } from "@keeltown/core/kernel";
import { NamespaceUsage } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { NamespaceUsageRpc } from "../../src/adapters/driven/do-rpc/namespace-usage.ts";
import { changeUnderTest, ok } from "./change-harness.ts";
import {
  BASE,
  placeProject,
  seedAgent,
  seedOrg,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";

const halt = (namespace: NamespaceId, halted: boolean) =>
  Effect.runPromise(
    NamespaceUsage.use((usage) => usage.configure(namespace, { overrides: {}, halted })).pipe(
      Effect.provide(NamespaceUsageRpc(env.NAMESPACE_USAGE)),
    ),
  );

describe("[submit.halted] a submission while its namespace's verification spend is stopped", () => {
  it("[submit.halted] is 403 namespace.halted, telling its owner to ask for a resume and submit again, and submits nothing; once resumed the same change is submitted", async () => {
    // An org of its own, so halting it stops nothing else in the file.
    const org = Schema.decodeSync(NamespaceId)(makeId("org", ulid()));
    const owner = Schema.decodeSync(UserId)(makeId("usr", ulid()));
    await seedOrg(org, uniqueHandle("halted"), owner, uniqueHandle("halted-owner"));
    const projectId = makeId("prj", ulid());
    await placeProject(projectId, org);
    const c = await changeUnderTest(projectId, "memory", false);
    const lease = heldLease(ok(await c.declare()).change).id;
    const sha = await c.push();
    const token = await tokenFor(
      await seedAgent({ projectId, id: c.agentId, org, sponsor: owner }),
    );
    const submit = async (key: string) => {
      const response = await worker(`${BASE}/v1/submissions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "keel-lease": lease,
          "idempotency-key": key,
          "content-type": "application/json",
        },
        body: JSON.stringify({ changeId: c.changeId, commitSha: sha }),
      });
      return { status: response.status, body: await response.json<Record<string, unknown>>() };
    };

    await halt(org, true);
    const refused = await submit("submit-halted-1");
    const held = {
      log: (await c.log()).map((event) => event.type),
      state: (await c.current()).state,
    };
    await halt(org, false);
    const taken = await submit("submit-resumed-1");

    expect(refused).toMatchObject({
      status: 403,
      body: {
        code: "namespace.halted",
        nextActions: [
          { kind: "escalate", title: expect.stringContaining(org) },
          { kind: "call", operationId: "submit" },
        ],
      },
    });
    expect(held.state).toBe("working");
    expect(held.log).not.toContain("ChangeSubmitted");
    expect(taken.status).toBe(202);
  });
});
