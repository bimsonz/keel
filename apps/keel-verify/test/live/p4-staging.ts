// The probe runner's live proofs on staging, through the deployed keel-verify's runProbe,
// which is RPC only: p4-driver.ts runs locally under wrangler with a remote
// service binding to it and a remote R2 binding to the bundle bucket
// (p4-staging.wrangler.jsonc), and fans each batch of runs out from inside
// workerd, so runs sent together arrive together. Every bundle is rebuilt each
// time (they are deterministic) and put only when the bucket lacks it.
//
//   CLOUDFLARE_ACCOUNT_ID=… node apps/keel-verify/test/live/p4-staging.ts <command>
//     matrix [runs] [--fresh]
//                     S-1's freshness probe across its five worlds, `runs` times (3):
//                     every reply, the cells against S26's, harness errors, admission, wall p50/p90.
//                     --fresh salts the probe, so its hash names new VerifierDOs and run 1 bundles cold
//     queue           a warm-up, then 5 runs at once on one (probe, world) DO:
//                     exactly one answers queued, and all five pass
//     hog             a probe that allocates without bound: the replaced-isolate
//                     harness error, or plainly what the platform did instead
//
// The worlds need forge-lite's deps bundle first: deps-bundle.ts fixtures/forge-lite --upload.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  buildWorlds,
  type FreshnessSlots,
  freshnessNoop,
  MATRIX_WORLDS,
  renderFreshness,
  type TextCodec,
} from "@keeltown/core/application/verification";
import {
  admit,
  type ProbeCell,
  type ProbeOutcome,
  type World,
} from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { type BundleFile, depsNeed, sha256Hex, writeBundle } from "@keeltown/runner-protocol";
import { Exit, Result, Schema } from "effect";
import { unstable_startWorker } from "wrangler";
import { decodeExit, ProbeRunRequest, VerifierCodecs } from "../../src/rpc/index.ts";
import { variantFiles } from "./bundles.ts";

const FIXTURE = join(import.meta.dirname, "../../../../fixtures/forge-lite");

/** S-1's slots for the freshness template, as scenarios/s1/probe.test.ts makes its calls: bob's admin role is revoked mid-session. */
const S1: FreshnessSlots = {
  owner: "alice",
  subject: "bob",
  setup: [
    {
      actor: "owner",
      method: "POST",
      path: "/repos",
      body: '{"name":"forge","visibility":"public"}',
      expectedStatus: 201,
    },
    {
      actor: "owner",
      method: "PUT",
      path: "/repos/alice/forge/collaborators/bob",
      body: '{"role":"admin"}',
      expectedStatus: 201,
    },
  ],
  call: {
    actor: "subject",
    method: "GET",
    path: "/repos/alice/forge",
    body: "",
    expectedStatus: 200,
  },
  revoke: {
    actor: "owner",
    method: "DELETE",
    path: "/repos/alice/forge/collaborators/bob",
    body: "",
    expectedStatus: 204,
  },
  callAgain: {
    actor: "subject",
    method: "DELETE",
    path: "/repos/alice/forge",
    body: "",
    expectedStatus: 403,
  },
  rationale: "bob's admin role is revoked mid-session",
};

/** A's revoke call, which A-noop makes a no-op. */
const RECIPE = freshnessNoop({
  path: "src/routes/collaborators.ts",
  call: "store.removeCollaborator(repo.id, target.id, actor.id, clock.now());",
});

/** What S26 saw for S-1 (and worlds.sh asserts): no revoke route on trunk or B, A holds, AB and A-noop break. */
const S26: Readonly<Record<World, string>> = {
  trunk: "n/a",
  A: "pass",
  B: "n/a",
  AB: "fail",
  "A-noop": "fail",
};

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const codec: TextCodec<BundleFile> = {
  path: (f) => f.path,
  text: (f) => {
    try {
      return dec.decode(f.bytes);
    } catch {
      return undefined;
    }
  },
  withText: (f, text) => ({ ...f, bytes: enc.encode(text) }),
};

/** Every file under `root`, relative to it. */
const readTree = (root: string): BundleFile[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const path = join(e.parentPath, e.name);
      return { path: relative(root, path), bytes: new Uint8Array(readFileSync(path)) };
    });

/** forge-lite's tracked files with S-1's patches applied in order, as `git apply` from the fixture leaves them. */
const patched = (patches: readonly string[]): BundleFile[] => {
  const dir = mkdtempSync(join(tmpdir(), "keel-p4-world-"));
  for (const file of variantFiles("base")) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.bytes);
  }
  for (const patch of patches)
    execFileSync("git", ["apply", join(FIXTURE, "scenarios", patch)], { cwd: dir });
  return readTree(dir);
};

