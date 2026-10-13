import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectId } from "../../../src/domain/kernel/index.ts";
import { PrecheckDecision, refuseUnplaced } from "../../../src/application/verification/index.ts";

const PROJECT = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0");

describe("a submission to a project with no place", () => {
  it("[t5.precheck.unplaced] is refused naming the project and what cannot be done, with a person's next action", () => {
    const decision = refuseUnplaced(PROJECT);
    expect(decision).toEqual({
      _tag: "Refuse",
      reasons: [
        "precheck:project-unplaced:project prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0 belongs to no namespace, so nothing of this change can be kept or verified",
      ],
      nextActions: [
        {
          kind: "escalate",
          title:
            "Ask the project's owner to create a project in a namespace and submit this change there: this project has no place in one",
          args: { projectId: "prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
        },
      ],
    });
    // It is a decision Precheck can keep and replay as it does every other.
    expect(
      Schema.decodeUnknownSync(PrecheckDecision)(
        JSON.parse(JSON.stringify(Schema.encodeSync(PrecheckDecision)(decision))),
      ),
    ).toEqual(decision);
  });
});
