// The review a proposal from a fork waits for, as GitHub's merge box says a review is required: Keel verifies
// nothing of it until a maintainer approves the commit it carries. A maintainer approves that commit, asks for
// changes or closes the proposal; its proposer may close it; anyone else reads who approves. Keel decides who
// may: the console offers what the reader's role on the project allows, and shows what Keel answers.

import { Button } from "@cloudflare/kumo";
import { ChatCircleDotsIcon, EyeIcon, ShieldWarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Refusal, useAsking } from "../account/parts.tsx";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "./pull.css";

/** A proposal as its review box shows it. */
export interface ReviewedProposal {
  fork: string;
  /** The fork's commit the proposal carries now: the one an approval names. */
  commit: string;
  /** `user:<id>` or `agent:<id>`. */
  proposer: string;
  /** What the page calls its proposer. */
  proposerName: string;
  /** The paths it touches that a person rules on once it is approved. */
  ruledPaths: readonly string[];
  /** The last request for changes: who asked, what, and at which commit. */
  requested?: { byName: string; comment: string; commit: string };
}

export interface ReviewProps {
  proposal: ReviewedProposal;
  /** What the reader is to it: a maintainer of the project, its proposer, or anyone else. */
  reader: "maintainer" | "proposer" | "reader";
  onApprove: (commit: string) => Promise<void>;
  onRequestChanges: (commit: string, comment: string) => Promise<void>;
  onClose: () => Promise<void>;
}

const short = (commit: string) => commit.slice(0, 8);

export function Review({ proposal, reader, onApprove, onRequestChanges, onClose }: ReviewProps) {
  const [comment, setComment] = useState("");
  const { busy, refused, ask } = useAsking();
  const { commit } = proposal;
  return (
    <section className="a-merge" aria-label="Review">
      <div className="a-merge-row" data-tone="guarded">
        <span className="a-merge-icon">
          <EyeIcon size={20} weight="bold" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-base font-semibold text-kumo-strong">Review required</h2>
          <p className="text-sm text-kumo-subtle">
            {proposal.proposerName} proposes{" "}
            <code className="a-mono text-kumo-default">{short(commit)}</code> from their fork. Keel
            has verified nothing of it, and verifies it once a maintainer of this project approves
            this commit.
          </p>
        </div>
      </div>
      {proposal.ruledPaths.length > 0 && (
        <div className="a-merge-row" data-tone="attention">
          <span className="a-merge-icon">
            <ShieldWarningIcon size={20} weight="bold" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 className="text-base font-semibold text-kumo-strong">
              A person's ruling, after approval
            </h3>
            <p className="text-sm text-kumo-subtle">
              It changes how Keel verifies this project, so once it is approved it waits for a
              maintainer's ruling on these paths too:
            </p>
            <ul className="a-mono flex flex-col gap-0.5 text-sm" aria-label="Paths to rule on">
              {proposal.ruledPaths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {proposal.requested !== undefined && (
        <div className="a-merge-row" data-tone="quiet">
          <span className="a-merge-icon">
            <ChatCircleDotsIcon size={20} weight="bold" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 className="text-base font-semibold text-kumo-strong">
              {proposal.requested.byName} requested changes
              {proposal.requested.commit === commit
                ? ""
                : ` to ${short(proposal.requested.commit)}`}
            </h3>
            <p className="text-sm whitespace-pre-wrap text-kumo-default">
              {proposal.requested.comment}
            </p>
          </div>
        </div>
      )}
      <div className="a-merge-row" data-tone="quiet">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {reader === "maintainer" ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void ask(() => onApprove(commit));
              }}
            >
              <label htmlFor="review-comment" className="text-sm font-medium text-kumo-default">
                What to change, if you request changes
              </label>
              <textarea
                id="review-comment"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                rows={3}
                maxLength={65536}
                className="rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
              />
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void ask(onClose)}
                >
                  Close proposal
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy || comment.trim() === ""}
                  onClick={() =>
                    void ask(async () => {
                      await onRequestChanges(commit, comment);
                      setComment("");
                    })
                  }
                >
                  Request changes
                </Button>
                <Button type="submit" size="sm" variant="primary" disabled={busy}>
                  Approve {short(commit)}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-kumo-subtle">
                A maintainer of this project approves it, or asks for changes.
              </p>
              {reader === "proposer" && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void ask(onClose)}
                >
                  Close proposal
                </Button>
              )}
            </div>
          )}
          <Refusal said={refused} />
        </div>
      </div>
    </section>
  );
}
