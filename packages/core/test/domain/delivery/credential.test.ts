import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CredentialLabel } from "../../../src/domain/delivery/index.ts";

const takes = (label: string): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(CredentialLabel)(label));

describe("a credential's label", () => {
  it("[credential.label] takes 1 to 64 characters that neither start nor end with whitespace", () => {
    const cases: readonly (readonly [string, string, boolean])[] = [
      ["one character", "x", true],
      ["64 characters", "x".repeat(64), true],
      ["65 characters", "x".repeat(65), false],
      ["empty", "", false],
      ["a space inside", "staging deploys", true],
      ["a leading space", " deploys", false],
      ["a trailing space", "deploys ", false],
      ["a leading tab", "\tdeploys", false],
      ["a trailing newline", "deploys\n", false],
    ];
    expect(cases.map(([name, label]) => [name, takes(label)])).toEqual(
      cases.map(([name, , ok]) => [name, ok]),
    );
  });

  it("[credential.label-contract] the published API holds a label to the same rule", () => {
    const document: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../../contracts/openapi.json"), "utf8"),
    );
    // Written out, not read from the domain, so the spec and the domain are each held to it.
    expect(document).toMatchObject({
      components: {
        schemas: {
          CredentialLabel: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^\\S(?:.*\\S)?$",
          },
        },
      },
    });
  });
});
