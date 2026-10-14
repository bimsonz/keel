// A change told where its preview answers: its Change DO commits
// PreviewDeployed on the change's stream, once per deployment, and its agent's
// inbox says where the preview is. The use-case runs over one Change DO's
// in-memory state, declared as an agent declares it; the adapter's case
// crosses the object's own codec.
import { describe, expect, it } from "@effect/vitest";
import { declare } from "@keeltown/core/application/coordination";
import { tellPreview } from "@keeltown/core/application/delivery";
import { detailOf } from "@keeltown/core/application/identity";
import { DeployTargetName } from "@keeltown/core/domain/delivery";
import { CommitSha, makeId, type EventEnvelope } from "@keeltown/core/kernel";
import {
  type Clock,
  type EntityStore,
  EventOutbox,
  type PreviewNotice,
  PreviewNotices,
} from "@keeltown/core/ports";
import {
  makeCodeHostMemory,
  makeDecisionsMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLiveChangesMemory,
  makeManualClock,
  makeWorkspacePoolMemory,
  sampleProjectId,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import {
  type PreviewNoticesStub,
  PreviewNoticesRpc,
} from "../../src/adapters/driven/do-rpc/preview-notices.ts";
import {
  ChangeCodecs,
  DeclareCommand,
  encodeExit,
  TellPreviewCommand,
} from "../../src/rpc/index.ts";

const CHANGE = makeId("chg", "01M4P00000000000000000000H");
const NEVER_MADE = makeId("chg", "01M4P00000000000000000000J");
const AGENT = makeId("agt", "01M4P00000000000000000000A");
const FIRST = makeId("dpl", "01M4P00000000000000000000F");
const SECOND = makeId("dpl", "01M4P00000000000000000000G");
const CANDIDATE = makeId("cnd", "01M4P00000000000000000000C");
const target = Schema.decodeSync(DeployTargetName);
const URL = "https://00000001-worker-lite.acme.workers.dev";
const ALIAS = "https://ch-000000000h-worker-lite.acme.workers.dev";

/** A preview's notice; `aliased` when the candidate is the change's alone, so it has the change's own address. */
const notice = (deploymentId = FIRST, aliased = true): PreviewNotice => ({
  deploymentId,
  candidateId: CANDIDATE,
  target: target("preview"),
  url: URL,
  ...(aliased ? { aliasUrl: ALIAS } : {}),
});

const Told = Schema.Struct({
  deploymentId: Schema.String,
  aliasUrl: Schema.optional(Schema.String),
});
const toldOf = (event: EventEnvelope) => Schema.decodeUnknownSync(Told)(event.payload);

/** One Change DO's state, in memory, with the pool and code host a declare takes its workspace from. */
function changeObject() {
  return Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeIdsMemory().layer,
    makeManualClock().layer,
    makeWorkspacePoolMemory({ baseSha: CommitSha.make("b".repeat(40)) }).layer,
    makeCodeHostMemory().layer,
    makeLiveChangesMemory().layer,
    makeDecisionsMemory().layer,
  );
}

const declared = declare(
  Schema.decodeUnknownSync(DeclareCommand)({
    changeId: CHANGE,
    agentId: AGENT,
    projectId: sampleProjectId,
    goal: "Serve a health check",
    footprint: [{ path: "src/**", op: "edit" }],
    premises: [],
    idempotencyKey: "declare-1",
    fingerprint: "body-1",
  }),
);

/** The PreviewDeployed events a change's stream holds. */
const previews = (changeId = CHANGE) =>
  Effect.map(EventOutbox, (outbox): readonly EventEnvelope[] =>
    outbox
      .log({ kind: "change", id: changeId })
      .filter((event) => event.type === "PreviewDeployed"),
  );

describe("a change told where its preview answers", () => {
  it.effect(
    "[preview.told] a change is told on its own stream, for its agent and in its project, with the candidate's world and Cloudflare as the provider",
    () =>
      Effect.gen(function* () {
        yield* declared;
        yield* tellPreview(CHANGE, notice());
        const [told, ...more] = yield* previews();
        expect(more).toEqual([]);
        expect(told?.payload).toEqual({
          _tag: "PreviewDeployed",
          deploymentId: FIRST,
          changeId: CHANGE,
          candidateId: CANDIDATE,
          world: "candidate",
          target: "preview",
          provider: "cloudflare",
          url: URL,
          aliasUrl: ALIAS,
        });
        expect(told?.project).toBe(sampleProjectId);
        expect(told?.notified).toContain(`agent:${AGENT}`);
      }).pipe(Effect.provide(changeObject())),
  );

  it.effect(
    "[preview.told-once] the same deployment told again commits nothing more; another deployment of the change is told of its own",
    () =>
      Effect.gen(function* () {
        yield* declared;
        yield* tellPreview(CHANGE, notice());
        yield* tellPreview(CHANGE, notice());
        yield* tellPreview(CHANGE, notice(SECOND, false));
        expect((yield* previews()).map(toldOf)).toEqual([
          { deploymentId: FIRST, aliasUrl: ALIAS },
          { deploymentId: SECOND },
        ]);
      }).pipe(Effect.provide(changeObject())),
  );

  it.effect(
    "[preview.never-made] a change its object never made is told nothing, and the telling does not fail",
    () =>
      Effect.gen(function* () {
        yield* tellPreview(NEVER_MADE, notice());
        expect(yield* previews(NEVER_MADE)).toEqual([]);
      }).pipe(Effect.provide(changeObject())),
  );

  it.effect(
    "[preview.inbox-detail] the agent's inbox names where the preview answers: the change's own address when it has one, else the candidate's version",
    () =>
      Effect.gen(function* () {
        yield* declared;
        yield* tellPreview(CHANGE, notice(FIRST, true));
        yield* tellPreview(CHANGE, notice(SECOND, false));
        expect((yield* previews()).map(detailOf)).toEqual([
          `a preview of your change answers at ${ALIAS}`,
          `a preview of your change answers at ${URL}`,
        ]);
      }).pipe(Effect.provide(changeObject())),
  );
});

describe("PreviewNoticesRpc", () => {
  it.effect(
    "[preview.rpc] the port over the Change DO's method tells the change as the use-case does, its alias crossing when there is one",
    () => {
      const object = changeObject();
      const answer = (program: Effect.Effect<void, never, Clock | EntityStore | EventOutbox>) =>
        Effect.runPromiseExit(program.pipe(Effect.provide(object))).then((exit) =>
          encodeExit(ChangeCodecs.tellPreview, exit),
        );
      const told: string[] = [];
      const stub = (changeId: string): PreviewNoticesStub => ({
        tellPreview: (command) => {
          told.push(changeId);
          return answer(
            Effect.flatMap(
              Effect.orDie(Schema.decodeUnknownEffect(TellPreviewCommand)(command)),
              ({ changeId: toldTo, ...rest }) => tellPreview(toldTo, rest),
            ),
          );
        },
      });
      return Effect.gen(function* () {
        yield* declared.pipe(Effect.provide(object));
        const notices = yield* PreviewNotices;
        yield* notices.tell(CHANGE, notice(FIRST, true));
        yield* notices.tell(CHANGE, notice(SECOND, false));
        expect(told).toEqual([CHANGE, CHANGE]);
        expect(
          (yield* previews().pipe(Effect.provide(object))).map((event) => event.payload),
        ).toEqual([
          expect.objectContaining({ deploymentId: FIRST, url: URL, aliasUrl: ALIAS }),
          expect.not.objectContaining({ aliasUrl: expect.anything() }),
        ]);
      }).pipe(Effect.provide(PreviewNoticesRpc(stub)));
    },
  );
});
