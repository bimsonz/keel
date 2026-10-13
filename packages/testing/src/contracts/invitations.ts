import { describe, expect, it } from "@effect/vitest";
import type { Actor, Invitation, InvitationScopes } from "@keeltown/core/domain/identity";
import { AgentId, Instant, NamespaceId, ProjectId, UserId } from "@keeltown/core/kernel";
import {
  Invitations,
  type InvitedStanding,
  NamespaceAgents,
  ProjectAgents,
} from "@keeltown/core/ports";
import { Effect, type Layer, Option, Schema } from "effect";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

interface ProjectPlace {
  readonly namespace: NamespaceId;
  readonly projectId: ProjectId;
}

const anOrg = () => Schema.decodeUnknownSync(NamespaceId)(`org_${ulid()}`);
const anAgent = () => Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`);
const aUser = () => Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`);
/** One project of a person's own namespace, whose id is the person's. */
const aProject = (): ProjectPlace => ({
  namespace: Schema.decodeUnknownSync(NamespaceId)(`usr_${ulid()}`),
  projectId: Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`),
});
const person = (userId: UserId): Actor => ({ _tag: "User", userId });
const itself = (agentId: AgentId): Actor => ({ _tag: "Agent", agentId });
const key = () => `invite-${crypto.randomUUID()}`;

const BOTH: InvitationScopes = ["agent:read", "agent:work"];
const READ: InvitationScopes = ["agent:read"];
const T = (n: number) => Instant(1_760_000_000_000 + n);

/** One move of an agent's place before its place is named: what either kind of row is told. */
type Step =
  | {
      readonly _tag: "Invited";
      readonly agentId: AgentId;
      readonly by: UserId;
      readonly scopes: InvitationScopes;
      readonly at: Instant;
    }
  | { readonly _tag: "Joined"; readonly agentId: AgentId; readonly at: Instant }
  | { readonly _tag: "Left"; readonly agentId: AgentId };

/**
 * The rows the request gate reads, for one kind of place: a whole namespace
 * (`NamespaceAgents`) or one project (`ProjectAgents`). One suite holds both
 * to the same rules.
 */
interface Rows<Place> {
  readonly aPlace: () => Place;
  readonly apply: (place: Place, step: Step, seq: number) => Effect.Effect<boolean>;
  readonly standing: (
    agentId: AgentId,
    place: Place,
  ) => Effect.Effect<Option.Option<InvitedStanding>>;
  readonly find: (agentId: AgentId, place: Place) => Effect.Effect<Option.Option<Invitation>>;
  readonly inPlace: (place: Place) => Effect.Effect<readonly Invitation[]>;
  readonly ofAgent: (agentId: AgentId) => Effect.Effect<readonly Invitation[]>;
  /** What names a place among an agent's rows. */
  readonly idOf: (place: Place) => string;
  readonly placeOf: (row: Invitation) => string | undefined;
}

const namespaceRows = (rows: (typeof NamespaceAgents)["Service"]): Rows<NamespaceId> => ({
  aPlace: anOrg,
  apply: (namespace, step, seq) => rows.apply({ ...step, namespace }, seq),
  standing: (agentId, namespace) => rows.standing(agentId, namespace),
  find: (agentId, namespace) => rows.find(agentId, namespace),
  inPlace: (namespace) => rows.inNamespace(namespace),
  ofAgent: (agentId) => rows.ofAgent(agentId),
  idOf: (namespace) => namespace,
  placeOf: (row) => row.namespace,
});

const projectRows = (rows: (typeof ProjectAgents)["Service"]): Rows<ProjectPlace> => ({
  aPlace: aProject,
  apply: ({ namespace, projectId }, step, seq) =>
    rows.apply(
      step._tag === "Invited" ? { ...step, projectId, namespace } : { ...step, projectId },
      seq,
    ),
  standing: (agentId, { projectId }) => rows.standing(agentId, projectId),
  find: (agentId, { projectId }) => rows.find(agentId, projectId),
  inPlace: ({ projectId }) => rows.inProject(projectId),
  ofAgent: (agentId) => rows.ofAgent(agentId),
  idOf: ({ projectId }) => projectId,
  placeOf: (row) => row.projectId,
});

/** What the request gate reads of an agent in a place: who answers for it and what it may hold, or nothing. */
const standingIn = <Place>(rows: Rows<Place>, agentId: AgentId, place: Place) =>
  rows
    .standing(agentId, place)
    .pipe(
      Effect.map(Option.map((held) => [held.by, [...held.scopes].toSorted()] as const)),
      Effect.map(Option.getOrNull),
    );

/** Where the row stands, or null when none stands. */
const stateIn = <Place>(rows: Rows<Place>, agentId: AgentId, place: Place) =>
  rows
    .find(agentId, place)
    .pipe(Effect.map(Option.map((held) => held.state)), Effect.map(Option.getOrNull));

function describeRowsContract<Place>(
  port: string,
  tag: string,
  adapter: string,
  open: () => Effect.Effect<Rows<Place>>,
) {
  describe(`${port} contract: ${adapter}`, () => {
    it.live(
      `[${tag}] a pending invitation gives no standing, an accepted one its inviter and its scopes, an ended one nothing again`,
      () =>
        Effect.gen(function* () {
          const rows = yield* open();
          const [place, agentId, by] = [rows.aPlace(), anAgent(), aUser()];
          expect(yield* standingIn(rows, agentId, place)).toBeNull();
          expect(yield* stateIn(rows, agentId, place)).toBeNull();

          expect(
            yield* rows.apply(place, { _tag: "Invited", agentId, by, scopes: BOTH, at: T(1) }, 1),
          ).toBe(true);
          expect(yield* standingIn(rows, agentId, place)).toBeNull();
          expect(yield* stateIn(rows, agentId, place)).toBe("invited");

          expect(yield* rows.apply(place, { _tag: "Joined", agentId, at: T(2) }, 2)).toBe(true);
          expect(yield* standingIn(rows, agentId, place)).toEqual([
            by,
            ["agent:read", "agent:work"],
          ]);
          const joined = Option.getOrThrow(yield* rows.find(agentId, place));
          expect(joined).toMatchObject({ state: "joined", by, invitedAt: T(1), joinedAt: T(2) });
          expect(rows.placeOf(joined)).toBe(rows.idOf(place));

          expect(yield* rows.apply(place, { _tag: "Left", agentId }, 3)).toBe(true);
          expect(yield* standingIn(rows, agentId, place)).toBeNull();
          expect(yield* stateIn(rows, agentId, place)).toBeNull();
        }),
    );

    it.live(
      `[${tag}] a late or repeated move never moves a row back, and is answered as held`,
      () =>
        Effect.gen(function* () {
          const rows = yield* open();
          const [place, agentId, by] = [rows.aPlace(), anAgent(), aUser()];
          yield* rows.apply(place, { _tag: "Invited", agentId, by, scopes: BOTH, at: T(1) }, 1);
          yield* rows.apply(place, { _tag: "Joined", agentId, at: T(2) }, 2);
          yield* rows.apply(place, { _tag: "Left", agentId }, 3);

          // The acceptance arrives again after the end: the agent taken out does not stand again.
          expect(yield* rows.apply(place, { _tag: "Joined", agentId, at: T(2) }, 2)).toBe(true);
          expect(yield* standingIn(rows, agentId, place)).toBeNull();
          expect(yield* stateIn(rows, agentId, place)).toBeNull();
          // The invitation arrives after both: nothing is pending again.
          expect(
            yield* rows.apply(place, { _tag: "Invited", agentId, by, scopes: BOTH, at: T(1) }, 1),
          ).toBe(true);
          expect(yield* stateIn(rows, agentId, place)).toBeNull();
          expect(yield* rows.inPlace(place)).toEqual([]);
          // And an accepted row is not taken back to pending by its own invitation coming again.
          const other = anAgent();
          yield* rows.apply(
            place,
            { _tag: "Invited", agentId: other, by, scopes: BOTH, at: T(4) },
            4,
          );
          yield* rows.apply(place, { _tag: "Joined", agentId: other, at: T(5) }, 5);
          expect(
            yield* rows.apply(
              place,
              { _tag: "Invited", agentId: other, by, scopes: READ, at: T(4) },
              4,
            ),
          ).toBe(true);
          expect(yield* standingIn(rows, other, place)).toEqual([by, ["agent:read", "agent:work"]]);
        }),
    );

    it.live(
      `[${tag}] an acceptance or an end that finds no row writes nothing and says so, and holds once its invitation is written`,
      () =>
        Effect.gen(function* () {
          const rows = yield* open();
          const [place, agentId, by] = [rows.aPlace(), anAgent(), aUser()];
          expect(yield* rows.apply(place, { _tag: "Joined", agentId, at: T(2) }, 2)).toBe(false);
          expect(yield* rows.apply(place, { _tag: "Left", agentId }, 3)).toBe(false);
          expect(yield* stateIn(rows, agentId, place)).toBeNull();

          expect(
            yield* rows.apply(place, { _tag: "Invited", agentId, by, scopes: READ, at: T(1) }, 1),
          ).toBe(true);
          expect(yield* rows.apply(place, { _tag: "Joined", agentId, at: T(2) }, 2)).toBe(true);
          expect(yield* standingIn(rows, agentId, place)).toEqual([by, ["agent:read"]]);
        }),
    );

    it.live(
      `[${tag}] invited again after an end, the row is the new invitation's: its member, its scopes, and pending until accepted`,
      () =>
        Effect.gen(function* () {
          const rows = yield* open();
          const [place, agentId, first, second] = [rows.aPlace(), anAgent(), aUser(), aUser()];
          yield* rows.apply(
            place,
            { _tag: "Invited", agentId, by: first, scopes: BOTH, at: T(1) },
            1,
          );
          yield* rows.apply(place, { _tag: "Joined", agentId, at: T(2) }, 2);
          yield* rows.apply(place, { _tag: "Left", agentId }, 3);

          yield* rows.apply(
            place,
            { _tag: "Invited", agentId, by: second, scopes: READ, at: T(4) },
            4,
          );
          expect(yield* standingIn(rows, agentId, place)).toBeNull();
          const again = Option.getOrThrow(yield* rows.find(agentId, place));
          expect(again).toMatchObject({ state: "invited", by: second, invitedAt: T(4) });
          expect(again.joinedAt).toBeUndefined();

          yield* rows.apply(place, { _tag: "Joined", agentId, at: T(5) }, 5);
          expect(yield* standingIn(rows, agentId, place)).toEqual([second, ["agent:read"]]);
        }),
    );

    it.live(
      `[${tag}] a place's list and an agent's hold what stands there, oldest invitation first, and nothing of another's`,
      () =>
        Effect.gen(function* () {
          const rows = yield* open();
          const [here, there, by] = [rows.aPlace(), rows.aPlace(), aUser()];
          const [early, late, gone] = [anAgent(), anAgent(), anAgent()];
          yield* rows.apply(
            here,
            { _tag: "Invited", agentId: late, by, scopes: BOTH, at: T(20) },
            1,
          );
          yield* rows.apply(
            here,
            { _tag: "Invited", agentId: early, by, scopes: READ, at: T(10) },
            2,
          );
          yield* rows.apply(here, { _tag: "Joined", agentId: early, at: T(30) }, 3);
          yield* rows.apply(
            here,
            { _tag: "Invited", agentId: gone, by, scopes: BOTH, at: T(5) },
            4,
          );
          yield* rows.apply(here, { _tag: "Left", agentId: gone }, 5);
          yield* rows.apply(
            there,
            { _tag: "Invited", agentId: early, by, scopes: BOTH, at: T(40) },
            1,
          );

          const inHere = yield* rows.inPlace(here);
          expect(inHere.map((row) => [row.agentId, row.state])).toEqual([
            [early, "joined"],
            [late, "invited"],
          ]);
          const ofEarly = yield* rows.ofAgent(early);
          expect(ofEarly.map((row) => [rows.placeOf(row), row.state])).toEqual([
            [rows.idOf(here), "joined"],
            [rows.idOf(there), "invited"],
          ]);
          expect(yield* rows.ofAgent(gone)).toEqual([]);
          // An agent that joined one place has no standing in another that only invited it.
          expect(yield* standingIn(rows, early, there)).toBeNull();
        }),
    );
  });
}

