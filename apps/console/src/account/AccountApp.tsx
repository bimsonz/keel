// The pages above every project: signing up and in, the user's own settings, and approving a terminal.
// They read nothing of Keel's log, so they stand without the console's player.

import { Button, Input } from "@cloudflare/kumo";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type Place, hrefOf, nextOf, sentFrom } from "../places.ts";
import { applyMode } from "../theme/mode.ts";
import { Switch } from "../views/Switch.tsx";
import {
  type Account,
  NotOpen,
  type Org,
  type Passkey,
  type Who,
  createAccount,
} from "./account.ts";
import { Invite, NewOrg, OrgPages } from "./OrgPages.tsx";
import { Card, HANDLE, Refusal, go, useAsking } from "./parts.tsx";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "../views/tokens.css";

type Reader =
  | { is: "reading" }
  /** Keel serves no identity here yet. */
  | { is: "closed" }
  | { is: "visitor" }
  | { is: "user"; who: Who };

/** Who is reading, asked of Keel once. A page that changes it goes to another address, where it is asked again. */
function useReader(account: Account): Reader {
  const [reader, setReader] = useState<Reader>({ is: "reading" });
  useEffect(() => {
    let here = true;
    const read = async (): Promise<void> => {
      try {
        const who = await account.who();
        if (here) setReader(who === null ? { is: "visitor" } : { is: "user", who });
      } catch (error) {
        if (!(error instanceof NotOpen)) throw error;
        if (here) setReader({ is: "closed" });
      }
    };
    void read();
    return () => {
      here = false;
    };
  }, [account]);
  return reader;
}

/** Signing in, and signing up: the same three ways, and a new address is signed up by its first code. */
function SignIn({ account, creating }: { account: Account; creating: boolean }) {
  const next = nextOf(window.location.search);
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const { busy, refused, ask } = useAsking();
  // A new user chooses a handle before anything else: it names their own org.
  const onward = creating ? hrefOf({ at: "signup" }, next) : next;

  const send = (event: FormEvent) => {
    event.preventDefault();
    void ask(async () => {
      await account.sendCode(email.trim());
      setSentTo(email.trim());
    });
  };
  const enter = (event: FormEvent) => {
    event.preventDefault();
    void ask(async () => {
      await account.signInWithCode(sentTo ?? "", code.trim());
      go(onward);
    });
  };

  return (
    <Card
      title={creating ? "Create your account" : "Sign in to Keel"}
      lede={
        creating
          ? "An account is a person's. Agents get their own credentials, from the person who sponsors them."
          : undefined
      }
    >
      <div className="flex flex-col gap-2.5">
        {!creating && (
          <Button
            className="w-full justify-center"
            variant="primary"
            disabled={busy}
            onClick={() =>
              void ask(async () => {
                await account.signInWithPasskey();
                go(next);
              })
            }
          >
            Sign in with a passkey
          </Button>
        )}
        <Button
          className="w-full justify-center"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void ask(() => account.signInWithGitHub(`${window.location.origin}${onward}`))
          }
        >
          Continue with GitHub
        </Button>
      </div>
      <div className="flex items-center gap-3 text-sm text-kumo-subtle">
        <span className="h-px flex-1 bg-kumo-line" />
        or with a code sent by email
        <span className="h-px flex-1 bg-kumo-line" />
      </div>
      {sentTo === null ? (
        <form className="flex flex-col gap-3" onSubmit={send}>
          <Input
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button
            className="w-full justify-center"
            type="submit"
            variant={creating ? "primary" : "secondary"}
            disabled={busy}
          >
            Send a code
          </Button>
        </form>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={enter}>
          <Input
            label={`The code sent to ${sentTo}`}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button className="w-full justify-center" type="submit" variant="primary" disabled={busy}>
            {creating ? "Create the account" : "Sign in"}
          </Button>
          <button
            type="button"
            className="a-link self-start text-sm"
            onClick={() => setSentTo(null)}
          >
            Use another address
          </button>
        </form>
      )}
      <Refusal said={refused} />
      <p className="text-sm text-kumo-subtle">
        {creating ? "Already have an account? " : "New to Keel? "}
        <a className="a-link" href={hrefOf({ at: creating ? "login" : "signup" }, next)}>
          {creating ? "Sign in" : "Create an account"}
        </a>
      </p>
    </Card>
  );
}

function ChooseHandle({ account, who }: { account: Account; who: Who }) {
  const next = nextOf(window.location.search);
  const [handle, setHandle] = useState("");
  const { busy, refused, ask } = useAsking();
  const [taken, setTaken] = useState(false);
  const wellFormed = HANDLE.test(handle);
  const choose = (event: FormEvent) => {
    event.preventDefault();
    void ask(async () => {
      if (!(await account.handleIsFree(handle))) {
        setTaken(true);
        return;
      }
      await account.chooseHandle(handle);
      go(next);
    });
  };
  return (
    <Card
      title="Choose your handle"
      lede={`You are signed in as ${who.email}. Your handle is your name on this Keel, and the name of your own org: your projects live under it.`}
    >
      <form className="flex flex-col gap-3" onSubmit={choose}>
        <Input
          label="Handle"
          name="handle"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={handle}
          description={`${window.location.host}/${handle === "" ? "your-handle" : handle}`}
          {...(taken
            ? { error: "That handle is taken." }
            : handle !== "" && !wellFormed
              ? { error: "Lower-case letters, digits and hyphens, and no hyphen at either end." }
              : {})}
          onChange={(event) => {
            setTaken(false);
            setHandle(event.target.value.toLowerCase());
          }}
        />
        <Button
          className="w-full justify-center"
          type="submit"
          variant="primary"
          disabled={busy || !wellFormed}
        >
          Take this handle
        </Button>
      </form>
      <Refusal said={refused} />
    </Card>
  );
}

