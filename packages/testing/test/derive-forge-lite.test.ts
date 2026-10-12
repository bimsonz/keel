/**
 * S-1's done-when for effect derivation, over the facts of the eight
 * changes spike S17b made to forge-lite: B's cache is derived as per-session,
 * B′'s as invalidated on revoke, and a sibling's cache is never put on the
 * subject.
 */
import {
  compare,
  deriveEffects,
  drift,
  type Intent,
  type Proposition,
  storeClaims,
  SubjectKey,
} from "@keeltown/core/domain/coordination";
import { Glob, makeId } from "@keeltown/core/kernel";
import { describe, expect, it } from "vitest";
import {
  FORGE_LITE_ITEMS,
  FORGE_LITE_SUBJECT,
  FORGE_LITE_SUBJECTS,
  type ForgeLiteItem,
} from "../src/forge-lite-facts.ts";

const A = makeId("chg", "0".repeat(25) + "1");
const B = makeId("chg", "0".repeat(25) + "2");
/** A's premise: revocation takes effect on the next request. */
const premise: Proposition = {
  subject: FORGE_LITE_SUBJECT,
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
};
const intent: Intent = {
  revision: 1,
  goal: "speed up permission checks",
  footprint: [{ path: Glob.make("src/authz/**"), op: "edit" }],
  premises: [],
  declaredEffects: [],
};
const itemOf = (id: string): ForgeLiteItem => {
  const found = FORGE_LITE_ITEMS.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no forge-lite item ${id}`);
  return found;
};
const derive = (item: ForgeLiteItem, declared: Intent = intent) =>
  deriveEffects({
    base: item.base,
    head: item.head,
    subjects: FORGE_LITE_SUBJECTS,
    intent: declared,
  });
const against = (item: ForgeLiteItem): readonly string[] =>
  derive(item).effects.map((effect) => compare(premise, effect.proposition).outcome);

describe("effect derivation on forge-lite's S-1 trees", () => {
  it("[derive.forge-lite] B's cache derives as per-session and contradicts A's premise, B′'s as invalidated on revoke and needs a probe, the careless changes as per-session again, and the sibling's cache is never put on the subject", () => {
    const derived = FORGE_LITE_ITEMS.map((item) => [
      item.id,
      derive(item).effects.map((effect) => [
        effect.proposition.subject,
        effect.proposition.predicate,
        effect.proposition.relation,
        effect.proposition.value,
        effect.method,
        effect.evidenceClass,
        effect.declared,
      ]),
      derive(item).undecided,
    ]);
    expect(derived).toEqual(
      FORGE_LITE_ITEMS.map((item) => [
        item.id,
        item.derives.map((value) => [
          FORGE_LITE_SUBJECT,
          "freshness",
          "is",
          value,
          "extractor",
          "ruling",
          false,
        ]),
        [],
      ]),
    );
    expect(Object.fromEntries(FORGE_LITE_ITEMS.map((item) => [item.id, item.derives]))).toEqual({
      F01: ["per-session"],
      F02: ["per-session"],
      F03: ["per-session invalidated-on collaborator.removed"],
      F04: ["ttl:60"],
      F05: ["per-request"],
      F06: ["per-session"],
      F07: [],
      F08: [],
    });

    expect(against(itemOf("F01"))).toEqual(["contradicts"]);
    expect(against(itemOf("F03"))).toEqual(["needs-probe"]);
    expect(against(itemOf("F02"))).toEqual(["contradicts"]);
    expect(against(itemOf("F06"))).toEqual(["contradicts"]);
    expect(against(itemOf("F04"))).toEqual(["contradicts"]);
    expect(against(itemOf("F05"))).toEqual(["compatible"]);

    // B declared nothing, so its derived cache is a silent retraction of A's premise: a conflict opens.
    const findings = drift(
      B,
      intent,
      [{ path: Glob.make("src/authz/cache.ts"), op: "edit" }],
      derive(itemOf("F01")).effects,
      [{ holder: A, proposition: premise }],
      [],
    );
    expect(findings.map((f) => [f._tag, f.opensConflict])).toEqual([["silent-retraction", true]]);
    // Had B declared it, the same derivation says so.
    const honest: Intent = {
      ...intent,
      declaredEffects: [{ ...premise, relation: "is", value: "per-session" }],
    };
    expect(derive(itemOf("F01"), honest).effects.map((e) => e.declared)).toEqual([true]);

    // What each effect rests on, at head's commit: the store, the anchored reader, and for B′ the subscription.
    const anchorsOf = (id: string) =>
      derive(itemOf(id)).effects.flatMap((effect) =>
        effect.anchors.map((anchor) => `${anchor.path}#${anchor.symbol}@${anchor.commit[0]}`),
      );
    expect(anchorsOf("F01")).toEqual([
      "src/authz/cache.ts#RoleCache.#roles@c",
      "src/authz/require-permission.ts#requirePermission@c",
    ]);
    expect(anchorsOf("F03")).toEqual([
      "src/authz/cache.ts#RoleCache.#entries@c",
      "src/authz/cache.ts#roleCacheFor@c",
      "src/authz/require-permission.ts#requirePermission@c",
    ]);

    // The sibling decoy: the owner cache is seen, and is per-session, yet nothing names the subject.
    const decoy = itemOf("F08");
    expect(
      storeClaims(decoy.head).map((claim) => [
        claim.store.symbol,
        "freshness" in claim ? claim.freshness : claim.undecided,
      ]),
    ).toEqual([["ownerCache", "per-session"]]);
    expect(derive(decoy)).toEqual({ effects: [], undecided: [] });
    // A subject anchored on the view itself does get it: the cache was not missed, only not attributed.
    const viewed = SubjectKey.make("repos.view");
    const onTheView = deriveEffects({
      base: decoy.base,
      head: decoy.head,
      subjects: [
        ...FORGE_LITE_SUBJECTS,
        {
          subject: viewed,
          anchors: [{ path: "src/routes/repos.ts", symbol: "view", commit: decoy.base.commit }],
        },
      ],
      intent,
    });
    expect(onTheView.effects.map((e) => [e.proposition.subject, e.proposition.value])).toEqual([
      [viewed, "per-session"],
    ]);
    // A subject anchored on another symbol of that same file gets nothing: sharing a file is not reading the cache.
    const beside = deriveEffects({
      base: decoy.base,
      head: decoy.head,
      subjects: [
        {
          subject: SubjectKey.make("repos.description"),
          anchors: [
            { path: "src/routes/repos.ts", symbol: "checkDescription", commit: decoy.base.commit },
          ],
        },
      ],
      intent,
    });
    expect(beside).toEqual({ effects: [], undecided: [] });
  });
});
