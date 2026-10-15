import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AccessRefused,
  ACTIONS,
  type AgentPrincipal,
  NotVisible,
  runIdOf,
  SPEC_ACTIONS,
} from "@keeltown/core/domain/identity";
import { makeId, RunLabel } from "@keeltown/core/kernel";
import {
  makeAgentDirectoryMemory,
  makeBetterAuthMemory,
  makeChangesMemory,
  makeNamespacesMemory,
  makeProjectNamespacesMemory,
  makeProjectsMemory,
  sampleOrgId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  authorizeHandlers,
  RESOLVERS,
  standingRefusal,
} from "../../src/adapters/driving/http/authorize-handlers.ts";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import type { Runner } from "../../src/adapters/driving/http/run.ts";
import type { Operations } from "../../src/generated/http/app.gen.ts";

const layer = Layer.mergeAll(
  makeProjectNamespacesMemory().layer,
  makeNamespacesMemory().layer,
  makeProjectsMemory().layer,
  makeChangesMemory().layer,
  makeAgentDirectoryMemory().layer,
);
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-arguments, typescript/no-unnecessary-type-assertion -- test doubles of the wrapper's
   generic tables: a recording handler per operation name and a runner over memory adapters */
const run = ((_caller: Caller, effect: Effect.Effect<unknown, never, never>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<unknown>)) as Runner;

const anonymous: Caller = {
  requestId: "req-authz-total",
  principal: { _tag: "Anonymous" },
  signal: new AbortController().signal,
};

/** Inputs that name things no store holds: every resource resolves missing. */
const NOWHERE = {
  projectId: "prj_0NWHERE000000000000000000Z",
  changeId: "chg_0NWHERE000000000000000000Z",
  agentId: "agt_0NWHERE000000000000000000Z",
  project: "prj_0NWHERE000000000000000000Z",
  org: "nowhere",
  name: "nowhere",
};

describe("authorizeHandlers", () => {
  it("[authz.total] every operation in the spec has a resolver and reaches its handler only past the policy", async () => {
    const operations = Object.keys(SPEC_ACTIONS).toSorted();
    expect(Object.keys(RESOLVERS).toSorted()).toEqual(operations);
    const reached: string[] = [];
    const recording = Object.fromEntries(
      operations.map((operation) => [
        operation,
        () => {
          reached.push(operation);
          return { status: 200, body: {} };
        },
      ]),
    ) as unknown as Operations<Caller>;
    const wrapped = authorizeHandlers(recording, RESOLVERS, run) as unknown as Record<
      string,
      (caller: Caller, input: unknown) => Promise<{ status: number }>
    >;
    const statuses: Record<string, number> = {};
    for (const operation of operations) {
      const handler = wrapped[operation];
      if (handler === undefined) throw new Error(`${operation} is not in the wrapped object`);
      statuses[operation] = (await handler(anonymous, NOWHERE)).status;
    }
    // Anonymous reaches only what anyone may call, and the list the policy decides item by item.
    const open = operations.filter(
      (operation) => ACTIONS[operation as keyof typeof ACTIONS].need === "anyone",
    );
    expect(reached.toSorted()).toEqual([...open, "Operator_listProjects"].toSorted());
    for (const operation of operations.filter((o) => !reached.includes(o)))
      expect([401, 404]).toContain(statuses[operation]);
  });
});

const AGENT = makeId("agt", ulidOf(71));
const PROJECT = makeId("prj", ulidOf(72));
const LABEL = Schema.decodeSync(RunLabel)("my-run");
const RUN = { id: runIdOf(AGENT, { label: LABEL }), label: LABEL };

/** An active agent's caller, its token for `projectId` or for none, in run `my-run` unless `inRun` is false. */
const agentCaller = (over: Partial<AgentPrincipal> = {}, inRun = true): Caller => ({
  requestId: "req-authz-standing",
  principal: {
    _tag: "Agent",
    agentId: AGENT,
    namespace: AGENT,
    scopes: ["agent:read", "agent:work"],
    paused: false,
    standing: { _tag: "Governs" },
    ...over,
  },
  token: {
    agentId: AGENT,
    scopes: ["agent:read", "agent:work"],
    revocationEpoch: 0,
    ...(inRun ? { run: RUN } : {}),
  },
  signal: new AbortController().signal,
});

/** What the wrapped `declare` and `Changes_listChanges` answer `caller` with, from memory stores that hold nothing. */
async function ownProjectAnswers(caller: Caller) {
  const wrapped = authorizeHandlers(
    Object.fromEntries(
      Object.keys(SPEC_ACTIONS).map((operation) => [operation, () => ({ status: 200, body: {} })]),
    ) as unknown as Operations<Caller>,
    RESOLVERS,
    run,
  ) as unknown as Record<string, (caller: Caller, input: unknown) => Promise<unknown>>;
  const answer = (operation: string) => {
    const handler = wrapped[operation];
    if (handler === undefined) throw new Error(`${operation} is not wrapped`);
    return handler(caller, {});
  };
  return [await answer("declare"), await answer("Changes_listChanges")];
}