function Passkeys({ account }: { account: Account }) {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [name, setName] = useState("");
  const { busy, refused, ask } = useAsking();
  // Read when the page opens, and again by whatever changes them.
  const read = useCallback(async () => setPasskeys(await account.passkeys()), [account]);
  useEffect(() => {
    let here = true;
    const list = async (): Promise<void> => {
      const held = await account.passkeys();
      if (here) setPasskeys(held);
    };
    void list();
    return () => {
      here = false;
    };
  }, [account]);
  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Passkeys">
      <h2 className="a-h">Passkeys</h2>
      <p className="text-sm text-kumo-subtle">
        A passkey signs you in from this device with no code and no password.
      </p>
      {passkeys !== null && passkeys.length === 0 && (
        <p className="text-sm text-kumo-default">You have no passkey yet.</p>
      )}
      <ul className="flex flex-col gap-1.5" aria-label="Your passkeys">
        {(passkeys ?? []).map((passkey) => (
          <li key={passkey.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-kumo-strong">
              {passkey.name === "" ? "Unnamed" : passkey.name}
            </span>
            <span className="text-kumo-subtle">added {passkey.createdAt.slice(0, 10)}</span>
            <button
              type="button"
              className="a-link"
              disabled={busy}
              onClick={() =>
                void ask(async () => {
                  await account.removePasskey(passkey.id);
                  await read();
                })
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(async () => {
            await account.addPasskey(name.trim());
            setName("");
            await read();
          });
        }}
      >
        <Input
          label="Name for a new passkey"
          name="passkey"
          placeholder="This laptop"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={busy}>
          Add a passkey
        </Button>
      </form>
      <Refusal said={refused} />
    </section>
  );
}

function Settings({ account, who }: { account: Account; who: Who }) {
  const { busy, refused, ask } = useAsking();
  const [ended, setEnded] = useState(false);
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] font-semibold text-kumo-strong">Your account</h1>
        <p className="text-base text-kumo-default">
          {who.handle === undefined ? who.email : `${who.handle} · ${who.email}`}
        </p>
      </header>
      <Passkeys account={account} />
      <section className="a-panel flex flex-col gap-3 p-4" aria-label="Sessions">
        <h2 className="a-h">Sessions</h2>
        <p className="text-sm text-kumo-subtle">
          Signing out everywhere else ends every other browser and terminal signed in as you. Agents
          are not signed in as you, and are not touched.
        </p>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void ask(async () => {
                await account.signOutElsewhere();
                setEnded(true);
              })
            }
          >
            Sign out everywhere else
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void ask(async () => {
                await account.signOut();
                go("/");
              })
            }
          >
            Sign out
          </Button>
        </div>
        {ended && <p className="text-sm text-kumo-default">Every other session is ended.</p>}
        <Refusal said={refused} />
      </section>
    </div>
  );
}

/** A terminal running `keeltown login` shows a code and sends its person here. */
function Device({ account, who, userCode }: { account: Account; who: Who; userCode: string }) {
  const [typed, setTyped] = useState("");
  const [claimed, setClaimed] = useState(false);
  const [answer, setAnswer] = useState<"approved" | "denied" | null>(null);
  const [unclaimed, setUnclaimed] = useState<string | null>(null);
  const { busy, refused, ask } = useAsking();
  // Opening the page with a code claims it for whoever is signed in. Nothing is approved by that.
  useEffect(() => {
    if (userCode === "") return undefined;
    let here = true;
    const claim = async (): Promise<void> => {
      try {
        await account.claimDevice(userCode);
        if (here) setClaimed(true);
      } catch (error) {
        if (here)
          setUnclaimed(error instanceof Error ? error.message : "Keel could not be reached");
      }
    };
    void claim();
    return () => {
      here = false;
    };
  }, [account, userCode]);

  if (userCode === "")
    return (
      <Card title="Sign a terminal in" lede="Type the code your terminal is showing.">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            go(hrefOf({ at: "device", userCode: typed.trim().toUpperCase() }));
          }}
        >
          <Input
            label="Code"
            name="user_code"
            autoCapitalize="characters"
            spellCheck={false}
            required
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <Button type="submit" variant="primary">
            Continue
          </Button>
        </form>
      </Card>
    );
  if (answer !== null)
    return (
      <Card
        title={answer === "approved" ? "The terminal is signed in" : "The terminal was refused"}
        lede={
          answer === "approved"
            ? `It is signed in as ${who.handle ?? who.email}. Go back to it.`
            : "Nothing was signed in. The code is of no more use."
        }
      >
        {null}
      </Card>
    );
  return (
    <Card
      title="Sign a terminal in as you?"
      lede={`A terminal is showing the code below. Approving it signs that terminal in as ${who.handle ?? who.email}, with everything you may do. Approve it only if the code is the one on your own screen.`}
    >
      <p className="a-mono text-center text-[28px] tracking-widest text-kumo-strong" data-user-code>
        {userCode}
      </p>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={busy || !claimed}
          onClick={() =>
            void ask(async () => {
              await account.approveDevice(userCode);
              setAnswer("approved");
            })
          }
        >
          Approve
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !claimed}
          onClick={() =>
            void ask(async () => {
              await account.denyDevice(userCode);
              setAnswer("denied");
            })
          }
        >
          Refuse
        </Button>
      </div>
      <Refusal said={refused ?? unclaimed} />
    </Card>
  );
}

