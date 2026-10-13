import { describe, expect, it } from "@effect/vitest";
import type { Actor, InvitationScopes } from "@keeltown/core/domain/identity";
import { AgentId, Instant, NamespaceId, UserId } from "@keeltown/core/kernel";
import { Invitations, NamespaceAgents } from "@keeltown/core/ports";
import { Effect, type Layer, Option, Schema } from "effect";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

const anOrg = () => Schema.decodeUnknownSync(NamespaceId)(`org_${ulid()}`);
const anAgent = () => Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`);
const aUser = () => Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`);
const person = (userId: UserId): Actor => ({ _tag: "User", userId });
const itself = (agentId: AgentId): Actor => ({ _tag: "Agent", agentId });
const key = () => `invite-${crypto.randomUUID()}`;

const BOTH: InvitationScopes = ["agent:read", "agent:work"];
const READ: InvitationScopes = ["agent:read"];
const T = (n: number) => Instant(1_760_000_000_000 + n);

/** What the request gate reads of an agent in a namespace: who answers for it and what it may hold, or nothing. */
const standing = (agentId: AgentId, namespace: NamespaceId) =>
  NamespaceAgents.use((rows) => rows.standing(agentId, namespace)).pipe(
    Effect.map(Option.map((held) => [held.by, [...held.scopes].toSorted()] as const)),
    Effect.map(Option.getOrNull),
  );

/** Where the row stands, or null when none stands. */
const state = (agentId: AgentId, namespace: NamespaceId) =>
  NamespaceAgents.use((rows) => rows.find(agentId, namespace)).pipe(
    Effect.map(Option.map((held) => held.state)),
    Effect.map(Option.getOrNull),
  );