/** S-1's five worlds: trunk, A, B, AB, and A with its revoke call made a no-op. */
const s1Worlds = (): Readonly<Record<World, readonly BundleFile[]>> => {
  const built = buildWorlds(
    {
      trunk: patched([]),
      A: patched(["s1/a.patch"]),
      B: patched(["s1/b.patch"]),
      AB: patched(["s1/a.patch", "s1/b.patch"]),
    },
    RECIPE,
    codec,
  );
  if (Result.isFailure(built)) throw new Error(`no A-noop: ${JSON.stringify(built.failure)}`);
  return built.success;
};

const probeFiles = (path: string, text: string): BundleFile[] => [
  { path, bytes: enc.encode(text) },
];

/** Two seconds' nap, then a pass: long enough that five at once overlap in the semaphore. */
const NAP_PROBE = probeFiles(
  ".keel/nap.test.ts",
  `import { expect, it } from "vitest";
it("naps", async () => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log("[probe] napped -> 1 (expected 1)");
  expect(1).toBe(1);
});
`,
);

/** S14's memory hog: 16 MiB at a time, held, until the isolate is stopped. */
const HOG_PROBE = probeFiles(
  ".keel/hog.test.ts",
  `import { it } from "vitest";
it("hogs", () => {
  const held = [];
  for (let i = 1; ; i++) {
    held.push(new Uint8Array(16 * 1024 * 1024).fill(i % 251));
    if (i % 4 === 0) console.log("[probe] held -> " + i * 16 + " MiB");
  }
});
`,
);

// ------------------------------------------------------------------ staging

const driver = await unstable_startWorker({
  config: join(import.meta.dirname, "p4-staging.wrangler.jsonc"),
  dev: { server: { port: 0 }, inspector: false },
});
await driver.ready;

const call = async (path: string, init: Parameters<typeof driver.fetch>[1]) => {
  const response = await driver.fetch(`http://driver${path}`, init);
  if (response.status >= 500)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
};

const has = async (key: string) => (await call(`/r2/${key}`, { method: "HEAD" })).status === 200;

/** Puts files as a content-addressed bundle at `bundles/<hex>` unless the bucket holds it already. */
const put = async (files: readonly BundleFile[]): Promise<ContentHash> => {
  const bytes = await writeBundle(files);
  const hex = await sha256Hex(bytes);
  if (!(await has(`bundles/${hex}`)))
    await call(`/r2/bundles/${hex}`, { method: "PUT", body: Buffer.from(bytes) });
  return ContentHash.make(`sha256:${hex}`);
};

/** forge-lite's deps must be in the bucket under its lockfile, or every world abstains lockfile-diverged. */
const requireDeps = async (world: readonly BundleFile[]) => {
  const need = await depsNeed(world);
  if (need._tag !== "lockfile") return;
  if (!(await has(`deps/${need.sha256}`)))
    throw new Error(
      `no deps/${need.sha256} in the bucket: run deps-bundle.ts fixtures/forge-lite --upload first`,
    );
};

interface Reply {
  readonly world: World;
  readonly run: number;
  /** When the call went out and came back, in ms since its batch began, inside the driver. */
  readonly from: number;
  readonly to: number;
  readonly ms: number;
  readonly answer:
    | { readonly _tag: "ran"; readonly outcome: ProbeOutcome; readonly reason: string }
    | { readonly _tag: "harness-error"; readonly reason: string }
    | { readonly _tag: "unavailable"; readonly reason: string };
  readonly queued?: boolean;
  readonly instance?: string;
}

const Sent = Schema.Array(
  Schema.Struct({ from: Schema.Number, to: Schema.Number, reply: Schema.Unknown }),
);

/** Sends `requests` at once from inside the driver; answers each reply, in order. */
const runBatch = async (requests: readonly ProbeRunRequest[]): Promise<Reply[]> => {
  const response = await call("/run", {
    method: "POST",
    body: JSON.stringify(requests.map((r) => Schema.encodeSync(ProbeRunRequest)(r))),
  });
  const sent = Schema.decodeUnknownSync(Sent)(await response.json());
  return requests.map((request, i): Reply => {
    const one = sent[i];
    if (one === undefined) throw new Error(`no reply for request ${i}`);
    const exit = decodeExit(VerifierCodecs.runProbe, one.reply);
    const at = {
      world: request.world,
      run: request.run,
      from: one.from,
      to: one.to,
      ms: one.to - one.from,
    };
    if (Exit.isFailure(exit))
      return { ...at, answer: { _tag: "unavailable", reason: JSON.stringify(exit.cause) } };
    const { run, queued, instance } = exit.value;
    return {
      ...at,
      answer:
        run._tag === "ran"
          ? { _tag: "ran", outcome: run.outcome, reason: run.reason }
          : { _tag: "harness-error", reason: run.reason },
      queued,
      ...(instance === undefined ? {} : { instance }),
    };
  });
};