describe("an agent refused for where its token stands", () => {
  it("[authz.no-project] a token that names no project is told to choose one for its run, 403 run.no_project, at every operation of the token's project; with no run it is told to ask for one, and a paused agent is told it is paused", async () => {
    const chosen = {
      status: 403,
      body: expect.objectContaining({
        code: "run.no_project",
        detail: expect.stringContaining("run my-run has chosen none"),
        nextActions: [
          expect.objectContaining({ operationId: "Agents_listReachableProjects" }),
          expect.objectContaining({ operationId: "Agents_useProject" }),
        ],
      }),
    };
    expect(await ownProjectAnswers(agentCaller())).toEqual([chosen, chosen]);
    const runless = await ownProjectAnswers(agentCaller({}, false));
    expect(runless).toMatchObject([
      { status: 403, body: { code: "run.no_project", nextActions: [{}, { kind: "escalate" }] } },
      { status: 403, body: { code: "run.no_project" } },
    ]);
    expect(await ownProjectAnswers(agentCaller({ paused: true }))).toMatchObject([
      { status: 403, body: { code: "auth.forbidden", detail: "Refused: agent-paused." } },
      { status: 403, body: { code: "auth.forbidden", detail: "Refused: agent-paused." } },
    ]);
    // A token for a project answers as the project's own refusal: here, a project no store holds.
    expect(await ownProjectAnswers(agentCaller({ projectId: PROJECT }))).toMatchObject([
      { status: 404, body: { code: "resource.not_found" } },
      { status: 404, body: { code: "resource.not_found" } },
    ]);
  });

  it("[authz.left] an agent whose invitation to the token's project ended is told it left, by the namespace's handle; never paused, never elsewhere, never one that did not stand there", async () => {
    const rows = makeBetterAuthMemory({ orgs: [{ id: sampleOrgId, slug: "acme" }] });
    const namespaces = makeNamespacesMemory(rows).layer;
    const runIn = ((_caller: Caller, effect: Effect.Effect<unknown, never, never>) =>
      Effect.runPromise(
        effect.pipe(Effect.provide(namespaces)) as Effect.Effect<unknown>,
      )) as Runner;
    const project = {
      _tag: "Project" as const,
      namespace: sampleOrgId,
      projectId: PROJECT,
      visibility: "private" as const,
      namespaceSuspended: false,
      personOwned: false,
    };
    const leftOrg = {
      namespace: sampleOrgId,
      projectId: PROJECT,
      standing: { _tag: "None" as const, left: true },
    };
    const told = await standingRefusal(agentCaller(leftOrg), project, new NotVisible(), runIn);
    expect(told).toMatchObject({
      status: 403,
      body: {
        code: "agent.left",
        detail: "You no longer stand in acme: you left, or a member took you out.",
        nextActions: [
          { kind: "escalate", title: "Ask a member of acme to invite you again" },
          { operationId: "Agents_listReachableProjects" },
          { operationId: "Agents_useProject" },
        ],
      },
    });
    const refusedWork = new AccessRefused({ reason: "scope", nextActions: [] });
    expect(await standingRefusal(agentCaller(leftOrg), project, refusedWork, runIn)).toMatchObject({
      body: { code: "agent.left" },
    });
    const paused = new AccessRefused({ reason: "agent-paused", nextActions: [] });
    expect(await standingRefusal(agentCaller(leftOrg), project, paused, runIn)).toBeUndefined();
    const never = { ...leftOrg, standing: { _tag: "None" as const } };
    expect(
      await standingRefusal(agentCaller(never), project, new NotVisible(), runIn),
    ).toBeUndefined();
    const elsewhere = { ...project, namespace: makeId("org", ulidOf(73)) };
    expect(
      await standingRefusal(agentCaller(leftOrg), elsewhere, new NotVisible(), runIn),
    ).toBeUndefined();
  });
});

/* oxlint-enable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-arguments, typescript/no-unnecessary-type-assertion */

/** Every source file under `dir`, recursively, but generated code. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "generated" ? [] : sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("one policy", () => {
  it("[authz.no-hand-checks] no doorway or use-case decides access by a scope itself", () => {
    const root = join(import.meta.dirname, "../../../..");
    const files = [
      ...sources(join(root, "apps/keel/src")),
      ...sources(join(root, "packages/core/src/application")),
    ];
    expect(files.length).toBeGreaterThan(100);
    const checks = [
      /\.scopes\.(includes|some|every)\(/,
      /satisfies\(\s*requirements/,
      /"(operator|observer)"/,
    ];
    const found = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          checks.some((check) => check.test(line)) ? [`${relative(root, file)}:${i + 1}`] : [],
        ),
    );
    expect(found).toEqual([]);
  });
});
