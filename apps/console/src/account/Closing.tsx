// "Delete your account", last on a person's settings. Keel deletes an account on a fresh passkey sign-in, and
// refuses while it owns a project or is an org's only owner, naming each. The page shows what Keel named, each
// linked to where it is, and deletes nothing else to get there.

import { Button, Input } from "@cloudflare/kumo";
import { useState } from "react";
import { hrefOf } from "../places.ts";
import { TRUNK, href } from "../route.ts";
import { type Account, Refused, type Who } from "./account.ts";
import { NOTHING, type Standing, mayClose } from "./closing.ts";
import { FRESH_SIGN_IN_REQUIRED, wayToFresh } from "./fresh.ts";
import { Refusal, type Said, go, saidOf } from "./parts.tsx";

interface Answer {
  said: Said;
  standing: Standing;
  /** Whether this person has a passkey to sign in afresh with, where that is what Keel asked for. */
  touch: boolean;
}

export function Closing({ account, who }: { account: Account; who: Who }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Answer | null>(null);
  const [afresh, setAfresh] = useState(false);
  const handle = who.handle;
  if (handle === undefined) return null;

  const ask = async (what: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setRefused(null);
    setAfresh(false);
    try {
      await what();
    } catch (error) {
      const said = saidOf(error);
      // An account with no passkey is told by Keel to add one first: there is none to touch here.
      const held =
        said.code === FRESH_SIGN_IN_REQUIRED ? await account.passkeys().catch(() => null) : null;
      setRefused({
        said,
        standing: error instanceof Refused ? error.standing : NOTHING,
        touch: wayToFresh(said.code, held === null ? null : held.length) === "passkey",
      });
    } finally {
      setBusy(false);
    }
  };
  // The touch signs in and deletes nothing: an account is deleted by the button that says so, and by no other.
  const touch = (): Promise<void> =>
    ask(async () => {
      const signedIn = await account.signInWithPasskey();
      // A passkey of another account signs that account in: the page is read again as whoever it is now.
      if (signedIn.id !== who.id) {
        go(hrefOf({ at: "settings" }));
        return;
      }
      setAfresh(true);
    });
  const { projects, orgs } = refused?.standing ?? NOTHING;

  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Delete your account">
      <h2 className="a-h">Delete your account</h2>
      <p className="text-sm text-kumo-subtle">
        This cannot be undone. Keel deletes no project with an account: while yours owns one, or is
        an org's only owner, Keel refuses and names what is in the way.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!mayClose(who, typed)) return;
          void ask(async () => {
            await account.deleteAccount();
            go("/");
          });
        }}
      >
        <Input
          label={`Type ${handle} to delete your account`}
          name="confirm"
          autoCapitalize="none"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={busy || !mayClose(who, typed)}>
          Delete your account
        </Button>
      </form>
      {afresh && (
        <output className="text-sm text-kumo-default">
          You are signed in again with your passkey.
        </output>
      )}
      {/* Keel's sentence. Its ways forward for an org are drawn beside that org, below, and not twice. */}
      {refused !== null && (
        <Refusal said={orgs.length > 0 ? { ...refused.said, next: [] } : refused.said} />
      )}
      {projects.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Projects your account owns">
          {projects.map((name) => (
            <li key={name}>
              <a
                className="a-link break-all"
                href={href(handle, name, { at: "code", kind: "tree", ref: TRUNK, path: "" })}
              >
                {handle}/{name}
              </a>
            </li>
          ))}
        </ul>
      )}
      {orgs.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Orgs you are the only owner of">
          {orgs.map((org) => (
            <li key={org.id} className="flex flex-wrap gap-x-2">
              <span className="break-all text-kumo-strong">{org.handle}</span>
              <a className="a-link" href={hrefOf({ at: "org", org: org.handle, tab: "members" })}>
                {org.next ?? "Members"}
              </a>
            </li>
          ))}
        </ul>
      )}
      {refused?.touch === true && (
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void touch()}>
            Sign in again with a passkey
          </Button>
        </div>
      )}
    </section>
  );
}
