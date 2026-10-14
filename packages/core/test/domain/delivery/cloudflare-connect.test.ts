import { Option, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CONNECT_WINDOW_MS,
  connectState,
  DeployTargetName,
  deployTokenName,
  finishConnect,
  oneAccount,
  type PendingConnect,
  readConnectState,
  sameSecret,
} from "../../../src/domain/delivery/index.ts";
import { makeId } from "../../../src/domain/kernel/index.ts";

const PROJECT = makeId("prj", "01M4P00000000000000000000P");
const NONCE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN-_0";
const held: PendingConnect = {
  target: Schema.decodeSync(DeployTargetName)("production"),
  nonce: NONCE,
  verifier: "the-verifier",
  expiresAt: 1_000 + CONNECT_WINDOW_MS,
};

const refusal = (answer: Result.Result<PendingConnect, { readonly reason: string }>) =>
  Result.isSuccess(answer) ? "finished" : answer.failure.reason;

describe("connecting a Cloudflare account", () => {
  it("[connect.same-secret] two strings are the same only when every character and the length are", () => {
    const cases: readonly (readonly [string, string, string, boolean])[] = [
      ["equal", NONCE, NONCE, true],
      ["the last character differs", NONCE, `${NONCE.slice(0, -1)}1`, false],
      ["the first character differs", NONCE, `X${NONCE.slice(1)}`, false],
      ["one is a prefix of the other", NONCE, NONCE.slice(0, -1), false],
      ["the other is longer", NONCE, `${NONCE}a`, false],
      ["both empty", "", "", true],
      ["one empty", "", NONCE, false],
    ];
    expect(cases.map(([name, a, b]) => [name, sameSecret(a, b)])).toEqual(
      cases.map(([name, , , same]) => [name, same]),
    );
  });

  it("[connect.finish] a callback finishes the held Connect only with its own nonce, before its window closes", () => {
    expect(finishConnect(held, NONCE, 1_000)).toEqual(Result.succeed(held));
    expect(finishConnect(held, NONCE, held.expiresAt - 1)).toEqual(Result.succeed(held));
    expect(refusal(finishConnect(held, NONCE, held.expiresAt))).toBe("expired");
    expect(refusal(finishConnect(held, `${NONCE.slice(0, -1)}1`, 1_000))).toBe("mismatch");
    expect(refusal(finishConnect(undefined, NONCE, 1_000))).toBe("none");
  });

  it("[connect.state] a state carries its project and nonce back, and nothing else reads as one", () => {
    expect(readConnectState(connectState(PROJECT, NONCE))).toEqual(
      Option.some({ projectId: PROJECT, nonce: NONCE }),
    );
    for (const state of [
      "",
      NONCE,
      PROJECT,
      `${PROJECT}.`,
      `${PROJECT}.${NONCE.slice(1)}`,
      `${PROJECT}.${NONCE}a`,
      `${PROJECT}.${NONCE.slice(1)}=`,
      `usr_01M4P00000000000000000000P.${NONCE}`,
      `${PROJECT}.${NONCE}.${NONCE}`,
    ])
      expect([state, Option.isSome(readConnectState(state))]).toEqual([state, false]);
    for (const state of [undefined, null, 42, [PROJECT, NONCE]])
      expect(Option.isSome(readConnectState(state))).toBe(false);
  });

  it("[connect.one-account] a consent must grant exactly one account", () => {
    const acme = { id: "0123456789abcdef0123456789abcdef", name: "Acme" };
    const other = { id: "fedcba9876543210fedcba9876543210", name: "Other" };
    expect(oneAccount([acme])).toEqual(Result.succeed(acme));
    for (const granted of [[], [acme, other], [acme, acme, other]]) {
      const answer = oneAccount(granted);
      expect(Result.isFailure(answer) && answer.failure.granted).toBe(granted.length);
    }
  });

  it("[connect.token-name] the minted token is named for its project, within a label's 64 characters", () => {
    expect(deployTokenName("acme", "worker-lite")).toBe("Keel deploys: acme/worker-lite");
    const long = deployTokenName("a".repeat(39), "b".repeat(40));
    expect(long).toHaveLength(64);
    expect(long.startsWith(`Keel deploys: ${"a".repeat(39)}/b`)).toBe(true);
    expect(deployTokenName("a".repeat(48), "b")).toBe(`Keel deploys: ${"a".repeat(48)}/b`);
    expect(deployTokenName("a".repeat(49), "b")).toBe(`Keel deploys: ${"a".repeat(49)}/`);
  });
});
