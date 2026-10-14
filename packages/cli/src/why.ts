import type { KeelClient } from "@keeltown/sdk";

type WhyAnswer = Awaited<ReturnType<KeelClient["why"]>>;
type Link = WhyAnswer["result"]["chain"][number];
type NextAction = WhyAnswer["next"][number];

const decisionIdOf = (action: NextAction): unknown =>
  Reflect.get(Object(action.args), "decisionId");

const actionLine = (action: NextAction) =>
  `next: ${action.title}${action.operationId === undefined ? "" : ` [${action.operationId}${action.args === undefined ? "" : ` ${JSON.stringify(action.args)}`}]`}`;

/**
 * `why`'s answer as `keeltown why` prints it: Keel's summary, then each
 * decision in turn (`why` answers each decision's links with the decision's
 * record first): its links' summaries, the next actions Keel gives for it, and
 * its links' records, one a line.
 */
export function chainText(answer: WhyAnswer): string {
  const decisions: { id: string; links: Link[] }[] = [];
  for (const link of answer.result.chain) {
    if (link.record.kind === "decision") decisions.push({ id: link.record.id, links: [] });
    decisions.at(-1)?.links.push(link);
  }
  const blocks = decisions.map(({ id, links }) => {
    const [first, ...rest] = links;
    return [
      first?.summary ?? id,
      ...rest.map((link) => `- ${link.summary}`),
      ...answer.next.filter((action) => decisionIdOf(action) === id).map(actionLine),
      "MFP records:",
      ...links.map((link) => JSON.stringify(link.record)),
    ].join("\n");
  });
  return [answer.summary, ...blocks].join("\n\n");
}
