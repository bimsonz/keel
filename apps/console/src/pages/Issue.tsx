// One issue, as a code host shows one: its title and state, what its author wrote, the comments in order, how it
// was closed, and the way to comment, close and reopen. Keel decides who may; the console shows what it answers.

import { Button } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { Refusal, useAsking } from "../account/parts.tsx";
import type { IssueComment, IssueThread, ProjectIssue } from "../contract/keel/index.ts";
import { usePlayer } from "../engine/react.tsx";
import { hrefOf } from "../places.ts";
import { Link, useWhere } from "../router.tsx";
import type { ReaderMark } from "../views/Frame.tsx";
import { Notice } from "../views/Frame.tsx";
import { Column } from "../views/List.tsx";
import { Markdown } from "../views/later.tsx";
import { ChangeLink } from "../views/links.tsx";
import { dateTime } from "../views/parts.tsx";
import { authorOf, IssueMark } from "./Issues.tsx";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "../views/issues.css";

const REASON: Record<NonNullable<ProjectIssue["closedReason"]>, string> = {
  completed: "completed",
  "not-planned": "not planned",
  duplicate: "a duplicate",
};

/** One post of the thread: the issue's own text, or a comment. */
function Post({
  item,
  at,
  verb,
  body,
}: {
  item: ProjectIssue | IssueComment;
  at: string;
  verb: string;
  body: string;
}) {
  return (
    <article className="a-post">
      <header>
        <strong>{authorOf(item)}</strong>
        <span>
          {verb} {dateTime(at)}
        </span>
      </header>
      <div>
        {body.trim() === "" ? (
          <p className="text-sm text-kumo-subtle italic">No description provided.</p>
        ) : (
          <Markdown source={body} />
        )}
      </div>
    </article>
  );
}

/** How the issue was closed: by whom, or by which change, and why. */
function Closed({ issue }: { issue: ProjectIssue }) {
  if (issue.state !== "closed") return null;
  const reason = issue.closedReason === undefined ? "" : ` as ${REASON[issue.closedReason]}`;
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-kumo-subtle">
      <IssueMark issue={issue} />
      <span>
        {issue.closedByChange === undefined ? (
          <>
            Closed{reason} by{" "}
            <strong className="text-kumo-default">
              {issue.closedByHandle ?? issue.closedBy?.replace(/^(user|agent):/, "") ?? "Keel"}
            </strong>
          </>
        ) : (
          <>
            Closed{reason} when{" "}
            <ChangeLink id={issue.closedByChange} className="a-link">
              its change
            </ChangeLink>{" "}
            landed
          </>
        )}
        {issue.closedAt === undefined ? "" : ` ${dateTime(issue.closedAt)}`}
      </span>
    </p>
  );
}

export function IssuePage({ number, reader }: { number: number; reader: ReaderMark | undefined }) {
  const issues = usePlayer().source.issues;
  const { to } = useWhere();
  const [read, setRead] = useState<{ thread: IssueThread | null } | { refused: string }>();
  const [turn, setTurn] = useState(0);
  const [draft, setDraft] = useState("");
  const { busy, refused, ask } = useAsking();

  useEffect(() => {
    if (issues === undefined) return undefined;
    const stop = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const thread = await issues.getIssue(number, stop.signal);
        if (!stop.signal.aborted) setRead({ thread });
      } catch (error) {
        if (!stop.signal.aborted)
          setRead({ refused: error instanceof Error ? error.message : "Keel did not answer" });
      }
    };
    void load();
    return () => stop.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `turn` counts this page's moves: each asks Keel again
  }, [issues, number, turn]);

  if (issues === undefined)
    return (
      <Notice title="A test fixture has no issues">
        Keel holds a project's issues, and this is not Keel.
      </Notice>
    );
  if (read === undefined)
    return (
      <Column>
        <output className="px-1 py-6 text-sm text-kumo-subtle">Reading issue #{number}…</output>
      </Column>
    );
  if ("refused" in read) return <Notice title="Keel did not show the issue">{read.refused}</Notice>;
  if (read.thread === null)
    return (
      <Notice title={`No issue #${number}`}>
        This project has no issue of that number.{" "}
        <Link to={{ at: "issues", state: "open" }} className="a-link">
          See its issues
        </Link>
      </Notice>
    );

  const { issue, comments } = read.thread;
  const signedIn = reader?.name !== undefined;
  const move = (what: () => Promise<unknown>, cleared = false) =>
    void ask(async () => {
      await what();
      if (cleared) setDraft("");
      setTurn((n) => n + 1);
    });

  return (
    <Column>
      <header className="flex flex-col gap-2 border-b border-kumo-line pb-4">
        <h1 className="text-2xl font-semibold text-kumo-strong">
          {issue.title} <span className="a-num font-normal text-kumo-subtle">#{issue.number}</span>
        </h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-kumo-subtle">
          <span className="a-chip" data-tone={issue.state === "open" ? "guarded" : "quiet"}>
            <IssueMark issue={issue} size={14} />
            {issue.state === "open" ? "Open" : "Closed"}
          </span>
          <span>
            <strong className="text-kumo-default">{authorOf(issue)}</strong> opened this issue{" "}
            {dateTime(issue.openedAt)} · {issue.comments}{" "}
            {issue.comments === 1 ? "comment" : "comments"}
          </span>
        </p>
      </header>
      <Post item={issue} at={issue.openedAt} verb="opened" body={issue.body} />
      {comments.map((comment) => (
        <Post
          key={comment.commentId}
          item={comment}
          at={comment.at}
          verb="commented"
          body={comment.body}
        />
      ))}
      <Closed issue={issue} />
      {signedIn ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() !== "") move(() => issues.commentOnIssue(issue.number, draft), true);
          }}
        >
          <label htmlFor="issue-comment" className="text-sm font-medium text-kumo-default">
            Add a comment
          </label>
          <textarea
            id="issue-comment"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={5}
            maxLength={65536}
            className="rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {issue.state === "open" ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => move(() => issues.closeIssue(issue.number, "not-planned"))}
                >
                  Close as not planned
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => move(() => issues.closeIssue(issue.number, "completed"))}
                >
                  Close issue
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => move(() => issues.reopenIssue(issue.number))}
              >
                Reopen issue
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={busy || draft.trim() === ""}
            >
              Comment
            </Button>
          </div>
          <Refusal said={refused} />
        </form>
      ) : reader !== undefined ? (
        <p className="text-sm text-kumo-subtle">
          <a className="a-link" href={hrefOf({ at: "login" }, to({ at: "issue", number }))}>
            Sign in
          </a>{" "}
          to comment.
        </p>
      ) : null}
    </Column>
  );
}
