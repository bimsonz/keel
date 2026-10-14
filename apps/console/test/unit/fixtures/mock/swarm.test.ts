import { describe, expect, it, vi } from "vitest";
import type { GeneratedLog } from "../../../fixtures/mock/builder.ts";
import { checkLog, finalStates } from "../../../fixtures/mock/conformance.ts";
import type { Proposition } from "../../../../src/contract/mfp.ts";
import { SCALES, SWARM_EPOCH, generateSwarm } from "../../../fixtures/mock/swarm.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Replays a log against the lattice. A premise stands from the moment its change declares it, landed or not.
 * An effect does not say what it contradicts: the conflict Keel opens after the derivation does. `unsaid` is
 * every effect that steps outside a standing premise with no conflict opened over it, and every conflict
 * opened over a premise the effect stays inside. `disagreements` is each holder and the change it was set against.
 */
function latticeAudit(log: GeneratedLog): { unsaid: string[]; disagreements: string[] } {
  const position = new Map(
    SCALES.flatMap(([predicate, scale]) =>
      scale.map((value, index): [string, number] => [`${predicate}/${value}`, index]),
    ),
  );
  const placeOf = (proposition: Proposition): number =>
    position.get(`${proposition.predicate}/${String(proposition.value)}`) ?? -1;
  // For each derivation, the changes a conflict then set it against: a conflict's cause is the derivation that showed it.
  const derivations = new Map<string, { at: number; changeId: string }>();
  const setAgainst = new Map<number, string[]>();
  log.events.forEach((event, at) => {
    if (event.type === "EffectsDerived")
      derivations.set(event.eventId, { at, changeId: event.payload.changeId });
    else if (event.type === "ConflictSuspected") {
      const cause = derivations.get(event.causation ?? "");
      if (cause !== undefined)
        setAgainst.set(cause.at, [
          ...(setAgainst.get(cause.at) ?? []),
          ...event.payload.parties.filter((party) => party !== cause.changeId),
        ]);
    }
  });
  const standing = new Map<string, Proposition[]>();
  const unsaid: string[] = [];
  const disagreements: string[] = [];
  log.events.forEach((event, at) => {
    if (event.type === "IntentDeclared")
      standing.set(event.payload.changeId, event.payload.premises);
    if (event.type !== "EffectsDerived") return;
    const { changeId } = event.payload;
    const holders = setAgainst.get(at) ?? [];
    for (const holder of holders) disagreements.push(`${holder} and ${changeId}`);
    for (const effect of event.payload.effects) {
      const sameQuestion = (premise: Proposition): boolean =>
        premise.subject === effect.proposition.subject &&
        premise.predicate === effect.proposition.predicate;
      const contested = holders.flatMap(
        (holder) => standing.get(holder)?.filter(sameQuestion) ?? [],
      );
      if (contested.some((premise) => placeOf(effect.proposition) <= placeOf(premise)))
        unsaid.push(`a conflict was opened against ${changeId} over a premise it stays inside`);
      for (const [other, premises] of standing) {
        if (other === changeId) continue;
        for (const premise of premises.filter(sameQuestion)) {
          if (
            placeOf(effect.proposition) > placeOf(premise) &&
            !contested.some((known) => known.value === premise.value)
          )
            unsaid.push(`${changeId} steps outside what ${other} relies on`);
        }
      }
    }
  });
  return { unsaid, disagreements };
}

