// What the GitCore composer asks gitcore to restack: the committer, times and
// trailers come from the request and the deployment's host alone, and each
// author from its submitted commit, so a recompose gives the same SHAs. Every
// commit is signed by the deployment's key, or nothing is composed at all.
import { agentActor, CommitSha, Instant, makeId, userActor } from "@keeltown/core/kernel";
import {
  CandidateComposer,
  type CandidateRequest,
  CodeHost,
  type MemberAgent,
  type MemberProposer,
  type RepoRef,
} from "@keeltown/core/ports";
import {
  concat,
  dec,
  decodeCommit,
  decodeTree,
  encodeCommit,
  FLUSH,
  hashObject,
  importSshSigningKey,
  MissingObject,
  pkt,
  readPkts,
  type Signature,
  sshSignature,
} from "@keeltown/gitcore";
import { makeCodeHostMemory } from "@keeltown/testing";
import { makeCommitSigningKeys } from "@keeltown/testing/commit-signing-keys";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CandidateComposerGitCore,
  restackSpec,
} from "../../src/adapters/driven/gitcore/candidate-composer.ts";
import {
  type CommitSigningConfig,
  decodeSigners,
  signersFile,
  VERIFIER_SKEW_SECONDS,
} from "../../src/adapters/driven/gitcore/commit-signing.ts";

