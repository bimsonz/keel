// A change read by id through the deployed fetch handler: the change is a real
// Change DO (on in-memory code and pool) read for itself and its project, and
// whether that project is public is its real Project DO's setting.
import { LEASE_TTL_MS, Proposition } from "@keeltown/core/domain/coordination";
import { makeId, type ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { changeUnderTest, ok } from "./change-harness.ts";
import {
  BASE,
  drainOutbox,
  seedAgent,
  seedForeignAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";
import { project } from "./project-harness.ts";

const WAIT = { timeout: 10_000, interval: 50 };

const decodeProposition = Schema.decodeUnknownSync(Proposition);
const relied = decodeProposition({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
});
const caused = decodeProposition({
  subject: "authz.session-cache",
  predicate: "freshness",
  relation: "is",
  value: "per-session",
});

interface ChangeBody {
  readonly id: string;
  readonly agentId: string;
  readonly state: string;
  readonly revision: number;
  readonly goal: string;
  readonly premises: readonly { readonly subject: string; readonly value: unknown }[];
  readonly declaredEffects?: readonly { readonly subject: string; readonly value: unknown }[];
  readonly commitSha?: string;
  readonly lease?: { readonly id: string; readonly renewedAt: string; readonly lapsesAt?: string };
}

/** GET /v1/changes/{id} through the doorway, with a bearer token or with none. */
const read = (changeId: string, token?: string) =>
  worker(
    `${BASE}/v1/changes/${changeId}`,
    token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
  );

/** A 404's body as any caller sees it: its request id dropped and the id it was asked for blanked. */
const notFound = async (response: Response, changeId: string) => {
  expect(response.status).toBe(404);
  const { requestId: _, ...body } = await response.json<Record<string, unknown>>();
  return JSON.parse(JSON.stringify(body).replaceAll(changeId, "<id>"));
};

/** A change declared in `projectId` by an agent enrolled there, with that agent's token. */
async function declaredIn(projectId: ProjectId) {
  const c = await changeUnderTest(projectId);
  ok(await c.declare("declare-1", { premises: [relied], declaredEffects: [caused] }));
  await drainOutbox(c.stub);
  const member = await tokenFor(await seedAgent({ id: c.agentId, projectId }));
  return { c, member };
}

describe("[b12.get-change] a change by id, from its own DO", () => {
  it("[b12.get-change] answers the change its agent declared, with its premises and declared effects, then the commit it submitted", async () => {
    const { projectId } = await project();
    const { c, member } = await declaredIn(projectId);
    const declared = await read(c.changeId, member);
    expect(declared.status).toBe(200);
    const body = await declared.json<ChangeBody>();
    expect(body).toMatchObject({
      id: c.changeId,
      agentId: c.agentId,
      state: "working",
      revision: 1,
      goal: "Cache permission lookups per request",
    });
    expect(body.premises.map((p) => [p.subject, p.value])).toEqual([
      ["authz.permission-evaluation", "per-request"],
    ]);
    expect(body.declaredEffects?.map((p) => [p.subject, p.value])).toEqual([
      ["authz.session-cache", "per-session"],
    ]);
    expect(body.commitSha).toBeUndefined();

    // The submission starts a real Precheck; held inert, it never reaches a code host.
    await using precheck = await inertPrecheck();
    const commitSha = await c.push();
    const lease = (await c.current()).lease.id;
    ok(
      decodeExit(
        ChangeCodecs.submit,
        await c.stub.submit({
          agentId: c.agentId,
          projectId: c.projectId,
          leaseId: lease,
          commitSha,
          idempotencyKey: "submit-1",
        }),
      ),
    );
    const submitted = await (await read(c.changeId, member)).json<ChangeBody>();
    expect(submitted).toMatchObject({ state: "submitted", commitSha });
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });

  it("[b12.get-change] answers 404 change.not_found for a change that was never declared, and 400 for an id that is not one", async () => {
    const member = (await seedUser(uniqueHandle("member"))).token;
    const missing = makeId("chg", ulid());
    const response = await read(missing, member);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "change.not_found" });
    expect((await read("not-a-change", member)).status).toBe(400);
  });
});

describe("[b12.held-lease] the lease, read back by the agent holding it", () => {
  it("[b12.held-lease] its own agent reads the active lease and when it lapses, and while the platform holds the change no lapse time; a member of its org, another agent and a visitor read no lease", async () => {
    const p = await project();
    const { c, member } = await declaredIn(p.projectId);
    const user = (await seedUser(uniqueHandle("member"))).token;
    const { lease } = await c.current();
    const own = await (await read(c.changeId, member)).json<ChangeBody>();
    expect(own.lease).toEqual({
      id: lease.id,
      renewedAt: new Date(lease.renewedAt).toISOString(),
      lapsesAt: new Date(lease.renewedAt + LEASE_TTL_MS).toISOString(),
    });
    expect((await (await read(c.changeId, user)).json<ChangeBody>()).lease).toBeUndefined();

    await using precheck = await inertPrecheck();
    const commitSha = await c.push();
    ok(
      decodeExit(
        ChangeCodecs.submit,
        await c.stub.submit({
          agentId: c.agentId,
          projectId: c.projectId,
          leaseId: lease.id,
          commitSha,
          idempotencyKey: "submit-1",
        }),
      ),
    );
    const held = await (await read(c.changeId, member)).json<ChangeBody>();
    expect(held).toMatchObject({ state: "submitted" });
    expect(held.lease?.id).toBe(lease.id);
    expect(held.lease?.lapsesAt).toBeUndefined();

    await p.open();
    const outsider = await tokenFor(await seedAgent());
    expect((await (await read(c.changeId, outsider)).json<ChangeBody>()).lease).toBeUndefined();
    expect((await (await read(c.changeId)).json<ChangeBody>()).lease).toBeUndefined();
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });
});

describe("[b12.get-change-audience] who reads a change by id", () => {
  it("[b12.get-change-audience] a private project's change: its agent and a member of its org read it; another project's agent of the org is refused by name; another org's agent and a caller without a token get the 404 of a change that does not exist", async () => {
    const { projectId } = await project();
    const { c, member } = await declaredIn(projectId);
    const user = (await seedUser(uniqueHandle("member"))).token;
    const sibling = await tokenFor(await seedAgent());
    const outsider = await tokenFor(await seedForeignAgent());
    expect((await read(c.changeId, member)).status).toBe(200);
    expect((await read(c.changeId, user)).status).toBe(200);
    const refused = await read(c.changeId, sibling);
    expect([refused.status, (await refused.json<{ detail: string }>()).detail]).toEqual([
      403,
      "Refused: foreign-project.",
    ]);

    const missing = makeId("chg", ulid());
    const unknown = await notFound(await read(missing, outsider), missing);
    expect(unknown).toMatchObject({ code: "change.not_found" });
    expect(await notFound(await read(c.changeId, outsider), c.changeId)).toEqual(unknown);
    expect(await notFound(await read(c.changeId), c.changeId)).toEqual(
      await notFound(await read(missing), missing),
    );
  });

  it("[b12.get-change-audience] a public project's change: another project's agent and a caller without a token read it", async () => {
    const p = await project();
    const { c } = await declaredIn(p.projectId);
    const outsider = await tokenFor(await seedAgent());
    expect((await read(c.changeId)).status).toBe(404);
    await p.open();
    const anonymous = await read(c.changeId);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json<ChangeBody>()).toMatchObject({ id: c.changeId, state: "working" });
    expect((await read(c.changeId, outsider)).status).toBe(200);
  });
});
