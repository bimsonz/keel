// The pages above every project: signing up and in, the user's own settings, and approving a terminal.
// They read nothing of Keel's log, so they stand without the console's player.

import { accountsOf } from "./accounts.ts";
import { Button, Input } from "@cloudflare/kumo";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type OrgTab, type Place, hrefOf, nextOf, sentFrom } from "../places.ts";
import { createHttpDirectory, createHttpSponsorship } from "../source/http.ts";
import { applyMode } from "../theme/mode.ts";
import { Switch } from "../views/Switch.tsx";
import {
  type Account,
  type Methods,
  NotOpen,
  type Org,
  type Passkey,
  type Who,
  createAccount,
  nameOf,
} from "./account.ts";
import { LEGAL } from "../legal/legal.ts";
import { Footer } from "../views/Footer.tsx";
import { wayToFresh } from "./fresh.ts";
import { Invite, NamespacePages, NamespacePublic, NewOrg } from "./OrgPages.tsx";
import { Card, HANDLE, Refusal, type Said, go, saidOf, useAsking } from "./parts.tsx";
import { Sponsor } from "./Sponsor.tsx";
import { type SponsorLink, takeLink } from "./sponsorLink.ts";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "../views/tokens.css";

type Reader =
  | { is: "reading" }
  /** Keel serves no identity here yet. */
  | { is: "closed" }
  | { is: "visitor" }
  | { is: "user"; who: Who };

/**
 * Who is reading, asked of Keel once. A page that changes it goes to another address, where it is asked again;
 * the sponsor's page alone stays, since what it holds is in memory, and says who its touch signed in.
 */
function useReader(account: Account): [Reader, (who: Who) => void] {
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
  const signedIn = useCallback((who: Who) => setReader({ is: "user", who }), []);
  return [reader, signedIn];
}

/** A handle, as it is typed: what is wrong with it, said under the field. */
function handleError(handle: string, taken: boolean): { error: string } | Record<string, never> {
  if (taken) return { error: "That handle is taken." };
  if (handle !== "" && !HANDLE.test(handle))
    return { error: "Lower-case letters, digits and single hyphens, and no hyphen at either end." };
  return {};
}

/** Signing up with a passkey: a handle, and a passkey made on this device. Keel asks for nothing else. */
function PasskeySignUp({ account, next }: { account: Account; next: string }) {
  const [handle, setHandle] = useState("");
  const [taken, setTaken] = useState(false);
  const { busy, refused, ask } = useAsking();
  const create = (event: FormEvent) => {
    event.preventDefault();
    void ask(async () => {
      if (!(await account.handleIsFree(handle))) {
        setTaken(true);
        return;
      }
      await account.signUpWithPasskey(handle);
      go(next);
    });
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={create}>
      <Input
        label="Handle"
        name="handle"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        value={handle}
        description={`Your name on this Keel. Your projects live at ${window.location.host}/${handle === "" ? "your-handle" : handle}`}
        {...handleError(handle, taken)}
        onChange={(event) => {
          setTaken(false);
          setHandle(event.target.value.toLowerCase());
        }}
      />
      <Button
        className="w-full justify-center"
        type="submit"
        variant="primary"
        disabled={busy || !HANDLE.test(handle)}
      >
        Create your account with a passkey
      </Button>
      <Refusal said={refused} />
    </form>
  );
}

/** A code sent by email: for a new address it signs up, and the handle is chosen next. */
function EmailCode({
  account,
  creating,
  onward,
}: {
  account: Account;
  creating: boolean;
  onward: string;
}) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const { busy, refused, ask } = useAsking();
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
    <>
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
            variant="secondary"
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
    </>
  );
}

/**
 * Signing in, and signing up. A passkey is always a way in. A code by email and GitHub are shown where this Keel
 * offers them, and nowhere else: no button is put up for Keel to refuse.
 */
