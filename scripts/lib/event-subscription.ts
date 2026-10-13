// The Queues event subscription `scripts/provision.ts` ensures: what it asks
// Cloudflare for, and what to do given the subscriptions the account already
// holds. Nothing here calls Cloudflare: the script does, and hands in what it
// read or the function that reads a page, so a test can reach every decision
// without an account.

/** How an event subscription names one Workflow's instances as its source. */
const WORKFLOW_SOURCE = "workflows.workflow";

/** The one kind of destination an event subscription has. */
const QUEUE_DESTINATION = "queues.queue";

/** One Workflow's instance events, delivered to one queue. */
export interface WorkflowEvents {
  /** The subscription's own name. It identifies nothing: a subscription is found by its Workflow. */
  readonly name: string;
  readonly workflow: string;
  readonly queue: string;
  /**
   * Named as a subscription names them (`instance.errored`), not by the `type`
   * a delivered event carries (`cf.workflows.workflow.instance.errored`).
   */
  readonly events: readonly string[];
}

/** The body of `POST /event_subscriptions/subscriptions`. */
export interface SubscriptionRequest {
  readonly name: string;
  readonly enabled: true;
  readonly source: { readonly type: typeof WORKFLOW_SOURCE; readonly workflow_name: string };
  readonly destination: { readonly type: typeof QUEUE_DESTINATION; readonly queue_id: string };
  readonly events: readonly string[];
}

/**
 * What to do about a wanted subscription: create it, keep the one that is
 * there, or stop because what is there differs. `differing` holds one line for
 * each subscription in the way, naming it and how it differs.
 */
export type Ensured =
  | { readonly action: "create"; readonly request: SubscriptionRequest }
  | { readonly action: "keep"; readonly id: string }
  | { readonly action: "stop"; readonly differing: readonly string[] };

/**
 * How an environment's jobs queue hears that a `keel-verify-batch` instance
 * errored or was terminated. The Workflow is the one `apps/keel/wrangler.jsonc`
 * binds as `CI_WORKFLOW`, and the queue the one its `JOBS` producer writes to.
 */
export function verifyEnded(environment: string): WorkflowEvents {
  return {
    name: `keel-${environment}-verify-ended`,
    workflow: "keel-verify-batch",
    queue: `keel-${environment}-jobs`,
    events: ["instance.errored", "instance.terminated"],
  };
}

const field = (value: unknown, key: string): unknown => Reflect.get(Object(value), key);

const text = (value: unknown): string => (typeof value === "string" ? value : "none");

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The id of the queue called `name` in a queue list result, if it holds one. */
export function queueIdIn(result: unknown, name: string): string | undefined {
  if (!Array.isArray(result)) return undefined;
  const queue: unknown = result.find((item: unknown) => field(item, "queue_name") === name);
  const id = field(queue, "queue_id");
  return typeof id === "string" ? id : undefined;
}

/**
 * Every item of a paged list: `page(n)` is asked for each page from the first,
 * until one comes back with fewer than `size` items. A page with no result is
 * an empty one. Anything else that is not a list is refused: read as empty, it
 * would have `ensure` create a second subscription beside one it never saw.
 */
export async function everyPage(
  page: (number: number) => Promise<unknown>,
  size: number,
): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let number = 1; ; number++) {
    const listed = (await page(number)) ?? [];
    if (!Array.isArray(listed)) throw new Error(`page ${number} of the list is not a list`);
    items.push(...listed);
    if (listed.length < size) return items;
  }
}

/** How a subscription from the wanted Workflow differs from the wanted one. Empty when it does not. */
function differences(wanted: WorkflowEvents, queueId: string, subscription: unknown): string[] {
  const queue = field(field(subscription, "destination"), "queue_id");
  const events = strings(field(subscription, "events"));
  const sameEvents =
    new Set(events).size === new Set(wanted.events).size &&
    wanted.events.every((event) => events.includes(event));
  return [
    ...(queue === queueId ? [] : [`delivers to queue ${text(queue)}, not ${queueId}`]),
    ...(sameEvents
      ? []
      : [`subscribes ${events.join(", ") || "nothing"}, not ${wanted.events.join(", ")}`]),
    ...(field(subscription, "enabled") === true ? [] : ["is not enabled"]),
  ];
}

/**
 * What to do about `wanted`, given its queue's id and every event subscription
 * on the account. A subscription is the wanted one's when its source is that
 * Workflow, whatever it is called. With none, it is created. With exactly one,
 * enabled and delivering exactly the wanted events to the wanted queue, it is
 * kept: so a second run changes nothing. Anything else from that Workflow
 * stops the step, because a subscription is never updated or replaced here.
 */
export function ensure(
  wanted: WorkflowEvents,
  queueId: string,
  listed: readonly unknown[],
): Ensured {
  const found = listed.filter((subscription) => {
    const source = field(subscription, "source");
    return (
      field(source, "type") === WORKFLOW_SOURCE &&
      field(source, "workflow_name") === wanted.workflow
    );
  });
  if (found.length === 0)
    return {
      action: "create",
      request: {
        name: wanted.name,
        enabled: true,
        source: { type: WORKFLOW_SOURCE, workflow_name: wanted.workflow },
        destination: { type: QUEUE_DESTINATION, queue_id: queueId },
        events: wanted.events,
      },
    };
  const differing = found.flatMap((subscription) => {
    const how = [
      ...(found.length === 1 ? [] : [`is one of ${found.length} from ${wanted.workflow}`]),
      ...differences(wanted, queueId, subscription),
    ];
    return how.length === 0
      ? []
      : [
          `${text(field(subscription, "id"))} "${text(field(subscription, "name"))}": ${how.join("; ")}`,
        ];
  });
  return differing.length === 0
    ? { action: "keep", id: text(field(found[0], "id")) }
    : { action: "stop", differing };
}
