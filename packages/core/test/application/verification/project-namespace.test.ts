import { Effect, Layer, Option, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  describeNoNamespace,
  jobNamespace,
  NamespaceMisnamed,
  projectNamespace,
  ProjectUnplaced,
} from "../../../src/application/verification/index.ts";
import { ProjectNamespaces } from "../../../src/application/ports/index.ts";
import { NamespaceId, ProjectId } from "../../../src/domain/kernel/index.ts";

const NAMESPACE = Schema.decodeUnknownSync(NamespaceId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const OTHER = Schema.decodeUnknownSync(NamespaceId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V1");
const PLACED = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V2");
const UNPLACED = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V3");

/** The projects' places with one project placed, in NAMESPACE: every other project has no place. */
const places = Layer.succeed(
  ProjectNamespaces,
  ProjectNamespaces.of({
    assign: () => Effect.die("unused"),
    release: () => Effect.die("unused"),
    byId: (projectId) =>
      Effect.succeed(
        projectId === PLACED
          ? Option.some({ projectId, namespace: NAMESPACE, name: "forge" })
          : Option.none(),
      ),
    byName: () => Effect.die("unused"),
    inNamespace: () => Effect.die("unused"),
    shownTo: () => Effect.die("unused"),
    visibility: () => Effect.die("unused"),
  }),
);

const read = <A, E>(effect: Effect.Effect<A, E, ProjectNamespaces>) =>
  Effect.runSync(Effect.result(effect).pipe(Effect.provide(places)));

/** What a read was refused with: one that answered a namespace fails the test. */
const refusal = <A, E>(answer: Result.Result<A, E>): E => {
  if (Result.isSuccess(answer)) throw new Error(`answered ${String(answer.success)}`);
  return answer.failure;
};

describe("the namespace a project's objects are kept under", () => {
  it("[t5.project-namespace] a placed project answers its namespace, and one with no place is refused naming it, never answered another project's", () => {
    expect(read(projectNamespace(PLACED))).toEqual(Result.succeed(NAMESPACE));
    const unplaced = refusal(read(projectNamespace(UNPLACED)));
    expect(unplaced._tag).toBe("ProjectUnplaced");
    expect(unplaced.projectId).toBe(UNPLACED);
  });

  it("[t5.job-namespace] a job naming its project's namespace answers it, one naming another is refused with the project and both namespaces, and an unplaced project's job is refused as unplaced", () => {
    expect(read(jobNamespace(PLACED, NAMESPACE))).toEqual(Result.succeed(NAMESPACE));
    expect(refusal(read(jobNamespace(PLACED, OTHER)))).toMatchObject({
      _tag: "NamespaceMisnamed",
      projectId: PLACED,
      named: OTHER,
      namespace: NAMESPACE,
    });
    const unplaced = refusal(read(jobNamespace(UNPLACED, NAMESPACE)));
    expect(unplaced._tag).toBe("ProjectUnplaced");
    expect(unplaced.projectId).toBe(UNPLACED);
  });

  it("[t5.no-namespace-text] each refusal reads as one sentence naming the project, and both namespaces when a job misnames its own", () => {
    expect(describeNoNamespace(new ProjectUnplaced({ projectId: UNPLACED }))).toBe(
      "project prj_01JZ8PT2C4E6G8J0M2N4Q6S8V3 belongs to no namespace",
    );
    expect(
      describeNoNamespace(
        new NamespaceMisnamed({ projectId: PLACED, named: OTHER, namespace: NAMESPACE }),
      ),
    ).toBe(
      "project prj_01JZ8PT2C4E6G8J0M2N4Q6S8V2 belongs to namespace org_01JZ8PT2C4E6G8J0M2N4Q6S8V0, and its job names org_01JZ8PT2C4E6G8J0M2N4Q6S8V1",
    );
  });
});
