// The review box a proposal waits in, as GitHub's merge box says a review is required: a maintainer approves
// the commit shown or asks for changes, its proposer may close it, and anyone else reads who approves.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Review, type ReviewProps } from "../../../src/views/Review.tsx";

const COMMIT = "c".repeat(40);
const said = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .replaceAll("&#x27;", "'")
    .trim();

const drawn = (over: Partial<ReviewProps> = {}) =>
  said(
    renderToStaticMarkup(
      createElement(Review, {
        proposal: {
          fork: "prj_01J9FFFFFFFFFFFFFFFFFFFFFF",
          commit: COMMIT,
          proposer: "user:usr_01J9PPPPPPPPPPPPPPPPPPPPPP",
          proposerName: "stranger",
          ruledPaths: [],
        },
        reader: "maintainer",
        onApprove: async () => undefined,
        onRequestChanges: async () => undefined,
        onClose: async () => undefined,
        ...over,
      }),
    ),
  );

describe("a proposal's review box", () => {
  it("[review.maintainer] a maintainer is asked to review the commit shown: approve it, ask for changes, or close it; nothing is verified before", () => {
    const text = drawn();
    expect(text).toContain("Review required");
    expect(text).toContain("cccccccc");
    expect(text).toContain("Approve");
    expect(text).toContain("Request changes");
    expect(text).toContain("Close proposal");
    expect(text).toMatch(/verified nothing/i);
  });

  it("[review.ruled-paths] the paths a person must rule on once approved are flagged", () => {
    const text = drawn({
      proposal: {
        fork: "prj_01J9FFFFFFFFFFFFFFFFFFFFFF",
        commit: COMMIT,
        proposer: "agent:agt_01J9AAAAAAAAAAAAAAAAAAAAAA",
        proposerName: "helper",
        ruledPaths: [".keel/flow.json", "package.json"],
      },
    });
    expect(text).toContain(".keel/flow.json");
    expect(text).toContain("package.json");
    expect(text).toMatch(/ruling/i);
  });

  it("[review.others] its proposer may close it and is told a maintainer approves; anyone else reads that alone", () => {
    const proposer = drawn({ reader: "proposer" });
    expect(proposer).toContain("Close proposal");
    expect(proposer).not.toContain("Approve");
    expect(proposer).toMatch(/maintainer/);
    const reader = drawn({ reader: "reader" });
    expect(reader).not.toContain("Approve");
    expect(reader).not.toContain("Close proposal");
    expect(reader).toMatch(/maintainer/);
  });

  it("[review.requested] the last request for changes is shown with who asked and what", () => {
    const text = drawn({
      proposal: {
        fork: "prj_01J9FFFFFFFFFFFFFFFFFFFFFF",
        commit: COMMIT,
        proposer: "user:usr_01J9PPPPPPPPPPPPPPPPPPPPPP",
        proposerName: "stranger",
        ruledPaths: [],
        requested: { byName: "may", comment: "Add a test for the retry", commit: COMMIT },
      },
    });
    expect(text).toContain("may");
    expect(text).toContain("Add a test for the retry");
  });
});
