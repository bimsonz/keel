import { audienceOf, EVENT_AUDIENCE } from "@keeltown/core/application/coordination";
import { CoordinationEvent } from "@keeltown/core/domain/coordination";
import { DeliveryEvent } from "@keeltown/core/domain/delivery";
import { IdentityEvent } from "@keeltown/core/domain/identity";
import { IntegrationEvent } from "@keeltown/core/domain/integration";
import { MemoryEvent } from "@keeltown/core/domain/memory";
import { VerificationEvent } from "@keeltown/core/domain/verification";
import { SchemaAST } from "effect";
import { describe, expect, it } from "vitest";

/** Every event schema core commits, as its type and its payload's field names. */
const events = [
  IdentityEvent,
  CoordinationEvent,
  IntegrationEvent,
  VerificationEvent,
  MemoryEvent,
  DeliveryEvent,
].flatMap((context): { type: string; fields: string[] }[] => {
  const ast: SchemaAST.AST = context.ast;
  return (SchemaAST.isUnion(ast) ? ast.types : [ast]).filter(SchemaAST.isObjects).map((struct) => {
    const tag = struct.propertySignatures.find((field) => field.name === "_tag")?.type;
    return {
      type: tag !== undefined && SchemaAST.isLiteral(tag) ? String(tag.literal) : "",
      fields: struct.propertySignatures.map((field) => String(field.name)),
    };
  });
});

describe("[b12.event-audience] who an event on a public project's feed is for", () => {
  it("[b12.event-audience] keeps operator data, settings, escalations, rulings and sessions to the project's members, and every other event public", () => {
    const members = events.filter((event) => audienceOf(event.type) === "members");
    expect(members.map((event) => event.type).toSorted()).toEqual(
      [
        "AgentEnrolled",
        "AgentSuspended",
        "AgentReinstated",
        "AgentRevoked",
        "ProjectSettingsChanged",
        "EscalationRaised",
        "EscalationWithdrawn",
        "RulingGiven",
        "OverruleRequested",
        "SessionOpened",
        "MessagesCaptured",
        "SessionRedacted",
        "UserSignedUp",
        "OrgCreated",
        "MembershipChanged",
        "UserSuspended",
        "UserReinstated",
        "OrgSuspended",
        "OrgReinstated",
        "OrgDeleted",
        "ProjectDeleted",
        "DeployTargetSet",
        "DeployTargetCleared",
      ].toSorted(),
    );
    // That a conflict waits on a ruling is the conflict's state; what was asked stays with members.
    expect(audienceOf("ConflictEscalated")).toBe("public");
    expect(Object.keys(EVENT_AUDIENCE).toSorted()).toEqual(
      events.map((event) => event.type).toSorted(),
    );
  });

  it("[b12.event-audience] serves no sponsor publicly: only members-only events carry onBehalfOf", () => {
    const sponsored = events.filter((event) => event.fields.includes("onBehalfOf"));
    // The check can see a sponsor: enrolment and sessions carry one.
    expect(sponsored.map((event) => event.type).toSorted()).toEqual([
      "AgentEnrolled",
      "SessionOpened",
    ]);
    expect(sponsored.every((event) => audienceOf(event.type) === "members")).toBe(true);
  });

  it("[b12.event-audience] keeps an event type this build does not know to members", () => {
    expect(audienceOf("SomethingNewHappened")).toBe("members");
    expect(audienceOf("IntentDeclared")).toBe("public");
  });
});
