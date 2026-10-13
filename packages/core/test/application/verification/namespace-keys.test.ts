import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { type KeyFamily, namespaceKey } from "../../../src/application/verification/index.ts";
import { NamespaceId } from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const chars = (alphabet: string, minLength: number, maxLength: number) =>
  fc
    .array(fc.constantFrom(...alphabet.split("")), { minLength, maxLength })
    .map((cs) => cs.join(""));

/** A namespace's id as the kernel admits one: `org_` and a ULID, 26 characters of Crockford base32. */
const namespaceArb = chars("0123456789ABCDEFGHJKMNPQRSTVWXYZ", 26, 26).map((ulid) =>
  Schema.decodeUnknownSync(NamespaceId)(`org_${ulid}`),
);
const familyArb = fc.constantFrom<KeyFamily>(
  "bundles",
  "deps",
  "deps-parts",
  "probe-deps",
  "evidence",
  "plans",
);
const hexArb = chars("0123456789abcdef", 1, 64);

describe("the key of a namespace's object", () => {
  it("[t5.namespace-keys] a key sits under its own namespace and family and ends with its hex, and is never another namespace's key nor under its prefix", () => {
    fc.assert(
      fc.property(
        namespaceArb,
        namespaceArb,
        fc.tuple(familyArb, hexArb),
        fc.tuple(familyArb, hexArb),
        (a, b, [family, hex], other) => {
          fc.pre(a !== b);
          const ofA = namespaceKey(a, family, hex);
          expect(ofA.startsWith(`ns/${a}/${family}/`)).toBe(true);
          expect(ofA.endsWith(hex)).toBe(true);
          // The same object and any other one, kept for another namespace.
          for (const [itsFamily, itsHex] of [[family, hex] as const, other]) {
            const ofB = namespaceKey(b, itsFamily, itsHex);
            expect(ofB).not.toBe(ofA);
            expect(ofB.startsWith(`ns/${a}/`)).toBe(false);
            expect(ofA.startsWith(`ns/${b}/`)).toBe(false);
          }
        },
      ),
    );
  });

  it("[t5.namespace-keys] the sample namespace's plan is kept at exactly this key", () => {
    const namespace = Schema.decodeUnknownSync(NamespaceId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
    expect(namespaceKey(namespace, "plans", "ab".repeat(32))).toBe(
      "ns/org_01JZ8PT2C4E6G8J0M2N4Q6S8V0/plans/abababababababababababababababababababababababababababababababab",
    );
  });
});
