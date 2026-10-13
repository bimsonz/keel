import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  agentIdOf,
  givenHandle,
  Handle,
  KeyThumbprint,
} from "../../../src/domain/identity/index.ts";
import { AgentId } from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const thumbprint = Schema.decodeUnknownSync(KeyThumbprint);
const isThumbprint = Schema.is(KeyThumbprint);
const isAgentId = Schema.is(AgentId);
const isHandle = Schema.is(Handle);

/** A SHA-256 digest as RFC 7638 writes it: base64url, no padding. */
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const digest = fc.uint8Array({ minLength: 32, maxLength: 32 });

describe("an agent's id and handle, made from its key", () => {
  it("[signup.id-from-key] the id is the thumbprint's first 128 bits in the id alphabet", () => {
    const counting = base64url(Uint8Array.from({ length: 32 }, (_, i) => i));
    expect(agentIdOf(thumbprint(counting))).toBe("agt_00041061050R3GG28A1C60T3GF");
    const ones = base64url(new Uint8Array(32).fill(255));
    expect(agentIdOf(thumbprint(ones))).toBe("agt_7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
  });

  it("[signup.id-from-key] the handle is `agent-` and the id's first 16 characters in lower case", () => {
    const counting = base64url(Uint8Array.from({ length: 32 }, (_, i) => i));
    expect(givenHandle(agentIdOf(thumbprint(counting)))).toBe("agent-00041061050r3gg2");
  });

  it("[signup.id-from-key] every thumbprint gives an agent id and a handle a namespace can hold", () => {
    fc.assert(
      fc.property(digest, (bytes) => {
        const id = agentIdOf(thumbprint(base64url(bytes)));
        expect(isAgentId(id)).toBe(true);
        expect(isHandle(givenHandle(id))).toBe(true);
      }),
    );
  });

  it("[signup.id-from-key] keys that differ in their first 128 bits never share an id", () => {
    fc.assert(
      fc.property(digest, digest, (a, b) => {
        fc.pre(a.subarray(0, 16).some((byte, i) => byte !== b[i]));
        expect(agentIdOf(thumbprint(base64url(a)))).not.toBe(agentIdOf(thumbprint(base64url(b))));
      }),
    );
  });

  it("[signup.id-from-key] a string that is no SHA-256 thumbprint is refused", () => {
    for (const bad of ["", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}+`])
      expect(isThumbprint(bad)).toBe(false);
    expect(isThumbprint("A".repeat(43))).toBe(true);
  });
});