describe("the swarm", () => {
  const log = generateSwarm(42);
  const count = (type: string): number => log.events.filter((event) => event.type === type).length;

  it("conforms to the catalogue and the state machines", () => {
    expect(checkLog(log.events)).toEqual([]);
  });

  it("is the same log for the same seed, and another for another", () => {
    const small = { agents: 60, seconds: 60 };
    expect(JSON.stringify(generateSwarm(7, small).events)).toBe(
      JSON.stringify(generateSwarm(7, small).events),
    );
    expect(JSON.stringify(generateSwarm(7, small).events)).not.toBe(
      JSON.stringify(generateSwarm(8, small).events),
    );
  });

  it("is a swarm: 803 agents, about a thousand changes landed, trunk never red", () => {
    expect(count("AgentEnrolled")).toBe(804);
    expect(count("ChangeLanded")).toBeGreaterThan(900);
    expect(count("TrunkAdvanced")).toBeGreaterThan(100);
    expect(
      log.events.filter(
        (event) => event.type === "AuditCompleted" && event.payload.outcome === "red",
      ),
    ).toEqual([]);
  });

  it("proves the planted disagreements and dismisses the false alarms", () => {
    expect(count("ConflictProven")).toBe(12);
    expect(count("ConflictDismissed")).toBe(8);
    expect(count("GuardAdmitted")).toBe(12);
    // A person is asked only about the two that are a person's call, and both questions are answered.
    expect(count("EscalationRaised")).toBe(2);
    expect(count("RulingGiven")).toBe(2);
  });

  it("opens a conflict whenever an effect steps outside a standing premise, and only then", () => {
    const { unsaid, disagreements } = latticeAudit(log);
    expect(unsaid).toEqual([]);
    expect(disagreements).toHaveLength(20);
    // They are spread through the run, not spent in its first seconds.
    const openedAt = log.events.flatMap((event, index) =>
      event.type === "ConflictSuspected" ? [(log.eventTimes[index] ?? 0) / 1000] : [],
    );
    expect(openedAt.filter((second) => second > 60)).not.toHaveLength(0);
    expect(Math.max(...openedAt)).toBeLessThan(130);
  });

  it("holds to the lattice in a thin swarm too, where the strictest premise standing has often already landed", () => {
    // With few agents a subject's strictest premise is soon held only by changes that have landed.
    const thin = [1, 2, 3, 4, 5, 6].map((seed) =>
      latticeAudit(generateSwarm(seed, { agents: 40, seconds: 120 })),
    );
    expect(thin.flatMap((audit) => audit.unsaid)).toEqual([]);
    // Disagreements were still arranged in them, so the audit had something to audit.
    expect(thin.reduce((sum, audit) => sum + audit.disagreements.length, 0)).toBeGreaterThan(20);
  });

  it("has its runner seal the ground truth before the run, and publish it once every disagreement is decided", async () => {
    const seal = log.observations.flatMap((observation) =>
      observation.kind === "seal" ? [observation] : [],
    )[0];
    const unsealIndex = log.observations.findIndex((observation) => observation.kind === "unseal");
    const unseal = log.observations.flatMap((observation) =>
      observation.kind === "unseal" ? [observation] : [],
    )[0];
    expect(seal).toMatchObject({
      at: SWARM_EPOCH,
      planted: 13,
      decoys: 8,
      runner: "pnpm swarm --seed 42 --planted 13 --decoys 8",
    });
    // The commitment is the digest of exactly what is later published, by the platform's own SHA-256.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(unseal?.sealed ?? ""),
    );
    expect(seal?.commitment).toBe(
      `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    );
    expect(
      generateSwarm(7, { agents: 60, seconds: 60 }).observations.find(
        (observation) => observation.kind === "seal",
      ),
    ).not.toMatchObject({ commitment: seal?.commitment });
    // Nothing is still being argued when the truth comes out: every disagreement was proven or dismissed by its
    // probe, and each one put to a person was resolved by the ruling. A proof nobody was asked about stays proven.
    const decided = log.events.flatMap((event, index) =>
      event.type === "ConflictProven" ||
      event.type === "ConflictDismissed" ||
      event.type === "ConflictResolved"
        ? [log.eventTimes[index] ?? 0]
        : [],
    );
    expect(log.observationTimes[unsealIndex]).toBeGreaterThan(Math.max(...decided));
    // One arranged pair never became a conflict: the one Keel does not notice. Both its changes landed.
    const opened = new Set(
      log.events.flatMap((event) =>
        event.type === "ConflictSuspected" ? [event.payload.parties.join(" and ")] : [],
      ),
    );
    const landed = new Set(
      log.events.flatMap((event) =>
        event.type === "ChangeLanded" ? [event.payload.changeId] : [],
      ),
    );
    const unnoticed = Object.values(unseal?.changes ?? {}).filter(
      (pair) => !opened.has(`${pair.relies} and ${pair.alters}`),
    );
    expect(Object.keys(unseal?.changes ?? {})).toHaveLength(21);
    expect(unnoticed).toHaveLength(1);
    expect(unnoticed.every((pair) => landed.has(pair.relies) && landed.has(pair.alters))).toBe(
      true,
    );
  });

  it("leaves no change stuck: by the end everything declared has landed or is still moving", () => {
    const states = [...finalStates(log.events)]
      .filter(([key]) => key.startsWith("change:"))
      .map(([, state]) => state);
    expect(
      states.filter((state) => state === "parked" || state === "bounced" || state === "drifted"),
    ).toEqual([]);
  });
});