const percentile = (values: readonly number[], p: number): number | undefined => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

const timing = (replies: readonly Reply[]) => {
  const ms = replies.map((r) => r.ms);
  return {
    n: ms.length,
    p50: percentile(ms, 50),
    p90: percentile(ms, 90),
    max: percentile(ms, 100),
  };
};

const matrix = async (runs: number, fresh: boolean) => {
  const worlds = s1Worlds();
  await requireDeps(worlds.trunk);
  const salt = fresh ? `// fresh ${Date.now()}\n` : "";
  const probe = await put(probeFiles(".keel/freshness.test.ts", salt + renderFreshness(S1)));
  const bundles: Readonly<Record<World, ContentHash>> = {
    trunk: await put(worlds.trunk),
    A: await put(worlds.A),
    B: await put(worlds.B),
    AB: await put(worlds.AB),
    "A-noop": await put(worlds["A-noop"]),
  };
  console.log(JSON.stringify({ probe, worlds: bundles }));
  const replies: Reply[] = [];
  for (let run = 1; run <= runs; run++) {
    // A run's worlds go at once, the runs one after another, as runMatrix does.
    // oxlint-disable-next-line no-await-in-loop -- the runs are sequential on purpose
    const answers = await runBatch(
      MATRIX_WORLDS.map((world) => ({ probe, world, worldBundle: bundles[world], run })),
    );
    for (const reply of answers) console.log(JSON.stringify(reply));
    replies.push(...answers);
  }
  const cells: ProbeCell[] = replies.flatMap((r) =>
    r.answer._tag === "ran" ? [{ world: r.world, run: r.run, outcome: r.answer.outcome }] : [],
  );
  const mismatches = replies
    .filter((r) => r.answer._tag !== "ran" || r.answer.outcome !== S26[r.world])
    .map((r) => ({ world: r.world, run: r.run, want: S26[r.world], got: r.answer }));
  console.log(
    JSON.stringify({
      summary: {
        cells: `${cells.length}/${replies.length}`,
        matchesS26: mismatches.length === 0,
        mismatches,
        harnessErrors: replies.filter((r) => r.answer._tag === "harness-error").length,
        unavailable: replies.filter((r) => r.answer._tag === "unavailable").length,
        admission: admit(cells),
        wall: timing(replies),
        wallFirstRun: timing(replies.filter((r) => r.run === 1)),
        wallLaterRuns: timing(replies.filter((r) => r.run > 1)),
      },
    }),
  );
};

const queue = async () => {
  const world = s1Worlds().trunk;
  await requireDeps(world);
  const probe = await put(NAP_PROBE);
  const worldBundle = await put(world);
  // Bundled once, outside the measured five.
  const [warmUp] = await runBatch([{ probe, world: "trunk", worldBundle, run: 100 }]);
  console.log(JSON.stringify({ warmUp }));
  const five = await runBatch(
    [101, 102, 103, 104, 105].map((run) => ({ probe, world: "trunk" as const, worldBundle, run })),
  );
  for (const reply of five) console.log(JSON.stringify(reply));
  console.log(
    JSON.stringify({
      summary: {
        queued: five.filter((r) => r.queued === true).length,
        passed: five.filter((r) => r.answer._tag === "ran" && r.answer.outcome === "pass").length,
        instances: new Set(five.map((r) => r.instance)).size,
        wall: timing(five),
      },
    }),
  );
};

const hog = async () => {
  const world = s1Worlds().trunk;
  await requireDeps(world);
  const [reply] = await runBatch([
    { probe: await put(HOG_PROBE), world: "trunk", worldBundle: await put(world), run: 1 },
  ]);
  console.log(JSON.stringify(reply));
};

const [command, ...args] = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 3);
try {
  if (command === "matrix") await matrix(runs, args.includes("--fresh"));
  else if (command === "queue") await queue();
  else if (command === "hog") await hog();
  else console.error("usage: matrix [runs] [--fresh] | queue | hog");
} finally {
  await driver.dispose();
}
