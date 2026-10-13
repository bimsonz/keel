import { describe, expect, it } from "vitest";
import { Authenticator } from "./auth-harness.ts";
import { answered, signUpByPasskey, site } from "./auth-users.ts";
import { byCookie, type Carried, passkeyOptions, signInByPasskey } from "./auth-ways.ts";
import { uniqueHandle } from "./helpers.ts";

/** One passkey of a person's list, as far as these tests read it. */
interface Key {
  readonly id: string;
  readonly name: string | null;
  readonly lastUsedAt: string | null;
}

const keys = async (by: Carried): Promise<Key[]> => {
  const answer = await site("/passkey/list-user-passkeys", by);
  answered(answer, 200);
  return answer.json;
};

/** Each key's last use by its id, as the list answers it. */
const lastUses = async (by: Carried) =>
  Object.fromEntries((await keys(by)).map((key) => [key.id, key.lastUsedAt]));

/** Adds a passkey to a session's account, answering the device that holds it and the key's id. */
async function addKey(by: Carried) {
  const held = new Set((await keys(by)).map((key) => key.id));
  const options = await passkeyOptions(by);
  answered(options, 200);
  const device = new Authenticator();
  answered(
    await site("/passkey/verify-registration", {
      body: { response: await device.create(options.json.challenge) },
      ...by,
    }),
    200,
  );
  const added = (await keys(by)).find((key) => !held.has(key.id));
  if (added === undefined) throw new Error("the list gained no passkey");
  return { device, id: added.id };
}

describe("A person's passkeys at /v1/auth", () => {
  it("[ba.passkey-last-used] a passkey reads no last use when it is added, and the sign-in's time once it signs in", async () => {
    const ada = await signUpByPasskey(uniqueHandle("pk-used"));
    const [added] = await keys(byCookie(ada.jar));
    expect([added?.lastUsedAt]).toEqual([null]);

    const before = Date.now();
    const again = await signInByPasskey(ada.device);
    const after = Date.now();
    const [used] = await keys(byCookie(again));
    expect(used?.id).toBe(added?.id);
    const at = Date.parse(used?.lastUsedAt ?? "");
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it("[ba.passkey-last-used-own] a sign-in moves the last use of the passkey that signed in, and of no other", async () => {
    const ada = await signUpByPasskey(uniqueHandle("pk-own"));
    const grace = await signUpByPasskey(uniqueHandle("pk-other"));
    const [first] = await keys(byCookie(ada.jar));
    const second = await addKey(byCookie(ada.jar));
    const [hers] = await keys(byCookie(grace.jar));
    if (first === undefined || hers === undefined) throw new Error("a sign-up left no passkey");

    const again = await signInByPasskey(second.device);
    const mine = await lastUses(byCookie(again));
    expect(Object.keys(mine).toSorted()).toEqual([first.id, second.id].toSorted());
    expect(mine[second.id]).toEqual(expect.any(String));
    expect(mine[first.id]).toBeNull();
    expect(await lastUses(byCookie(grace.jar))).toEqual({ [hers.id]: null });
  });

  it("[ba.passkey-rename] a person renames a passkey of their own, and their list reads the new name", async () => {
    const ada = await signUpByPasskey(uniqueHandle("pk-name"));
    const by = byCookie(ada.jar);
    const [key] = await keys(by);
    expect(key?.name).not.toBe("Laptop");

    const renamed = await site("/passkey/update-passkey", {
      body: { id: key?.id, name: "Laptop" },
      ...by,
    });
    answered(renamed, 200);
    expect((await keys(by)).map((one) => [one.id, one.name])).toEqual([[key?.id, "Laptop"]]);
  });
});
