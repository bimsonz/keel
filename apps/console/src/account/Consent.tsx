// Allowing an app to act as you: Keel's sign-in sends a person here with the app's request signed into the
// address. The page names the app and where it sends them back, and one tap is a passkey touch and then the
// answer, as approving a terminal is.

import { Button } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { hrefOf } from "../places.ts";
import { type Account, type Who, nameOf } from "./account.ts";
import { appAskingOf } from "./apps.ts";
import { approveWithPasskey } from "./device.ts";
import { Card, Refusal, type Said, go, saidOf, useAsking } from "./parts.tsx";

export function Consent({
  account,
  who,
  onSignedIn,
}: {
  account: Account;
  who: Who;
  onSignedIn: (who: Who) => void;
}) {
  const asking = appAskingOf(window.location.search);
  const [allower] = useState(who);
  const [name, setName] = useState<string | null>(null);
  const [unread, setUnread] = useState<Said | null>(null);
  /** The account a touch here signed in where it was not the one reading the page. */
  const [changed, setChanged] = useState<Who | null>(null);
  const { busy, refused, ask } = useAsking();
  const clientId = asking?.clientId;
  useEffect(() => {
    if (clientId === undefined) return undefined;
    let here = true;
    const read = async (): Promise<void> => {
      try {
        const named = await account.appName(clientId);
        if (here) setName(named);
      } catch (error) {
        if (here) setUnread(saidOf(error));
      }
    };
    void read();
    return () => {
      here = false;
    };
  }, [account, clientId]);

  if (asking === null)
    return (
      <Card
        title="There is no app's request here"
        lede="An app sends you to this page when it asks to act as you. Start again from the app."
      >
        {null}
      </Card>
    );

  const answer = (accept: boolean): Promise<void> =>
    ask(async () => {
      setChanged(null);
      if (!accept) {
        go(await account.answerApp(asking.query, false));
        return;
      }
      let to = "";
      const came = await approveWithPasskey(
        {
          signIn: () => account.signInWithPasskey(),
          approve: async () => {
            to = await account.answerApp(asking.query, true);
          },
        },
        allower,
      );
      onSignedIn(came.is === "approved" ? allower : came.to);
      if (came.is === "changed") {
        setChanged(came.to);
        return;
      }
      go(to);
    });

  const app = name ?? "This app";
  return (
    <Card
      title={`Allow ${app} to act as you?`}
      lede={`It will be signed in as ${nameOf(allower)} at Keel's MCP server, and sends you back to ${asking.returnsTo}.`}
    >
      <p className="text-sm text-kumo-default">
        Through it, {app} reads what you can read on Keel, lists the questions Keel puts to you, and
        answers one when you tell it to, recorded as your ruling. It cannot invite or sponsor
        agents, change how you sign in, or use Keel's API. It keeps working until you revoke it in{" "}
        <a className="a-link" href={hrefOf({ at: "settings" })}>
          your settings
        </a>
        . Allow it only if you started this from {app} yourself.
      </p>
      {changed !== null && (
        <output className="text-sm text-kumo-default">
          That passkey is {nameOf(changed)}'s, and you are signed in as {nameOf(changed)} now.
          Nothing was allowed: start again from the app to allow it as {nameOf(changed)}.
        </output>
      )}
      <div className="flex gap-2">
        {/* A passkey prompt called off sends nothing, and is said below as any refusal is. */}
        <Button
          variant="primary"
          disabled={busy || name === null}
          onClick={() => void answer(true)}
        >
          Allow with your passkey
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void answer(false)}>
          Deny
        </Button>
      </div>
      <Refusal said={refused ?? unread} />
    </Card>
  );
}
