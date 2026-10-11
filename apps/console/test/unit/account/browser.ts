// A browser's part in the tests of the account pages, and a person signed up through it.

import { createAccount } from "../../../src/account/account.ts";
import { type Identity, createIdentity } from "../../fixtures/identity/standIn.ts";

export const ORIGIN = "https://keel.example";

export interface Cookie {
  value: string;
  httpOnly: boolean;
  sameSite: string;
}

/**
 * A browser's part in a request: it keeps the cookies it is given and sends them back, and it says which
 * page is asking. What the page's own code put on a request is kept apart from what the browser added.
 */
export function browser(
  identity: Pick<Identity, "handle">,
  origin = ORIGIN,
  jar = new Map<string, Cookie>(),
) {
  const fromThePage: Request[] = [];
  const serve: typeof fetch = async (input, init) => {
    const asked = new Request(input, init);
    fromThePage.push(asked.clone());
    const headers = new Headers(asked.headers);
    if (jar.size > 0)
      headers.set("cookie", [...jar].map(([name, cookie]) => `${name}=${cookie.value}`).join("; "));
    headers.set("origin", origin);
    const response = await identity.handle(new Request(asked, { headers }));
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      const has = (attribute: string) =>
        attributes.find((given) => given.toLowerCase().startsWith(attribute));
      if (value === "" || has("max-age=0") !== undefined) jar.delete(name);
      else
        jar.set(name, {
          value,
          httpOnly: has("httponly") !== undefined,
          sameSite: has("samesite=")?.slice("samesite=".length) ?? "",
        });
    }
    return response;
  };
  return { serve, jar, fromThePage };
}

export async function signedUp(email = "ada@example.com", identity = createIdentity(ORIGIN)) {
  const tab = browser(identity);
  const account = createAccount({ origin: ORIGIN, fetch: tab.serve });
  await account.sendCode(email);
  const code = identity.outbox.at(-1)?.otp ?? "";
  const who = await account.signInWithCode(email, code);
  return { identity, tab, account, who };
}

/** The session's token, as the cookie carries it: what must never come back out of this module. */
export function tokenIn(jar: Map<string, Cookie>): string {
  const session = [...jar].find(([name]) => name.endsWith("session_token"))?.[1];
  return decodeURIComponent(session?.value ?? "").split(".")[0] ?? "";
}
