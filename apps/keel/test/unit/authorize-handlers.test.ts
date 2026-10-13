import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ACTIONS, SPEC_ACTIONS } from "@keeltown/core/domain/identity";
import {
  makeAgentDirectoryMemory,
  makeChangesMemory,
  makeNamespacesMemory,
  makeProjectNamespacesMemory,
  makeProjectsMemory,
} from "@keeltown/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  authorizeHandlers,
  RESOLVERS,
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