const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const CHANGE = makeId("chg", "01J9ZZZZZZZZZZZZZZZZZZZZZB");
const OTHER_CHANGE = makeId("chg", "01J9ZZZZZZZZZZZZZZZZZZZZZD");
const CANDIDATE = makeId("cnd", "01J9ZZZZZZZZZZZZZZZZZZZZZE");
/** BatchFormed's time, 11 Oct 2026 09:00:00.250 UTC. */
const AT = Instant(1_791_709_200_250);
const AT_SECONDS = 1_791_709_200;
const HOST = "keel.test";
const KEEL: Signature = { name: "Keel", email: "keel@keel.test", time: AT_SECONDS };
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const REQUEST: CandidateRequest = {
  candidateId: CANDIDATE,
  staging: { namespace: "keel-core", name: "prj-staging" },
  base: sha("a"),
  at: AT,
  members: [
    {
      changeId: CHANGE,
      repo: { namespace: "keel-ws-00", name: "prj-ws-1" },
      base: sha("a"),
      head: sha("b"),
      title: "Retry the webhook on 503",
    },
    {
      changeId: OTHER_CHANGE,
      repo: { namespace: "keel-ws-00", name: "prj-ws-2" },
      base: sha("c"),
      head: sha("d"),
      title: "Log the retry count",
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A receive-pack that takes every push and reports each command's ref ok, counting what it was sent. */
function acceptingGit() {
  const sent = { pushes: 0 };
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    sent.pushes += 1;
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
    const first = readPkts(body).next().value;
    const ref = first == null ? "" : (dec.decode(first).split("\0")[0]?.split(" ")[2] ?? "");
    return new Response(concat([pkt("unpack ok\n"), pkt(`ok ${ref}\n`), FLUSH]));
  };
  return { fetch, sent };
}

const ADA: Signature = { name: "Ada Lovelace", email: "ada@example.com", time: 1_712_345_678 };

/**
 * One change, authored by Ada in its workspace, composed onto a fresh staging
 * repo by a composer holding `signing`: the compose's Exit, how many pushes
 * staging was sent, and the commit an unsigned restack would give.
 */
async function composedBy(
  signing: CommitSigningConfig,
  agent?: MemberAgent,
  proposer?: MemberProposer,
) {
  const code = makeCodeHostMemory();
  const staging: RepoRef = { namespace: "memory", name: "prj-staging" };
  const workspace: RepoRef = { namespace: "memory", name: "prj-ws-1" };
  /** Every repo's objects, as gitcore reads them. */
  const open = async (repo: RepoRef) => {
    const objects = code.repos.get(`${repo.namespace}/${repo.name}`)?.objects;
    const read = (oid: string, type: string) => {
      const o = objects?.get(oid);
      if (o?.type !== type) throw new MissingObject(oid);
      return o.body;
    };
    return {
      readTree: async (oid: string) => decodeTree(read(oid, "tree")),
      readBlob: async (oid: string) => read(oid, "blob"),
      readCommit: async (oid: string) => decodeCommit(read(oid, "commit")),
      [Symbol.dispose]: () => undefined,
    };
  };
  const seeded = Effect.gen(function* () {
    const host = yield* CodeHost;
    yield* host.create(staging);
    const base = yield* code.fixture.commit(staging, "refs/heads/main", {
      "README.md": "base\n",
    });
    yield* host.fork(staging, workspace);
    const pushed = yield* code.fixture.commit(workspace, "refs/heads/main", {
      "README.md": "base\n",
      "src/retry.ts": "export const retries = 3;\n",
    });
    // The agent's own commit, authored by Ada: what the workspace's head holds.
    const objects = code.repos.get("memory/prj-ws-1")?.objects;
    const fixtureCommit = objects?.get(pushed);
    if (objects === undefined || fixtureCommit === undefined) throw new Error("no head");
    const { tree, parents } = decodeCommit(fixtureCommit.body);
    const body = encodeCommit({ tree, parents, author: ADA, committer: ADA, message: "wip\n" });
    const head = yield* Effect.promise(() => hashObject("commit", body));
    objects.set(head, { type: "commit", body });
    return { base, head: Schema.decodeUnknownSync(CommitSha)(head), tree };
  });
  const [member] = REQUEST.members;
  if (member === undefined) throw new Error("REQUEST has members");
  const git = acceptingGit();
  vi.stubGlobal("fetch", git.fetch);
  const layer = CandidateComposerGitCore(open, signing).pipe(Layer.provideMerge(code.layer));
  return Effect.runPromise(
    Effect.gen(function* () {
      const at = yield* seeded;
      const composer = yield* CandidateComposer;
      const compose = composer.compose({
        ...REQUEST,
        staging,
        base: at.base,
        members: [{ ...member, repo: workspace, base: at.base, head: at.head, agent, proposer }],
      });
      const exit = yield* Effect.exit(compose);
      const unsigned = encodeCommit({
        tree: at.tree,
        parents: [at.base],
        author: ADA,
        committer: KEEL,
        message: "Retry the webhook on 503",
        trailers: [["Change-Id", CHANGE]],
      });
      return { ...at, exit, unsigned, pushes: git.sent.pushes, again: Effect.exit(compose) };
    }).pipe(Effect.provide(layer)),
  );
}

/** What a compose that died said, or "" when it did not die. */
const defectOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? Cause.pretty(exit.cause) : "";

describe("the GitCore composer's restack", () => {
  it("[composer.deterministic] takes every identity and time from the request, never the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
    const once = restackSpec(REQUEST, HOST);
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    expect(restackSpec(REQUEST, HOST)).toEqual(once);
    expect(restackSpec(REQUEST, "keel.town").committer.email).toBe("keel@keel.town");
    expect(once).toEqual({
      ref: `refs/heads/cand/${CANDIDATE}`,
      committer: KEEL,
      members: [
        {
          base: sha("a"),
          head: sha("b"),
          message: "Retry the webhook on 503",
          trailers: [["Change-Id", CHANGE]],
        },
        {
          base: sha("c"),
          head: sha("d"),
          message: "Log the retry count",
          trailers: [["Change-Id", OTHER_CHANGE]],
        },
      ],
    });
  });

  it("[composer.keeps-author] a member with no agent, a probe's, keeps the submitted commit's author, with Keel at its host as committer", async () => {
    const keys = await makeCommitSigningKeys();
    const { base, head, exit, unsigned } = await composedBy({ host: HOST, ...keys });
    expect(head).not.toBe(base);
    const key = await importSshSigningKey(keys.signingKey);
    const expected = await hashObject(
      "commit",
      encodeCommit({
        tree: decodeCommit(unsigned).tree,
        parents: [base],
        author: ADA,
        committer: KEEL,
        message: "Retry the webhook on 503",
        trailers: [["Change-Id", CHANGE]],
        gpgsig: await sshSignature(key, unsigned),
      }),
    );
    if (!Exit.isSuccess(exit)) throw new Error(defectOf(exit));
    expect(exit.value.commitSha).toBe(expected);
    expect(exit.value.commits).toEqual([{ changeId: CHANGE, sha: expected }]);
  });

  it("[composer.agent-author] a member's agent is the commit's author under Keel's agents domain, named in trailers, with the submitted author declared", async () => {
    const keys = await makeCommitSigningKeys();
    const key = await importSshSigningKey(keys.signingKey);
    const AGENT = makeId("agt", "01J9AAAAAAAAAAAAAAAAAAAAAA");
    const cases = [
      {
        agent: { id: AGENT, handle: "k7f3-quiet-otter", run: "run_01J9RRRRRRRRRRRRRRRRRRRRRR" },
        author: { name: "k7f3-quiet-otter", email: `${AGENT}@agents.keel.test` },
        trailers: [
          ["Change-Id", CHANGE],
          ["Keel-Agent", AGENT],
          ["Keel-Run", "run_01J9RRRRRRRRRRRRRRRRRRRRRR"],
          ["Declared-Author", "Ada Lovelace <ada@example.com>"],
        ],
      },
      {
        // An agent from before handles is written by its id, and one with no run names none.
        agent: { id: AGENT },
        author: { name: AGENT, email: `${AGENT}@agents.keel.test` },
        trailers: [
          ["Change-Id", CHANGE],
          ["Keel-Agent", AGENT],
          ["Declared-Author", "Ada Lovelace <ada@example.com>"],
        ],
      },
    ] as const;
    for (const { agent, author, trailers } of cases) {
      const { base, tree, exit } = await composedBy({ host: HOST, ...keys }, agent);
      const spec = {
        tree,
        parents: [base],
        // The date and offset stay the submitted commit's.
        author: { ...ADA, ...author },
        committer: KEEL,
        message: "Retry the webhook on 503",
        trailers,
      };
      const expected = await hashObject(
        "commit",
        encodeCommit({ ...spec, gpgsig: await sshSignature(key, encodeCommit(spec)) }),
      );
      if (!Exit.isSuccess(exit)) throw new Error(defectOf(exit));
      expect(exit.value.commitSha).toBe(expected);
    }
  });

  it("[compose.proposal-author] a proposal's commit is its proposer's, a person under Keel's people domain or an agent under its agents domain, named in trailers with the fork and commit it was proposed from, and no agent", async () => {
    const keys = await makeCommitSigningKeys();
    const key = await importSshSigningKey(keys.signingKey);
    const PERSON = makeId("usr", "01J9PPPPPPPPPPPPPPPPPPPPPP");
    const AGENT = makeId("agt", "01J9AAAAAAAAAAAAAAAAAAAAAA");
    const FORK = makeId("prj", "01J9FFFFFFFFFFFFFFFFFFFFFF");
    const from = { project: FORK, commit: sha("f") };
    const proposedFrom = ["Proposed-From", `${FORK}@${sha("f")}`] as const;
    const cases = [
      {
        proposer: { actor: userActor(PERSON), handle: "stranger", from },
        author: { name: "stranger", email: `${PERSON}@people.keel.test` },
        trailers: [
          ["Change-Id", CHANGE],
          ["Keel-Proposer", `user:${PERSON}`],
          proposedFrom,
          ["Declared-Author", "Ada Lovelace <ada@example.com>"],
        ],
      },
      {
        // An agent with no handle is written by its id.
        proposer: { actor: agentActor(AGENT), from },
        author: { name: AGENT, email: `${AGENT}@agents.keel.test` },
        trailers: [
          ["Change-Id", CHANGE],
          ["Keel-Proposer", `agent:${AGENT}`],
          proposedFrom,
          ["Declared-Author", "Ada Lovelace <ada@example.com>"],
        ],
      },
    ] as const;
    for (const { proposer, author, trailers } of cases) {
      const { base, tree, exit } = await composedBy({ host: HOST, ...keys }, undefined, proposer);
      const spec = {
        tree,
        parents: [base],
        author: { ...ADA, ...author },
        committer: KEEL,
        message: "Retry the webhook on 503",
        trailers,
      };
      const expected = await hashObject(
        "commit",
        encodeCommit({ ...spec, gpgsig: await sshSignature(key, encodeCommit(spec)) }),
      );
      if (!Exit.isSuccess(exit)) throw new Error(defectOf(exit));
      expect(exit.value.commitSha).toBe(expected);
    }
  });

  it("[composer.signs] every composed commit is the deployment's key's signature over its unsigned form, the same on a recompose", async () => {
    const keys = await makeCommitSigningKeys();
    const stranger = await makeCommitSigningKeys();
    const ours = await composedBy({ host: HOST, ...keys });
    if (!Exit.isSuccess(ours.exit)) throw new Error(defectOf(ours.exit));
    const signedBy = async (pem: string) =>
      hashObject(
        "commit",
        encodeCommit({
          tree: ours.tree,
          parents: [ours.base],
          author: ADA,
          committer: KEEL,
          message: "Retry the webhook on 503",
          trailers: [["Change-Id", CHANGE]],
          gpgsig: await sshSignature(await importSshSigningKey(pem), ours.unsigned),
        }),
      );
    expect(ours.exit.value.commitSha).toBe(await signedBy(keys.signingKey));
    expect(ours.exit.value.commitSha).not.toBe(await signedBy(stranger.signingKey));
    expect(ours.exit.value.commitSha).not.toBe(await hashObject("commit", ours.unsigned));
    expect(ours.pushes).toBe(1);
  });

  it("[composer.no-key] a deployment with no signing key composes nothing: the compose is a defect before anything is pushed", async () => {
    const keys = await makeCommitSigningKeys();
    for (const signingKey of [undefined, ""]) {
      const { exit, pushes } = await composedBy({ host: HOST, signers: keys.signers, signingKey });
      expect(defectOf(exit)).toContain(
        "KEEL_COMMIT_SIGNING_KEY is not set: Keel composes no commit it cannot sign",
      );
      expect(pushes).toBe(0);
    }
    const malformed = await composedBy({ host: HOST, signers: keys.signers, signingKey: "a key" });
    expect(defectOf(malformed.exit)).toContain("the signing key is not a PKCS#8 PEM private key");
    expect(defectOf(malformed.exit)).not.toContain("a key\n");
    expect(malformed.pushes).toBe(0);
  });

  it("[composer.key-unvouched] a key the signers setting does not hold for the commit's time and the hour after composes nothing", async () => {
    const keys = await makeCommitSigningKeys();
    const stranger = await makeCommitSigningKeys();
    const listing = (
      window: { validAfter?: number; validBefore?: number },
      publicKey = keys.publicKey,
    ) =>
      JSON.stringify([
        {
          publicKey,
          ...(window.validAfter === undefined ? {} : { validAfter: iso(window.validAfter) }),
          ...(window.validBefore === undefined ? {} : { validBefore: iso(window.validBefore) }),
        },
      ]);
    const refused = [
      "[]",
      listing({}, stranger.publicKey),
      listing({ validAfter: AT_SECONDS + 1 }),
      listing({ validBefore: AT_SECONDS - 1 }),
      // It holds the commit's own second, and not the hour a daylight-time verifier reads it late by.
      listing({ validBefore: AT_SECONDS + VERIFIER_SKEW_SECONDS - 1 }),
    ];
    for (const signers of refused) {
      const { exit, pushes } = await composedBy({
        host: HOST,
        signingKey: keys.signingKey,
        signers,
      });
      expect(defectOf(exit)).toContain(
        "KEEL_COMMIT_SIGNERS does not hold the signing key for 2026-10-11T09:00:00.000Z",
      );
      expect(pushes).toBe(0);
    }
    const held = [
      listing({ validAfter: AT_SECONDS }),
      listing({ validBefore: AT_SECONDS + VERIFIER_SKEW_SECONDS }),
      `${listing({}, stranger.publicKey).slice(0, -1)},${listing({ validAfter: AT_SECONDS - 60 }).slice(1)}`,
    ];
    for (const signers of held) {
      const { exit, pushes } = await composedBy({
        host: HOST,
        signingKey: keys.signingKey,
        signers,
      });
      expect(defectOf(exit)).toBe("");
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(pushes).toBe(1);
    }
  });
});

describe("Keel's signers setting", () => {
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPJ1n0SCfmBzYAp3tONBs3mjHWzRUvWb0aH0kYWcyTgO";

  it("[signers.decode] reads each key with its window in ISO 8601, and writes the file under keel@<host>", () => {
    const signers = JSON.stringify([
      {
        publicKey: key,
        validAfter: "2025-10-09T08:53:20Z",
        validBefore: "2026-10-09T08:53:20.000Z",
      },
      { publicKey: key },
    ]);
    expect(decodeSigners(signers)).toEqual([
      { publicKey: key, validAfter: 1_760_000_000, validBefore: 1_791_536_000 },
      { publicKey: key, validAfter: undefined, validBefore: undefined },
    ]);
    expect(signersFile({ host: "keel.town", signers })).toBe(
      [
        `keel@keel.town namespaces="git",valid-after="20251009085320Z",valid-before="20261009085320Z" ${key}\n`,
        `keel@keel.town namespaces="git" ${key}\n`,
      ].join(""),
    );
    expect(signersFile({ host: "keel.town", signers: "[]" })).toBe("");
  });

  it("[signers.decode-refuses] a setting that is not a list of keys is a defect naming the setting", () => {
    for (const setting of [
      "",
      "{}",
      "[1]",
      JSON.stringify([{ validAfter: "2026-10-13T00:00:00Z" }]),
    ])
      expect(() => decodeSigners(setting)).toThrow(
        "KEEL_COMMIT_SIGNERS is not a JSON list of keys",
      );
    for (const validAfter of ["soon", "2026-10-13T00:00:00.500Z", ""])
      expect(() => decodeSigners(JSON.stringify([{ publicKey: key, validAfter }]))).toThrow(
        "KEEL_COMMIT_SIGNERS holds a time that is not ISO 8601 to the second",
      );
    expect(() =>
      signersFile({ host: "keel.town", signers: JSON.stringify([{ publicKey: "x" }]) }),
    ).toThrow("bad signer key");
  });
});