export function describeNamespaceAgentsContract(
  adapter: string,
  make: () => Layer.Layer<NamespaceAgents>,
) {
  describe(`NamespaceAgents contract: ${adapter}`, () => {
    it.live(
      "[nsagents.contract] a pending invitation gives no standing, an accepted one its inviter and its scopes, an ended one nothing again",
      () =>
        Effect.gen(function* () {
          const rows = yield* NamespaceAgents;
          const [namespace, agentId, by] = [anOrg(), anAgent(), aUser()];
          const at = { namespace, agentId };
          expect(yield* standing(agentId, namespace)).toBeNull();
          expect(yield* state(agentId, namespace)).toBeNull();

          expect(yield* rows.apply({ _tag: "Invited", ...at, by, scopes: BOTH, at: T(1) }, 1)).toBe(
            true,
          );
          expect(yield* standing(agentId, namespace)).toBeNull();
          expect(yield* state(agentId, namespace)).toBe("invited");

          expect(yield* rows.apply({ _tag: "Joined", ...at, at: T(2) }, 2)).toBe(true);
          expect(yield* standing(agentId, namespace)).toEqual([by, ["agent:read", "agent:work"]]);
          const joined = Option.getOrThrow(yield* rows.find(agentId, namespace));
          expect(joined).toMatchObject({ state: "joined", by, invitedAt: T(1), joinedAt: T(2) });

          expect(yield* rows.apply({ _tag: "Left", ...at }, 3)).toBe(true);
          expect(yield* standing(agentId, namespace)).toBeNull();
          expect(yield* state(agentId, namespace)).toBeNull();
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[nsagents.contract] a late or repeated move never moves a row back, and is answered as held",
      () =>
        Effect.gen(function* () {
          const rows = yield* NamespaceAgents;
          const [namespace, agentId, by] = [anOrg(), anAgent(), aUser()];
          const at = { namespace, agentId };
          yield* rows.apply({ _tag: "Invited", ...at, by, scopes: BOTH, at: T(1) }, 1);
          yield* rows.apply({ _tag: "Joined", ...at, at: T(2) }, 2);
          yield* rows.apply({ _tag: "Left", ...at }, 3);

          // The acceptance arrives again after the end: the agent taken out does not stand again.
          expect(yield* rows.apply({ _tag: "Joined", ...at, at: T(2) }, 2)).toBe(true);
          expect(yield* standing(agentId, namespace)).toBeNull();
          expect(yield* state(agentId, namespace)).toBeNull();
          // The invitation arrives after both: nothing is pending again.
          expect(yield* rows.apply({ _tag: "Invited", ...at, by, scopes: BOTH, at: T(1) }, 1)).toBe(
            true,
          );
          expect(yield* state(agentId, namespace)).toBeNull();
          expect(yield* rows.inNamespace(namespace)).toEqual([]);
          // And an accepted row is not taken back to pending by its own invitation coming again.
          const other = anAgent();
          const there = { namespace, agentId: other };
          yield* rows.apply({ _tag: "Invited", ...there, by, scopes: BOTH, at: T(4) }, 4);
          yield* rows.apply({ _tag: "Joined", ...there, at: T(5) }, 5);
          expect(
            yield* rows.apply({ _tag: "Invited", ...there, by, scopes: READ, at: T(4) }, 4),
          ).toBe(true);
          expect(yield* standing(other, namespace)).toEqual([by, ["agent:read", "agent:work"]]);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[nsagents.contract] an acceptance or an end that finds no row writes nothing and says so, and holds once its invitation is written",
      () =>
        Effect.gen(function* () {
          const rows = yield* NamespaceAgents;
          const [namespace, agentId, by] = [anOrg(), anAgent(), aUser()];
          const at = { namespace, agentId };
          expect(yield* rows.apply({ _tag: "Joined", ...at, at: T(2) }, 2)).toBe(false);
          expect(yield* rows.apply({ _tag: "Left", ...at }, 3)).toBe(false);
          expect(yield* state(agentId, namespace)).toBeNull();

          expect(yield* rows.apply({ _tag: "Invited", ...at, by, scopes: READ, at: T(1) }, 1)).toBe(
            true,
          );
          expect(yield* rows.apply({ _tag: "Joined", ...at, at: T(2) }, 2)).toBe(true);
          expect(yield* standing(agentId, namespace)).toEqual([by, ["agent:read"]]);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[nsagents.contract] invited again after an end, the row is the new invitation's: its member, its scopes, and pending until accepted",
      () =>
        Effect.gen(function* () {
          const rows = yield* NamespaceAgents;
          const [namespace, agentId, first, second] = [anOrg(), anAgent(), aUser(), aUser()];
          const at = { namespace, agentId };
          yield* rows.apply({ _tag: "Invited", ...at, by: first, scopes: BOTH, at: T(1) }, 1);
          yield* rows.apply({ _tag: "Joined", ...at, at: T(2) }, 2);
          yield* rows.apply({ _tag: "Left", ...at }, 3);

          yield* rows.apply({ _tag: "Invited", ...at, by: second, scopes: READ, at: T(4) }, 4);
          expect(yield* standing(agentId, namespace)).toBeNull();
          const again = Option.getOrThrow(yield* rows.find(agentId, namespace));
          expect(again).toMatchObject({ state: "invited", by: second, invitedAt: T(4) });
          expect(again.joinedAt).toBeUndefined();

          yield* rows.apply({ _tag: "Joined", ...at, at: T(5) }, 5);
          expect(yield* standing(agentId, namespace)).toEqual([second, ["agent:read"]]);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[nsagents.contract] a namespace's list and an agent's hold what stands there, oldest invitation first, and nothing of another's",
      () =>
        Effect.gen(function* () {
          const rows = yield* NamespaceAgents;
          const [here, there, by] = [anOrg(), anOrg(), aUser()];
          const [early, late, gone] = [anAgent(), anAgent(), anAgent()];
          yield* rows.apply(
            { _tag: "Invited", namespace: here, agentId: late, by, scopes: BOTH, at: T(20) },
            1,
          );
          yield* rows.apply(
            { _tag: "Invited", namespace: here, agentId: early, by, scopes: READ, at: T(10) },
            2,
          );
          yield* rows.apply({ _tag: "Joined", namespace: here, agentId: early, at: T(30) }, 3);
          yield* rows.apply(
            { _tag: "Invited", namespace: here, agentId: gone, by, scopes: BOTH, at: T(5) },
            4,
          );
          yield* rows.apply({ _tag: "Left", namespace: here, agentId: gone }, 5);
          yield* rows.apply(
            { _tag: "Invited", namespace: there, agentId: early, by, scopes: BOTH, at: T(40) },
            1,
          );

          const inHere = yield* rows.inNamespace(here);
          expect(inHere.map((row) => [row.agentId, row.state])).toEqual([
            [early, "joined"],
            [late, "invited"],
          ]);
          const ofEarly = yield* rows.ofAgent(early);
          expect(ofEarly.map((row) => [row.namespace, row.state])).toEqual([
            [here, "joined"],
            [there, "invited"],
          ]);
          expect(yield* rows.ofAgent(gone)).toEqual([]);
          // An agent that joined one namespace has no standing in another that only invited it.
          expect(yield* standing(early, there)).toBeNull();
        }).pipe(Effect.provide(make())),
    );
  });
}

/** Why a move was refused, or the state the invitation was answered in. */
const outcome = <E extends { readonly _tag: string }>(
  move: Effect.Effect<{ readonly state: string }, E, Invitations>,
) =>
  move.pipe(
    Effect.match({
      onSuccess: (invitation) => invitation.state,
      onFailure: (error) =>
        "reason" in error && typeof error.reason === "string" ? error.reason : error._tag,
    }),
  );

/** The `Invitations` suite reads each move's row back from `NamespaceAgents`: what the request gate reads next. */
export function describeInvitationsContract(
  adapter: string,
  make: () => Layer.Layer<Invitations | NamespaceAgents>,
) {
  describe(`Invitations contract: ${adapter}`, () => {
    it.live(
      "[invitations.contract] a member invites, the agent accepts, and it leaves; each in the rows when it answers",
      () =>
        Effect.gen(function* () {
          const invitations = yield* Invitations;
          const [namespace, agentId, by] = [anOrg(), anAgent(), aUser()];
          const at = { namespace, agentId };

          const invited = yield* invitations.invite({
            ...at,
            by,
            scopes: BOTH,
            idempotencyKey: key(),
          });
          expect(invited).toMatchObject({ namespace, agentId, by, state: "invited" });
          expect(yield* state(agentId, namespace)).toBe("invited");
          expect(yield* standing(agentId, namespace)).toBeNull();

          const joined = yield* invitations.accept({ ...at, idempotencyKey: key() });
          expect(joined.state).toBe("joined");
          expect(yield* standing(agentId, namespace)).toEqual([by, ["agent:read", "agent:work"]]);

          const left = yield* invitations.end(itself(agentId), { ...at, idempotencyKey: key() });
          expect(left.state).toBe("ended");
          expect(yield* standing(agentId, namespace)).toBeNull();
          expect(yield* state(agentId, namespace)).toBeNull();
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[invitations.contract] one member answers for an agent: the same member again changes nothing, and another member or other scopes are refused while it stands",
      () =>
        Effect.gen(function* () {
          const invitations = yield* Invitations;
          const [namespace, agentId, first, second] = [anOrg(), anAgent(), aUser(), aUser()];
          const at = { namespace, agentId };
          const invite = (by: UserId, scopes: InvitationScopes) =>
            outcome(invitations.invite({ ...at, by, scopes, idempotencyKey: key() }));

          expect(yield* invite(first, BOTH)).toBe("invited");
          expect(yield* invite(first, BOTH)).toBe("invited");
          expect(yield* invite(second, BOTH)).toBe("already-invited");
          expect(yield* invite(first, READ)).toBe("already-invited");
          expect(
            Option.getOrThrow(yield* NamespaceAgents.use((r) => r.find(agentId, namespace))).by,
          ).toBe(first);

          yield* invitations.accept({ ...at, idempotencyKey: key() });
          expect(yield* invite(first, BOTH)).toBe("joined");
          expect(yield* invite(second, BOTH)).toBe("already-invited");
          expect(yield* standing(agentId, namespace)).toEqual([
            first,
            ["agent:read", "agent:work"],
          ]);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[invitations.contract] only an invited agent accepts, accepting again changes nothing, and nothing ends where nothing stands",
      () =>
        Effect.gen(function* () {
          const invitations = yield* Invitations;
          const [namespace, agentId, by] = [anOrg(), anAgent(), aUser()];
          const at = { namespace, agentId };
          const accept = () => outcome(invitations.accept({ ...at, idempotencyKey: key() }));
          const end = (actor: Actor) =>
            outcome(invitations.end(actor, { ...at, idempotencyKey: key() }));

          expect(yield* accept()).toBe("not-invited");
          expect(yield* end(itself(agentId))).toBe("not-invited");
          expect(yield* end(person(by))).toBe("not-invited");
          expect(yield* standing(agentId, namespace)).toBeNull();

          yield* invitations.invite({ ...at, by, scopes: READ, idempotencyKey: key() });
          expect(yield* accept()).toBe("joined");
          expect(yield* accept()).toBe("joined");
          expect(yield* standing(agentId, namespace)).toEqual([by, ["agent:read"]]);

          // Another agent is no party to it.
          expect(yield* end(itself(anAgent()))).toBe("not-a-party");
          expect(yield* standing(agentId, namespace)).toEqual([by, ["agent:read"]]);

          // A person takes it out, and the agent has nothing there to accept or leave.
          expect(yield* end(person(aUser()))).toBe("ended");
          expect(yield* accept()).toBe("not-invited");
          expect(yield* end(itself(agentId))).toBe("not-invited");
          expect(yield* standing(agentId, namespace)).toBeNull();
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[invitations.contract] ended, the agent is invited again by another member, on what that member gives",
      () =>
        Effect.gen(function* () {
          const invitations = yield* Invitations;
          const [namespace, agentId, first, second] = [anOrg(), anAgent(), aUser(), aUser()];
          const at = { namespace, agentId };
          yield* invitations.invite({ ...at, by: first, scopes: BOTH, idempotencyKey: key() });
          // The member who made it takes back an invitation not yet accepted.
          const withdrawn = yield* invitations.end(person(first), { ...at, idempotencyKey: key() });
          expect(withdrawn.state).toBe("ended");

          const again = yield* invitations.invite({
            ...at,
            by: second,
            scopes: READ,
            idempotencyKey: key(),
          });
          expect(again).toMatchObject({ by: second, state: "invited" });
          yield* invitations.accept({ ...at, idempotencyKey: key() });
          expect(yield* standing(agentId, namespace)).toEqual([second, ["agent:read"]]);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[invitations.contract] a key sent again with its body answers the invitation as it stands; with another body it is refused",
      () =>
        Effect.gen(function* () {
          const invitations = yield* Invitations;
          const [namespace, agentId, by] = [anOrg(), anAgent(), aUser()];
          const at = { namespace, agentId };
          const inviting = { ...at, by, scopes: BOTH, idempotencyKey: key() };
          yield* invitations.invite(inviting);
          yield* invitations.accept({ ...at, idempotencyKey: key() });

          // The first call's retry arrives after the agent accepted: it reads what stands now.
          expect(yield* outcome(invitations.invite(inviting))).toBe("joined");
          expect(yield* outcome(invitations.invite({ ...inviting, scopes: READ }))).toBe(
            "IdempotencyConflict",
          );
          expect(yield* outcome(invitations.invite({ ...inviting, by: aUser() }))).toBe(
            "IdempotencyConflict",
          );
          expect(yield* standing(agentId, namespace)).toEqual([by, ["agent:read", "agent:work"]]);

          const ending = { ...at, idempotencyKey: key() };
          expect(yield* outcome(invitations.end(person(by), ending))).toBe("ended");
          expect(yield* outcome(invitations.end(person(by), ending))).toBe("ended");
          expect(yield* outcome(invitations.end(itself(agentId), ending))).toBe(
            "IdempotencyConflict",
          );
        }).pipe(Effect.provide(make())),
    );
  });
}
