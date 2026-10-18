// The project's issues, as a code host lists a repository's: open or closed, newest first, a page at a time, and
// the way to open one. Keel holds them; the console asks for each page and shows what Keel answers.

import { Button, buttonVariants } from "@cloudflare/kumo";
import { ChatCircleIcon, CheckCircleIcon, RadioButtonIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { IssuePage, ProjectIssue } from "../contract/keel/index.ts";
import { usePlayer } from "../engine/react.tsx";
import { hrefOf } from "../places.ts";
import { Link, useWhere } from "../router.tsx";
import type { KeelIssues } from "../source/types.ts";
import type { ReaderMark } from "../views/Frame.tsx";
import { Notice } from "../views/Frame.tsx";
import { Column, Filters, Nothing, Row, Rows } from "../views/List.tsx";
import { dateTime } from "../views/parts.tsx";

/** An issue's mark: open as a code host draws it, and closed as done or as not done. */
export function IssueMark({ issue, size = 16 }: { issue: ProjectIssue; size?: number }) {
  if (issue.state === "open")
    return <RadioButtonIcon size={size} weight="bold" className="a-issue-open" aria-label="Open" />;
  return issue.closedReason === "completed" ? (
    <CheckCircleIcon
      size={size}
      weight="bold"
      className="a-issue-done"
      aria-label="Closed as completed"
    />
  ) : (
    <CheckCircleIcon
      size={size}
      weight="bold"
      className="a-issue-closed"
      aria-label="Closed as not planned"
    />
  );
}

/** Who opened or wrote something: their handle, or what Keel names them by where they have none. */
export function authorOf(item: { author: string; authorHandle?: string | undefined }): string {
  return item.authorHandle ?? item.author.replace(/^(user|agent):/, "");
}

/** The way to open an issue: the form for a reader who is signed in, and signing in first for a visitor. */
export function NewIssueLink({ reader }: { reader: ReaderMark | undefined }) {
  const { to } = useWhere();
  if (reader === undefined) return null;
  const form = to({ at: "new-issue" });
  return reader.name === undefined ? (
    <a
      href={hrefOf({ at: "login" }, form)}
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      Sign in to open an issue
    </a>
  ) : (
    <Link to={{ at: "new-issue" }} className={buttonVariants({ variant: "primary", size: "sm" })}>
      New issue
    </Link>
  );
}

type Listed =
  | { of: string; pages: readonly IssuePage[] }
  | { of: string; refused: string }
  | undefined;

/** The pages Keel has answered of one state's list, each asked for below the last one's end. */
function useIssues(issues: KeelIssues | undefined, state: "open" | "closed") {
  const [listed, setListed] = useState<Listed>();
  const [asked, setAsked] = useState<{ of: string; before: readonly number[] }>({
    of: state,
    before: [],
  });
  const before = useMemo(() => (asked.of === state ? asked.before : []), [asked, state]);
  useEffect(() => {
    if (issues === undefined) return undefined;
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const pages: IssuePage[] = [await issues.listIssues({ state }, stop.signal)];
        for (const below of before)
          pages.push(await issues.listIssues({ state, before: below }, stop.signal));
        if (!stop.signal.aborted) setListed({ of: state, pages });
      } catch (error) {
        if (!stop.signal.aborted)
          setListed({
            of: state,
            refused: error instanceof Error ? error.message : "Keel did not answer",
          });
      }
    };
    void read();
    return () => stop.abort();
  }, [issues, state, before]);
  const answer = listed?.of === state ? listed : undefined;
  const more = (next: number) => setAsked({ of: state, before: [...before, next] });
  return { answer, more };
}

export function IssuesPage({
  state,
  reader,
}: {
  state: "open" | "closed";
  reader: ReaderMark | undefined;
}) {
  const issues = usePlayer().source.issues;
  const { answer, more } = useIssues(issues, state);

  if (issues === undefined)
    return (
      <Notice title="A test fixture has no issues">
        Keel holds a project's issues, and this is not Keel.
      </Notice>
    );
  const pages = answer !== undefined && "pages" in answer ? answer.pages : [];
  const first = pages[0];
  const items = pages.flatMap((page) => page.items);
  const next = pages.at(-1)?.next;
  return (
    <Column>
      <h1 className="sr-only">Issues</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Filters
          label="Issues by state"
          options={[
            { id: "open", label: "Open", count: first?.open ?? 0 },
            { id: "closed", label: "Closed", count: first?.closed ?? 0 },
          ]}
          active={state}
          to={(chosen) => ({ at: "issues", state: chosen })}
        />
        <NewIssueLink reader={reader} />
      </div>
      {answer === undefined ? (
        <output className="px-1 py-6 text-sm text-kumo-subtle">
          Reading the project's issues…
        </output>
      ) : "refused" in answer ? (
        <Notice title="Keel did not list the issues">{answer.refused}</Notice>
      ) : items.length === 0 ? (
        <Nothing title={state === "open" ? "No open issues" : "No closed issues"}>
          {state === "open"
            ? "Issues are where people and agents ask for something or say what is wrong."
            : undefined}
        </Nothing>
      ) : (
        <Rows label={state === "open" ? "Open issues" : "Closed issues"}>
          {items.map((issue) => (
            <Row
              key={issue.issueId}
              mark={<IssueMark issue={issue} />}
              title={
                <Link to={{ at: "issue", number: issue.number }} className="a-link-quiet">
                  {issue.title}
                </Link>
              }
              meta={
                <>
                  <span className="a-num">#{issue.number}</span>
                  <span>
                    {issue.state === "open" ? "opened" : "closed"}{" "}
                    {dateTime(
                      issue.state === "open" ? issue.openedAt : (issue.closedAt ?? issue.updatedAt),
                    )}{" "}
                    {issue.state === "open" ? `by ${authorOf(issue)}` : ""}
                  </span>
                </>
              }
              {...(issue.comments === 0
                ? {}
                : {
                    tied: (
                      <span className="flex items-center gap-1 text-sm text-kumo-subtle">
                        <ChatCircleIcon size={15} aria-hidden />
                        <span className="a-num">{issue.comments}</span>
                        <span className="sr-only">
                          {issue.comments === 1 ? "comment" : "comments"}
                        </span>
                      </span>
                    ),
                  })}
            />
          ))}
        </Rows>
      )}
      {next !== undefined && (
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={() => more(next)}>
            Show older issues
          </Button>
        </div>
      )}
    </Column>
  );
}