export function describeNamespaceAgentsContract(
  adapter: string,
  make: () => Layer.Layer<NamespaceAgents>,
) {
  describeRowsContract("NamespaceAgents", "nsagents.contract", adapter, () =>
    NamespaceAgents.use((rows) => Effect.succeed(namespaceRows(rows))).pipe(Effect.provide(make())),
  );
}

export function describeProjectAgentsContract(
  adapter: string,
  make: () => Layer.Layer<ProjectAgents>,
) {
  describeRowsContract("ProjectAgents", "projagents.contract", adapter, () =>
    ProjectAgents.use((rows) => Effect.succeed(projectRows(rows))).pipe(Effect.provide(make())),
  );
}

/** Why a move was refused, or the state the invitation was answered in. */
const outcome = <E extends { readonly _tag: string }>(
  move: Effect.Effect<{ readonly state: string }, E>,
) =>
  move.pipe(
    Effect.match({
      onSuccess: (invitation) => invitation.state,
      onFailure: (error) =>
        "reason" in error && typeof error.reason === "string" ? error.reason : error._tag,
    }),
  );

/** `Invitations` in one kind of place, with the rows the request gate reads there next. */
interface Site<Place> {
  readonly invitations: (typeof Invitations)["Service"];
  readonly rows: Rows<Place>;
  /** How an invitation's request names the place. */
  readonly named: (place: Place) => {
    readonly namespace: NamespaceId;
    readonly projectId?: ProjectId;
  };
}