/** The orgs the reader is in, for the frame's dropdown. Asked for only where the frame names an org. */
function useOrgs(account: Account, wanted: boolean): Org[] {
  const [orgs, setOrgs] = useState<Org[]>([]);
  useEffect(() => {
    if (!wanted) return undefined;
    let here = true;
    const read = async (): Promise<void> => {
      const held = await account.orgs();
      if (here) setOrgs(held);
    };
    void read();
    return () => {
      here = false;
    };
  }, [account, wanted]);
  return orgs;
}

function Shell({
  reader,
  org,
  orgs,
  children,
}: {
  reader: Reader;
  /** The org the address names, where it names one. */
  org?: string | undefined;
  orgs: Org[];
  children: ReactNode;
}) {
  return (
    <div className="a-root flex min-h-screen w-screen flex-col bg-kumo-canvas text-base text-kumo-default">
      <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
        <div className="flex h-12 items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <a href="/" className="flex items-center gap-2.5">
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
                <path d="M2.5 5h15L10 17.5Z" fill="var(--text-color-kumo-strong)" />
              </svg>
              <span className="text-base text-kumo-default">Keel</span>
            </a>
            {org !== undefined && reader.is === "user" && (
              <>
                <span className="text-kumo-inactive">/</span>
                <a
                  href={hrefOf({ at: "org", org, tab: "home" })}
                  className="text-base font-semibold text-kumo-strong hover:underline"
                >
                  {org}
                </a>
                <Switch
                  what="org"
                  here={org}
                  others={orgs.map((held) => ({
                    name: held.handle,
                    href: hrefOf({ at: "org", org: held.handle, tab: "home" }),
                    ...(held.name === held.handle ? {} : { note: held.name }),
                  }))}
                  all={{ label: "New org", href: hrefOf({ at: "new-org" }) }}
                />
              </>
            )}
          </div>
          {reader.is === "user" && (
            <a
              href={hrefOf({ at: "settings" })}
              className="text-sm text-kumo-default hover:underline"
            >
              {reader.who.handle ?? reader.who.email}
            </a>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

export function AccountApp({ place }: { place: Place }) {
  const account = useMemo(() => createAccount({ origin: window.location.origin }), []);
  const reader = useReader(account);
  useEffect(() => {
    applyMode(
      new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark",
    );
  }, []);
  // A page for a signed-in user sends a visitor to sign in, and brings them back to it.
  const sent =
    reader.is === "visitor"
      ? sentFrom(place, reader, window.location)
      : reader.is === "user"
        ? sentFrom(place, { is: "user", handle: reader.who.handle }, window.location)
        : null;
  useEffect(() => {
    if (sent !== null) go(sent);
  }, [sent]);
  const named = reader.is === "user" && reader.who.handle !== undefined;
  const orgs = useOrgs(account, named && place.at === "org");

  let page: ReactNode = null;
  if (reader.is === "closed")
    page = (
      <Card
        title="Signing in is not open on this Keel yet"
        lede="Keel does not serve accounts here yet. Its public projects can be read without one."
      >
        <a className="a-link" href="/">
          Go to the projects
        </a>
      </Card>
    );
  else if (sent !== null) page = null;
  else if (reader.is === "visitor" && (place.at === "login" || place.at === "signup"))
    page = <SignIn account={account} creating={place.at === "signup"} />;
  else if (reader.is === "user" && place.at === "signup")
    page = <ChooseHandle account={account} who={reader.who} />;
  else if (reader.is === "user" && place.at === "settings")
    page = <Settings account={account} who={reader.who} />;
  else if (reader.is === "user" && place.at === "device")
    page = <Device account={account} who={reader.who} userCode={place.userCode} />;
  else if (reader.is === "user" && place.at === "new-org") page = <NewOrg account={account} />;
  else if (reader.is === "user" && place.at === "org")
    page = <OrgPages account={account} who={reader.who} handle={place.org} tab={place.tab} />;
  else if (reader.is === "user" && place.at === "invite")
    page = <Invite account={account} who={reader.who} id={place.id} />;
  return (
    <Shell reader={reader} org={place.at === "org" ? place.org : undefined} orgs={orgs}>
      {page}
    </Shell>
  );
}
