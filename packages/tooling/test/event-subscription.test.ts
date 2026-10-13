import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  ensure,
  everyPage,
  queueIdIn,
  type SubscriptionRequest,
  verifyEnded,
} from "../../../scripts/lib/event-subscription.ts";
import { read, repoRoot } from "../src/scan.ts";

/**
 * `scripts/provision.ts` ensures the one Queues event subscription Terraform
 * cannot hold. The script only makes the calls: what it does with what it
 * finds is decided in `scripts/lib/event-subscription.ts`, and held here
 * against lists shaped as Cloudflare's API answers them. A wrong decision is a
 * second subscription that delivers every event twice, or a changed one that
 * no run reports, and neither shows in what the script prints.
 */

const QUEUE_ID = "queue-id-of-the-jobs-queue";
const wanted = verifyEnded("staging");

/** The request `ensure` makes when the account holds nothing from the Workflow. */
const requested = (): SubscriptionRequest => {
  const step = ensure(wanted, QUEUE_ID, []);
  if (step.action !== "create") throw new Error(`expected a create, got ${step.action}`);
  return step.request;
};

/** A subscription as the list answers it once `request` has been made. */
const listed = (request: object, id = "subscription-1") => ({
  id,
  created_at: "2026-10-13T00:00:00Z",
  modified_at: "2026-10-13T00:00:00Z",
  ...request,
});

/**
 * Subscriptions on the same account that are someone else's: another
 * Workflow's, another source's, and one no source has today, which carries the
 * Workflow's name under a type that is not a Workflow's.
 */
const others = [
  listed(
    { ...requested(), source: { type: "workflows.workflow", workflow_name: "keel-precheck" } },
    "other-1",
  ),
  listed({ ...requested(), source: { type: "r2" }, events: ["bucket.created"] }, "other-2"),
  listed(
    { ...requested(), source: { type: "not.a.workflow", workflow_name: wanted.workflow } },
    "other-3",
  ),
];

/** Reads `value.key.key…`, or undefined where the path runs out. */
const at = (value: unknown, ...path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => Reflect.get(Object(current), key), value);

/** The entry of a wrangler config list that carries `binding`. */
const bound = (list: unknown, binding: string): unknown =>
  Array.isArray(list) ? list.find((item: unknown) => at(item, "binding") === binding) : undefined;

describe("provision's event subscription", () => {
  it("[provision.subscription-created] asks for the Workflow's two events on the queue when nothing from the Workflow is there", () => {
    for (const account of [[], others, [null, "not a subscription", {}]]) {
      expect(ensure(wanted, QUEUE_ID, account)).toEqual({
        action: "create",
        request: {
          name: wanted.name,
          enabled: true,
          source: { type: "workflows.workflow", workflow_name: wanted.workflow },
          destination: { type: "queues.queue", queue_id: QUEUE_ID },
          events: ["instance.errored", "instance.terminated"],
        },
      });
    }
  });

  it("[provision.subscription-kept] changes nothing on a second run: what the first made is kept, whatever it is called and however its events are ordered", () => {
    const made = listed(requested());
    const byHand = listed(
      { ...requested(), name: "made by hand", events: wanted.events.toReversed() },
      "subscription-2",
    );
    for (const subscription of [made, byHand]) {
      expect(ensure(wanted, QUEUE_ID, [...others, subscription])).toEqual({
        action: "keep",
        id: subscription.id,
      });
    }
  });

  it("[provision.subscription-drift] stops, naming the subscription and how it differs, and never creates beside it", () => {
    const request = requested();
    const drifted: readonly (readonly [object, string])[] = [
      [{ ...request, events: ["instance.errored"] }, "subscribes instance.errored, not"],
      [
        { ...request, events: [...request.events, "instance.completed"] },
        "subscribes instance.errored, instance.terminated, instance.completed, not",
      ],
      [{ ...request, events: [] }, "subscribes nothing, not"],
      [
        { ...request, destination: { type: "queues.queue", queue_id: "another-queue" } },
        `delivers to queue another-queue, not ${QUEUE_ID}`,
      ],
      [{ ...request, enabled: false }, "is not enabled"],
    ];
    for (const [changed, how] of drifted) {
      const step = ensure(wanted, QUEUE_ID, [...others, listed(changed)]);
      expect(step.action).toBe("stop");
      const lines = step.action === "stop" ? step.differing : [];
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`subscription-1 "${wanted.name}": `);
      expect(lines[0]).toContain(how);
    }
  });

  it("[provision.subscription-single] stops on two from the Workflow, even when each is as wanted", () => {
    const step = ensure(wanted, QUEUE_ID, [listed(requested()), listed(requested(), "copy")]);
    expect(step).toEqual({
      action: "stop",
      differing: [
        `subscription-1 "${wanted.name}": is one of 2 from ${wanted.workflow}`,
        `copy "${wanted.name}": is one of 2 from ${wanted.workflow}`,
      ],
    });
  });

  it("[provision.subscription-queue] finds the queue's id by its exact name, and none when the queue is not listed", () => {
    const queues = [
      { queue_id: "wrong", queue_name: `${wanted.queue}-dead` },
      { queue_id: QUEUE_ID, queue_name: wanted.queue },
    ];
    expect(queueIdIn(queues, wanted.queue)).toBe(QUEUE_ID);
    expect(queueIdIn(queues.slice(0, 1), wanted.queue)).toBeUndefined();
    expect(queueIdIn(null, wanted.queue)).toBeUndefined();
  });

  it("[provision.subscription-pages] reads every page of the list, stops at the first short one, and refuses a page that is not a list", async () => {
    const pages = [["a", "b"], ["c", "d"], ["e"], ["never asked for"]];
    const asked: number[] = [];
    const page = (answers: readonly unknown[]) => (number: number) => {
      asked.push(number);
      return Promise.resolve(answers[number - 1]);
    };
    expect(await everyPage(page(pages), 2)).toEqual(["a", "b", "c", "d", "e"]);
    expect(asked).toEqual([1, 2, 3]);
    expect(await everyPage(page([["a", "b"], []]), 2)).toEqual(["a", "b"]);
    expect(await everyPage(page([null]), 2)).toEqual([]);
    await expect(everyPage(page([["a", "b"], { result: [] }]), 2)).rejects.toThrow(
      "page 2 of the list is not a list",
    );
  });

  it("[provision.subscription-names] names the Workflow and the queue keel's wrangler.jsonc binds", () => {
    const config: unknown = parse(
      read(repoRoot(import.meta.dirname), "apps/keel/wrangler.jsonc"),
      undefined,
      { allowTrailingComma: true },
    );
    const environment = at(config, "vars", "KEEL_ENV");
    if (typeof environment !== "string") throw new Error("wrangler.jsonc sets no vars.KEEL_ENV");

    const subscription = verifyEnded(environment);
    expect(subscription.workflow).toBe(at(bound(at(config, "workflows"), "CI_WORKFLOW"), "name"));
    expect(subscription.queue).toBe(at(bound(at(config, "queues", "producers"), "JOBS"), "queue"));
  });
});