function describeMovesContract<Place>(
  where: string,
  adapter: string,
  tag: string,
  open: () => Effect.Effect<Site<Place>>,
) {
  describe(`Invitations contract${where}: ${adapter}`, () => {
    it.live(
      `[${tag}] a member invites, the agent accepts, and it leaves; each in the rows when it answers`,
      () =>
        Effect.gen(function* () {
          const { invitations, rows, named } = yield* open();
          const [place, agentId, by] = [rows.aPlace(), anAgent(), aUser()];
          const at = { ...named(place), agentId };

          const invited = yield* invitations.invite({
            ...at,
            by,
            scopes: BOTH,
            idempotencyKey: key(),
          });
          expect(invited).toMatchObject({ ...at, by, state: "invited" });
          expect(rows.placeOf(invited)).toBe(rows.idOf(place));
          expect(yield* stateIn(rows, agentId, place)).toBe("invited");
          expect(yield* standingIn(rows, agentId, place)).toBeNull();

          const joined = yield* invitations.accept({ ...at, idempotencyKey: key() });
          expect(joined.state).toBe("joined");
          expect(yield* standingIn(rows, agentId, place)).toEqual([
            by,
            ["agent:read", "agent:work"],
          ]);

          const left = yield* invitations.end(itself(agentId), { ...at, idempotencyKey: key() });
          expect(left.state).toBe("ended");
          expect(yield* standingIn(rows, agentId, place)).toBeNull();
          expect(yield* stateIn(rows, agentId, place)).toBeNull();
        }),
    );

    it.live(
      `[${tag}] one member answers for an agent: the same member again changes nothing, and another member or other scopes are refused while it stands`,
      () =>
        Effect.gen(function* () {
          const { invitations, rows, named } = yield* open();
          const [place, agentId, first, second] = [rows.aPlace(), anAgent(), aUser(), aUser()];
          const at = { ...named(place), agentId };
          const invite = (by: UserId, scopes: InvitationScopes) =>
            outcome(invitations.invite({ ...at, by, scopes, idempotencyKey: key() }));

          expect(yield* invite(first, BOTH)).toBe("invited");
          expect(yield* invite(first, BOTH)).toBe("invited");
          expect(yield* invite(second, BOTH)).toBe("already-invited");
          expect(yield* invite(first, READ)).toBe("already-invited");
          expect(Option.getOrThrow(yield* rows.find(agentId, place)).by).toBe(first);

          yield* invitations.accept({ ...at, idempotencyKey: key() });
          expect(yield* invite(first, BOTH)).toBe("joined");
          expect(yield* invite(second, BOTH)).toBe("already-invited");
          expect(yield* standingIn(rows, agentId, place)).toEqual([
            first,
            ["agent:read", "agent:work"],
          ]);
        }),
    );

    it.live(
      `[${tag}] only an invited agent accepts, accepting again changes nothing, and nothing ends where nothing stands`,
      () =>
        Effect.gen(function* () {
          const { invitations, rows, named } = yield* open();
          const [place, agentId, by] = [rows.aPlace(), anAgent(), aUser()];
          const at = { ...named(place), agentId };
          const accept = () => outcome(invitations.accept({ ...at, idempotencyKey: key() }));
          const end = (actor: Actor) =>
            outcome(invitations.end(actor, { ...at, idempotencyKey: key() }));

          expect(yield* accept()).toBe("not-invited");
          expect(yield* end(itself(agentId))).toBe("not-invited");
          expect(yield* end(person(by))).toBe("not-invited");
          expect(yield* standingIn(rows, agentId, place)).toBeNull();

          yield* invitations.invite({ ...at, by, scopes: READ, idempotencyKey: key() });
          expect(yield* accept()).toBe("joined");
          expect(yield* accept()).toBe("joined");
          expect(yield* standingIn(rows, agentId, place)).toEqual([by, ["agent:read"]]);

          // Another agent is no party to it.
          expect(yield* end(itself(anAgent()))).toBe("not-a-party");
          expect(yield* standingIn(rows, agentId, place)).toEqual([by, ["agent:read"]]);

          // A person takes it out, and the agent has nothing there to accept or leave.
          expect(yield* end(person(aUser()))).toBe("ended");
          expect(yield* accept()).toBe("not-invited");
          expect(yield* end(itself(agentId))).toBe("not-invited");
          expect(yield* standingIn(rows, agentId, place)).toBeNull();
        }),
    );

    it.live(
      `[${tag}] ended, the agent is invited again by another member, on what that member gives`,
      () =>
        Effect.gen(function* () {
          const { invitations, rows, named } = yield* open();
          const [place, agentId, first, second] = [rows.aPlace(), anAgent(), aUser(), aUser()];
          const at = { ...named(place), agentId };
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
          expect(yield* standingIn(rows, agentId, place)).toEqual([second, ["agent:read"]]);
        }),
    );

    it.live(
      `[${tag}] a key sent again with its body answers the invitation as it stands; with another body it is refused`,
      () =>
        Effect.gen(function* () {
          const { invitations, rows, named } = yield* open();
          const [place, agentId, by] = [rows.aPlace(), anAgent(), aUser()];
          const at = { ...named(place), agentId };
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
          expect(yield* standingIn(rows, agentId, place)).toEqual([
            by,
            ["agent:read", "agent:work"],
          ]);

          const ending = { ...at, idempotencyKey: key() };
          expect(yield* outcome(invitations.end(person(by), ending))).toBe("ended");
          expect(yield* outcome(invitations.end(person(by), ending))).toBe("ended");
          expect(yield* outcome(invitations.end(itself(agentId), ending))).toBe(
            "IdempotencyConflict",
          );
        }),
    );
  });
}

