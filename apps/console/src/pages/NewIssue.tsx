// The form that opens an issue, as a code host's New issue: a title and what is wrong or wanted. Keel numbers it,
// and the page moves to it once Keel has.

import { Button } from "@cloudflare/kumo";
import { useState } from "react";
import { Refusal, useAsking } from "../account/parts.tsx";
import { usePlayer } from "../engine/react.tsx";
import { hrefOf } from "../places.ts";
import { navigate, useWhere } from "../router.tsx";
import type { ReaderMark } from "../views/Frame.tsx";
import { Notice } from "../views/Frame.tsx";
import { Column } from "../views/List.tsx";

/** What an issue's title takes: one line, with no space at either end, at most 256 characters. */
export const titleOf = (typed: string): string => typed.replace(/\s+/g, " ").trim().slice(0, 256);

export function NewIssuePage({ reader }: { reader: ReaderMark | undefined }) {
  const issues = usePlayer().source.issues;
  const { to } = useWhere();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const { busy, refused, ask } = useAsking();

  if (issues === undefined)
    return (
      <Notice title="A test fixture has no issues">
        Keel holds a project's issues, and this is not Keel.
      </Notice>
    );
  if (reader?.name === undefined)
    return (
      <Notice title="Sign in to open an issue">
        <a className="a-link" href={hrefOf({ at: "login" }, to({ at: "new-issue" }))}>
          Sign in
        </a>{" "}
        and you come back to this form.
      </Notice>
    );
  const titled = titleOf(title);
  return (
    <Column>
      <h1 className="text-2xl font-semibold text-kumo-strong">New issue</h1>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (titled === "") return;
          void ask(async () => {
            const opened = await issues.openIssue({ title: titled, body });
            navigate(to({ at: "issue", number: opened.number }));
          });
        }}
      >
        <label htmlFor="issue-title" className="text-sm font-medium text-kumo-default">
          Title
        </label>
        <input
          id="issue-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={256}
          required
          className="rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
        />
        <label htmlFor="issue-body" className="text-sm font-medium text-kumo-default">
          Description
        </label>
        <textarea
          id="issue-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={10}
          maxLength={65536}
          className="rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" variant="primary" disabled={busy || titled === ""}>
            Submit new issue
          </Button>
        </div>
        <Refusal said={refused} />
      </form>
    </Column>
  );
}
