import { describe, expect, it } from "@effect/vitest";
import { CommitSha, Instant } from "@keeltown/core/kernel";
import {
  CodeHost,
  type RepoRef,
  WORKSPACE_BRANCH,
  type WorkspaceEdit,
  WorkspaceWriter,
} from "@keeltown/core/ports";
import { Effect, type Layer } from "effect";
import { CodeHostFixture } from "../code-host-fixture.ts";

/** A writer beside the code host it commits through and a fixture to seed it. */
export interface WorkspaceWriterHarness {
  readonly layer: Layer.Layer<WorkspaceWriter | CodeHost | CodeHostFixture>;
}

const AT = Instant(Date.UTC(2026, 9, 13, 21, 0, 0));
const AUTHOR = { agentId: "agt_01KRWRTRCNTRCT000000000000", handle: "writer" };
const text = (s: string) => new TextEncoder().encode(s);

/** A file's text at a path in a commit, or undefined when nothing is there. */
const fileAt = (repo: RepoRef, commit: CommitSha, path: string) =>
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const entry = (yield* host.readTree(repo, commit)).find(
      (e) => e.path === path && e.type === "blob",
    );
    return entry === undefined
      ? undefined
      : new TextDecoder().decode(yield* host.readBlob(repo, entry.oid));
  });

/** A trunk with three files and a workspace forked from it, whose main is the base. */
const forked = Effect.gen(function* () {
  const host = yield* CodeHost;
  const fixture = yield* CodeHostFixture;
  const trunk = fixture.scratch();
  yield* host.create(trunk);
  const base = yield* fixture.commit(trunk, WORKSPACE_BRANCH, {
    "README.md": "base\n",
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
  });
  const workspace = yield* host.fork(trunk, fixture.scratch());
  return { trunk, base, workspace };
});