/**
 * The `Invitations` suite, once into a whole namespace and once to one project
 * of a person's. Each reads its moves' rows back from what the request gate
 * reads next there: `NamespaceAgents`, or `ProjectAgents`. A last case holds
 * the two apart: an invitation to a project gives nothing in the namespace's
 * own rows, nor on another project.
 */
export function describeInvitationsContract(
  adapter: string,
  make: () => Layer.Layer<Invitations | NamespaceAgents | ProjectAgents>,
) {
  const opened = Effect.gen(function* () {
    return {
      invitations: yield* Invitations,
      namespaces: yield* NamespaceAgents,
      projects: yield* ProjectAgents,
    };
  });
  const open = () => opened.pipe(Effect.provide(make()));
  describeMovesContract("", adapter, "invitations.contract", () =>
    open().pipe(
      Effect.map(({ invitations, namespaces }): Site<NamespaceId> => ({
        invitations,
        rows: namespaceRows(namespaces),
        named: (namespace) => ({ namespace }),
      })),
    ),
  );
  describeMovesContract(", to one project", adapter, "projinvitations.contract", () =>
    open().pipe(
      Effect.map(({ invitations, projects }): Site<ProjectPlace> => ({
        invitations,
        rows: projectRows(projects),
        named: (place) => place,
      })),
    ),
  );

  describe(`Invitations contract, a project apart from its namespace: ${adapter}`, () => {
    it.live(
      "[projinvitations.contract] an invitation to one project stands on that project alone: not in the namespace's rows, not on another of its projects, and each project's is its own",
      () =>
        Effect.gen(function* () {
          const { invitations, namespaces, projects } = yield* open();
          const [here, agentId, by] = [aProject(), anAgent(), aUser()];
          const there = { namespace: here.namespace, projectId: aProject().projectId };
          const at = { ...here, agentId };
          yield* invitations.invite({ ...at, by, scopes: BOTH, idempotencyKey: key() });
          yield* invitations.accept({ ...at, idempotencyKey: key() });

          expect(Option.isSome(yield* projects.standing(agentId, here.projectId))).toBe(true);
          expect(Option.isNone(yield* projects.standing(agentId, there.projectId))).toBe(true);
          expect(Option.isNone(yield* namespaces.standing(agentId, here.namespace))).toBe(true);
          expect(yield* namespaces.ofAgent(agentId)).toEqual([]);

          // The other project asks apart: a pending invitation there, and the first still stands.
          const other = yield* invitations.invite({
            ...there,
            agentId,
            by,
            scopes: READ,
            idempotencyKey: key(),
          });
          expect(other).toMatchObject({ projectId: there.projectId, state: "invited" });
          expect(Option.isNone(yield* projects.standing(agentId, there.projectId))).toBe(true);
          const held = yield* projects.ofAgent(agentId);
          expect(held.map((row) => [row.projectId, row.state])).toEqual([
            [here.projectId, "joined"],
            [there.projectId, "invited"],
          ]);

          // Ending one leaves the other as it was.
          yield* invitations.end(person(by), { ...at, idempotencyKey: key() });
          expect(Option.isNone(yield* projects.standing(agentId, here.projectId))).toBe(true);
          const left = yield* projects.ofAgent(agentId);
          expect(left.map((row) => row.projectId)).toEqual([there.projectId]);
        }),
    );
  });
}
