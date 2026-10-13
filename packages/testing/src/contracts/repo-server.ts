import { describe, expect, it } from "@effect/vitest";
import {
  CodeHost,
  RepoServer,
  UPLOAD_PACK_ANSWER_TYPE,
  type UploadPackAnswer,
} from "@keeltown/core/ports";
import { concat, dec, FLUSH, pkt, readPkts } from "@keeltown/gitcore";
import { Effect, type Layer } from "effect";
import { CodeHostFixture } from "../code-host-fixture.ts";

const MAIN = "refs/heads/main";
/** Protocol v2's delimiter packet, between a command's capabilities and its arguments. */
const DELIM = new TextEncoder().encode("0001");

/** An answer's whole body. */
const bytesOf = (answer: UploadPackAnswer) =>
  Effect.promise(async () => {
    const parts: Uint8Array[] = [];
    if (answer.body !== null) for await (const chunk of answer.body) parts.push(chunk);
    return concat(parts);
  });

/** A body's pkt-lines as text, without the flush and delimiter packets or a ref line's capabilities. */
const linesOf = (bytes: Uint8Array) =>
  [...readPkts(bytes)].flatMap((line) =>
    line === null ? [] : [(dec.decode(line).replace(/\n$/, "").split("\0")[0] ?? "").trim()],
  );

/** How many objects the pack in band 1 of a side-band answer declares. */
function packedObjects(bytes: Uint8Array): number {
  const pack = concat(
    [...readPkts(bytes)].flatMap((line) =>
      line !== null && line[0] === 1 ? [line.subarray(1)] : [],
    ),
  );
  expect(dec.decode(pack.subarray(0, 4))).toBe("PACK");
  return new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);
}

/**
 * The suite every RepoServer adapter passes, over the code host it reads and
 * a fixture that commits to it: what a git client's fetch asks, in protocol
 * v0 and v2, and what it must get back, which is the repo's main and no
 * other ref.
 */