export function describeWorkspaceWriterContract(
  adapter: string,
  make: () => WorkspaceWriterHarness,
) {
  describe(`WorkspaceWriter contract: ${adapter}`, () => {
    it.live(
      "[writer.contract.commit] the edits land as one commit on the head, on the workspace's main only, and keep every file they don't name",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const writer = yield* WorkspaceWriter;
          const { trunk, base, workspace } = yield* forked;
          const edits: WorkspaceEdit[] = [
            { path: "src/a.ts", content: text("export const a = 10;\n") },
            { path: "src/new/c.ts", content: text("export const c = 3;\n") },
            { path: "README.md", delete: true },
          ];
          const made = yield* writer.commit(workspace, {
            expectedHead: base,
            parent: base,
            edits,
            message: "Change a, add c, drop the README",
            author: AUTHOR,
            at: AT,
          });
          expect(made.changed).toBe(3);
          expect(yield* host.head(workspace, WORKSPACE_BRANCH)).toBe(made.commitSha);
          expect((yield* host.readCommit(workspace, made.commitSha)).parents).toEqual([base]);
          expect({
            a: yield* fileAt(workspace, made.commitSha, "src/a.ts"),
            b: yield* fileAt(workspace, made.commitSha, "src/b.ts"),
            c: yield* fileAt(workspace, made.commitSha, "src/new/c.ts"),
            readme: yield* fileAt(workspace, made.commitSha, "README.md"),
          }).toEqual({
            a: "export const a = 10;\n",
            b: "export const b = 2;\n",
            c: "export const c = 3;\n",
            readme: undefined,
          });
          expect(yield* host.head(trunk, WORKSPACE_BRANCH)).toBe(base);
        }).pipe(Effect.provide(make().layer)),
    );

    it.live(
      "[writer.contract.head-moved] a main that moved since the agent read it refuses with where it is, and nothing moves",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const writer = yield* WorkspaceWriter;
          const { base, workspace } = yield* forked;
          const pushed = yield* fixture.commit(workspace, WORKSPACE_BRANCH, {
            "README.md": "pushed\n",
          });
          const refused = yield* Effect.flip(
            writer.commit(workspace, {
              expectedHead: base,
              parent: base,
              edits: [{ path: "src/a.ts", content: text("export const a = 10;\n") }],
              message: "Change a",
              author: AUTHOR,
              at: AT,
            }),
          );
          expect(refused).toMatchObject({
            _tag: "WorkspaceHeadMoved",
            expected: base,
            head: pushed,
          });
          expect(yield* host.head(workspace, WORKSPACE_BRANCH)).toBe(pushed);
        }).pipe(Effect.provide(make().layer)),
    );

    it.live(
      "[writer.contract.replay] the same commit sent again answers the commit already at the head",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const writer = yield* WorkspaceWriter;
          const { base, workspace } = yield* forked;
          const request = {
            expectedHead: base,
            parent: base,
            edits: [{ path: "src/a.ts", content: text("export const a = 10;\n") }],
            message: "Change a",
            author: AUTHOR,
            at: AT,
          };
          const first = yield* writer.commit(workspace, request);
          const again = yield* writer.commit(workspace, request);
          expect(again.commitSha).toBe(first.commitSha);
          expect(yield* host.head(workspace, WORKSPACE_BRANCH)).toBe(first.commitSha);
        }).pipe(Effect.provide(make().layer)),
    );

    it.live(
      "[writer.contract.on-parent] a commit on another parent (trunk's head after a rebase) replaces main and descends from that parent",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const writer = yield* WorkspaceWriter;
          const { base, workspace } = yield* forked;
          const work = yield* fixture.commit(workspace, WORKSPACE_BRANCH, {
            "README.md": "base\n",
            "src/a.ts": "export const a = 1;\n",
            "src/b.ts": "export const b = 2;\n",
            "mine.md": "mine\n",
          });
          const onto = yield* fixture.commit(
            workspace,
            "refs/heads/keel/trunk",
            {
              "README.md": "landed\n",
              "src/a.ts": "export const a = 1;\n",
              "src/b.ts": "export const b = 2;\n",
            },
            [base],
          );
          const made = yield* writer.commit(workspace, {
            expectedHead: work,
            parent: onto,
            edits: [{ path: "mine.md", content: text("mine\n") }],
            message: "Mine, on trunk's head",
            author: AUTHOR,
            at: AT,
          });
          expect(yield* host.head(workspace, WORKSPACE_BRANCH)).toBe(made.commitSha);
          expect(yield* host.isAncestor(workspace, onto, made.commitSha, [base])).toBe(true);
          expect(yield* fileAt(workspace, made.commitSha, "README.md")).toBe("landed\n");
        }).pipe(Effect.provide(make().layer)),
    );

    it.live(
      "[writer.contract.refused] edits that cannot apply, or change nothing, refuse and move nothing",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const writer = yield* WorkspaceWriter;
          const { base, workspace } = yield* forked;
          const attempt = (edits: WorkspaceEdit[]) =>
            Effect.flip(
              writer.commit(workspace, {
                expectedHead: base,
                parent: base,
                edits,
                message: "Try",
                author: AUTHOR,
                at: AT,
              }),
            );
          expect(yield* attempt([{ path: "gone.ts", delete: true }])).toMatchObject({
            _tag: "EditsRefused",
            reason: "missing",
            path: "gone.ts",
          });
          expect(yield* attempt([{ path: "README.md", content: text("base\n") }])).toMatchObject({
            _tag: "EditsRefused",
            reason: "nothing-changed",
          });
          expect(yield* attempt([{ path: "src", content: text("x") }])).toMatchObject({
            _tag: "EditsRefused",
            reason: "is-directory",
          });
          expect(yield* host.head(workspace, WORKSPACE_BRANCH)).toBe(base);
        }).pipe(Effect.provide(make().layer)),
    );

    it.live(
      "[writer.contract.missing] a parent the workspace lacks is ObjectNotFound; a workspace that is gone is RepoNotFound",
      () =>
        Effect.gen(function* () {
          const fixture = yield* CodeHostFixture;
          const writer = yield* WorkspaceWriter;
          const { base, workspace } = yield* forked;
          const absent = CommitSha.make("0123456789abcdef0123456789abcdef01234567");
          const request = {
            expectedHead: base,
            parent: absent,
            edits: [{ path: "x", content: text("x") }],
            message: "Try",
            author: AUTHOR,
            at: AT,
          };
          expect(yield* Effect.flip(writer.commit(workspace, request))).toMatchObject({
            _tag: "ObjectNotFound",
            oid: absent,
          });
          const gone = fixture.scratch();
          expect(
            yield* Effect.flip(writer.commit(gone, { ...request, parent: base })),
          ).toMatchObject({ _tag: "RepoNotFound" });
        }).pipe(Effect.provide(make().layer)),
    );
  });
}