function SignIn({
  account,
  creating,
  methods,
}: {
  account: Account;
  creating: boolean;
  methods: Methods;
}) {
  const next = nextOf(window.location.search);
  const { busy, refused, ask } = useAsking();
  // Someone who signs up by a code or with GitHub chooses a handle before anything else: it is their name here, and where their projects live.
  const onward = creating ? hrefOf({ at: "signup" }, next) : next;
  return (
    <Card
      title={creating ? "Create your account" : "Sign in to Keel"}
      lede={
        creating
          ? "An account is a person's. Agents get their own credentials, from the person who sponsors them."
          : undefined
      }
    >
      {creating ? (
        <PasskeySignUp account={account} next={next} />
      ) : (
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
      {methods.github && (
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
      )}
      <Refusal said={refused} />
      {methods.emailCode && (
        <>
          <div className="flex items-center gap-3 text-sm text-kumo-subtle">
            <span className="h-px flex-1 bg-kumo-line" />
            or with a code sent by email
            <span className="h-px flex-1 bg-kumo-line" />
          </div>
          <EmailCode account={account} creating={creating} onward={onward} />
        </>
      )}
      {creating && (
        <p className="text-sm text-kumo-subtle" data-agreement>
          By creating an account you agree to the{" "}
          <a className="a-link" href={LEGAL.terms.href}>
            {LEGAL.terms.title}
          </a>{" "}
          and the{" "}
          <a className="a-link" href={LEGAL.privacy.href}>
            {LEGAL.privacy.title}
          </a>
          .
        </p>
      )}
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
      lede={`${who.email === undefined ? "You are signed in" : `You are signed in as ${who.email}`}. Your handle is your name on this Keel, and your projects live under it.`}
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
          {...handleError(handle, taken)}
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

function Passkeys({ account, who }: { account: Account; who: Who }) {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [name, setName] = useState("");
  const { busy, refused, ask } = useAsking();
  /** What was last asked of Keel here: asked again, as it was, once the reader has signed in afresh. */
  const last = useRef<(() => Promise<void>) | null>(null);
  const asking = (what: () => Promise<void>): Promise<void> => {
    last.current = what;
    return ask(what);
  };
  const again = (): Promise<void> =>
    ask(async () => {
      const signedIn = await account.signInWithPasskey();
      // A passkey of another account signs that account in: the page is read again as whoever it is now.
      if (signedIn.id !== who.id) {
        window.location.assign(hrefOf({ at: "settings" }));
        return;
      }
      await last.current?.();
    });
  // Someone with no passkey signs in again the way they came, and comes back here: Keel takes an account's first
  // passkey from a sign-in of its own made in the last ten minutes.
  const afresh = (): Promise<void> =>
    ask(async () => {
      await account.signOut();
      window.location.assign(hrefOf({ at: "login" }, hrefOf({ at: "settings" })));
    });
  const way = wayToFresh(refused?.code, passkeys === null ? null : passkeys.length);
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
                void asking(async () => {
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
          const naming = name.trim();
          void asking(async () => {
            await account.addPasskey(naming);
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
      {/* Under Keel's sentence, the way this person signs in afresh: a touch of the passkey they have, or with
          none the sign-in they came by. */}
      {way === "passkey" && (
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void again()}>
            Sign in again with a passkey
          </Button>
        </div>
      )}
      {way === "sign-in" && (
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void afresh()}>
            Sign in again
          </Button>
        </div>
      )}
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
          {[who.handle, who.email].filter((part) => part !== undefined).join(" · ")}
        </p>
      </header>
      <Passkeys account={account} who={who} />
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
  const [unclaimed, setUnclaimed] = useState<Said | null>(null);
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
        if (here) setUnclaimed(saidOf(error));
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
            ? `It is signed in as ${nameOf(who)}. Go back to it.`
            : "Nothing was signed in. The code is of no more use."
        }
      >
        {null}
      </Card>
    );
  return (
    <Card
      title="Sign a terminal in as you?"
      lede={`A terminal is showing the code below. Approving it signs that terminal in as ${nameOf(who)}, with everything you may do. Approve it only if the code is the one on your own screen.`}
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

/**
 * The orgs the reader is in, for the frame's dropdown: null until Keel has said which. Asked for only where
 * the frame names an org.
 */
function useOrgs(account: Account, wanted: boolean): Org[] | null {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
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

/** Which ways in Keel offers, asked once a visitor is at a page that signs in. Until Keel answers: a passkey. */
function useMethods(account: Account, wanted: boolean): Methods {
  const [methods, setMethods] = useState<Methods>({ emailCode: false, github: false });
  useEffect(() => {
    if (!wanted) return undefined;
    let here = true;
    const read = async (): Promise<void> => {
      const offered = await account.methods();
      if (here) setMethods(offered);
    };
    void read();
    return () => {
      here = false;
    };
  }, [account, wanted]);
  return methods;
}

function Shell({
  reader,
  handle,
  orgs,
  children,
}: {
  reader: Reader;
  /** The handle the address names, where it names one: a namespace's own page, or an org's. */
  handle?: string | undefined;
  /** Null until Keel has listed them: a dropdown opened before that would be a menu without the reader's orgs. */
  orgs: Org[] | null;
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
            {handle !== undefined && (reader.is === "user" || reader.is === "visitor") && (
              <>
                <span className="text-kumo-inactive">/</span>
                <a
                  href={hrefOf({ at: "namespace", handle })}
                  className="text-base font-semibold text-kumo-strong hover:underline"
                >
                  {handle}
                </a>
                {orgs !== null && (
                  <Switch
                    what="account"
                    here={handle}
                    others={accountsOf(orgs, reader.is === "user" ? reader.who : {})}
                    all={{ label: "New org", href: hrefOf({ at: "new-org" }) }}
                  />
                )}
              </>
            )}
          </div>
          {reader.is === "user" && (
            <a
              href={hrefOf({ at: "settings" })}
              className="text-sm text-kumo-default hover:underline"
            >
              {nameOf(reader.who)}
            </a>
          )}
          {/* A visitor at a namespace's page is offered the way in, and comes back to where they were. */}
          {reader.is === "visitor" && handle !== undefined && (
            <a
              href={hrefOf({ at: "login" }, `${window.location.pathname}${window.location.search}`)}
              className="text-sm text-kumo-default hover:underline"
            >
              Sign in
            </a>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}

export function AccountApp({ place, link }: { place: Place; link: SponsorLink | null }) {
  const account = useMemo(() => createAccount({ origin: window.location.origin }), []);
  // A namespace's projects are Keel's own to list, to whoever is reading: the same read the home makes.
  const directory = useMemo(() => createHttpDirectory(), []);
  const sponsorship = useMemo(() => createHttpSponsorship(), []);
  // An agent's link opened while this page is up changes the fragment and loads nothing: it is taken out of the
  // address as the first was, and the page begins again with what it carried.
  const [held, setHeld] = useState({ link, taken: 0 });
  const onSponsor = place.at === "sponsor";
  useEffect(() => {
    if (!onSponsor) return undefined;
    const take = (): void => {
      if (window.location.hash === "") return;
      const carried = takeLink(window.location, window.history);
      setHeld((before) => ({ link: carried, taken: before.taken + 1 }));
    };
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, [onSponsor]);
  const [reader, signedIn] = useReader(account);
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
  // The handle the address names, and which of its pages: a namespace's own is its home.
  const handle =
    place.at === "namespace" ? place.handle : place.at === "org" ? place.org : undefined;
  const tab: OrgTab = place.at === "org" ? place.tab : "home";
  const orgs = useOrgs(account, named && handle !== undefined);
  const signingIn = reader.is === "visitor" && (place.at === "login" || place.at === "signup");
  const methods = useMethods(account, signingIn);

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
    page = <SignIn account={account} creating={place.at === "signup"} methods={methods} />;
  else if (reader.is === "user" && place.at === "signup")
    page = <ChooseHandle account={account} who={reader.who} />;
  else if (reader.is === "user" && place.at === "settings")
    page = <Settings account={account} who={reader.who} />;
  else if (reader.is === "user" && place.at === "device")
    page = <Device account={account} who={reader.who} userCode={place.userCode} />;
  else if (reader.is === "user" && place.at === "new-org") page = <NewOrg account={account} />;
  else if (reader.is === "user" && handle !== undefined)
    page = (
      <NamespacePages
        account={account}
        directory={directory}
        who={reader.who}
        handle={handle}
        tab={tab}
      />
    );
  else if (reader.is === "visitor" && place.at === "namespace")
    page = <NamespacePublic directory={directory} handle={place.handle} signedIn={false} />;
  else if (reader.is === "user" && place.at === "invite")
    page = <Invite account={account} who={reader.who} id={place.id} />;
  else if (place.at === "sponsor" && (reader.is === "user" || reader.is === "visitor"))
    page = (
      <Sponsor
        key={held.taken}
        account={account}
        sponsorship={sponsorship}
        who={reader.is === "user" ? reader.who : null}
        link={held.link}
        onSignedIn={signedIn}
      />
    );
  return (
    <Shell reader={reader} handle={handle} orgs={orgs}>
      {page}
    </Shell>
  );
}