export function describeRepoServerContract(
  adapter: string,
  make: () => Layer.Layer<RepoServer | CodeHost | CodeHostFixture>,
) {
  describe(`RepoServer contract: ${adapter}`, () => {
    it.live(
      "[reposerver.contract.advertise] the advertisement lists main at the repo's head, and at its next head once it moves",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const server = yield* RepoServer;
          const repo = yield* host.create(fixture.scratch());
          const advertised = Effect.gen(function* () {
            const answer = yield* server.uploadPack(repo, {
              service: "advertise",
              protocol: null,
              body: null,
            });
            expect(answer.status).toBe(200);
            expect(answer.contentType).toBe(UPLOAD_PACK_ANSWER_TYPE.advertise);
            return linesOf(yield* bytesOf(answer));
          });

          const first = yield* fixture.commit(repo, MAIN, { "README.md": "served\n" });
          const lines = yield* advertised;
          expect(lines[0]).toBe("# service=git-upload-pack");
          expect(lines).toContain(`${first} ${MAIN}`);

          const second = yield* fixture.commit(repo, MAIN, { "README.md": "served again\n" });
          expect(yield* advertised).toContain(`${second} ${MAIN}`);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[reposerver.contract.fetch] a want of the head answers a pack holding its commit, tree and blob",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const server = yield* RepoServer;
          const repo = yield* host.create(fixture.scratch());
          const head = yield* fixture.commit(repo, MAIN, { "README.md": "served\n" });
          const answer = yield* server.uploadPack(repo, {
            service: "negotiate",
            protocol: null,
            body: concat([
              pkt(`want ${head} side-band-64k ofs-delta no-progress agent=keel-contract\n`),
              FLUSH,
              pkt("done\n"),
            ]),
          });
          expect(answer.status).toBe(200);
          expect(answer.contentType).toBe(UPLOAD_PACK_ANSWER_TYPE.negotiate);
          expect(packedObjects(yield* bytesOf(answer))).toBe(3);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[reposerver.contract.v2] under Git-Protocol version=2 the capabilities, ls-refs and a fetch answer as protocol v2",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const server = yield* RepoServer;
          const repo = yield* host.create(fixture.scratch());
          const head = yield* fixture.commit(repo, MAIN, { "README.md": "served\n" });
          const v2 = { protocol: "version=2" } as const;

          const capabilities = linesOf(
            yield* bytesOf(
              yield* server.uploadPack(repo, { ...v2, service: "advertise", body: null }),
            ),
          );
          // Over HTTP a host may announce the service first, as in v0; the capabilities follow.
          expect(capabilities.filter((c) => c !== "# service=git-upload-pack")[0]).toBe(
            "version 2",
          );
          expect(capabilities.some((c) => c === "fetch" || c.startsWith("fetch="))).toBe(true);

          const listed = yield* server.uploadPack(repo, {
            ...v2,
            service: "negotiate",
            body: concat([
              pkt("command=ls-refs\n"),
              pkt("agent=keel-contract\n"),
              DELIM,
              pkt("ref-prefix refs/heads/\n"),
              FLUSH,
            ]),
          });
          expect(listed.contentType).toBe(UPLOAD_PACK_ANSWER_TYPE.negotiate);
          expect(linesOf(yield* bytesOf(listed))).toContain(`${head} ${MAIN}`);

          const fetched = yield* bytesOf(
            yield* server.uploadPack(repo, {
              ...v2,
              service: "negotiate",
              body: concat([
                pkt("command=fetch\n"),
                pkt("agent=keel-contract\n"),
                DELIM,
                pkt("ofs-delta\n"),
                pkt("no-progress\n"),
                pkt(`want ${head}\n`),
                pkt("done\n"),
                FLUSH,
              ]),
            }),
          );
          expect(linesOf(fetched)).toContain("packfile");
          expect(packedObjects(fetched)).toBe(3);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[reposerver.contract.main-only] a repo whose own HEAD is on another branch is shown as HEAD on main and main alone, and main is fetched",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const server = yield* RepoServer;
          const upstreams = yield* fixture.upstreams;
          // An import's HEAD names the branch that came, which is not main; main then moves ahead of it.
          const repo = fixture.scratch();
          const imported = yield* host.import({ url: upstreams.url }, repo);
          expect(imported.ref).not.toBe(MAIN);
          const head = yield* fixture.commit(repo, MAIN, { "README.md": "landed\n" }, [
            imported.commit,
          ]);

          const advertised = yield* bytesOf(
            yield* server.uploadPack(repo, { service: "advertise", protocol: null, body: null }),
          );
          expect(linesOf(advertised)).toEqual([
            "# service=git-upload-pack",
            `${head} HEAD`,
            `${head} ${MAIN}`,
          ]);
          expect(
            [...readPkts(advertised)]
              .flatMap((line) => (line === null ? [] : dec.decode(line).trim().split(/[\0 ]/)))
              .filter((capability) => capability.startsWith("symref=")),
          ).toEqual([`symref=HEAD:${MAIN}`]);

          const v2 = { protocol: "version=2", service: "negotiate" } as const;
          const listed = (...args: readonly string[]) =>
            Effect.gen(function* () {
              const answer = yield* server.uploadPack(repo, {
                ...v2,
                body: concat([
                  pkt("command=ls-refs\n"),
                  pkt("agent=keel-contract\n"),
                  DELIM,
                  ...args.map((arg) => pkt(`${arg}\n`)),
                  FLUSH,
                ]),
              });
              expect(answer.status).toBe(200);
              return linesOf(yield* bytesOf(answer));
            });
          expect(yield* listed("symrefs", "peel")).toEqual([
            `${head} HEAD symref-target:${MAIN}`,
            `${head} ${MAIN}`,
          ]);
          // A client asking for HEAD alone leaves main out of its prefixes, and still gets main's commit.
          expect(yield* listed("symrefs", "ref-prefix HEAD")).toEqual([
            `${head} HEAD symref-target:${MAIN}`,
          ]);
          expect(yield* listed(`ref-prefix ${imported.ref}`, "ref-prefix refs/tags/")).toEqual([]);

          const fetched = yield* bytesOf(
            yield* server.uploadPack(repo, {
              ...v2,
              body: concat([
                pkt("command=fetch\n"),
                pkt("agent=keel-contract\n"),
                DELIM,
                pkt("ofs-delta\n"),
                pkt("no-progress\n"),
                pkt(`want ${head}\n`),
                pkt(`have ${imported.commit}\n`),
                pkt("done\n"),
                FLUSH,
              ]),
            }),
          );
          expect(linesOf(fetched)).toContain("packfile");
          expect(packedObjects(fetched)).toBeGreaterThanOrEqual(3);
        }).pipe(Effect.provide(make())),
    );

    it.live("[reposerver.contract.missing] a repo that is gone fails RepoNotFound", () =>
      Effect.gen(function* () {
        const fixture = yield* CodeHostFixture;
        const server = yield* RepoServer;
        const gone = fixture.scratch();
        for (const request of [
          { service: "advertise", protocol: null, body: null },
          { service: "negotiate", protocol: null, body: concat([FLUSH]) },
        ] as const)
          expect(yield* Effect.flip(server.uploadPack(gone, request))).toMatchObject({
            _tag: "RepoNotFound",
            repo: { namespace: gone.namespace, name: gone.name },
          });
      }).pipe(Effect.provide(make())),
    );
  });
}
