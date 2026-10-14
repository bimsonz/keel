import type { KeelClient } from "@keeltown/sdk";
import type { KeelEvent } from "./report.ts";

/**
 * One reader follows the project's events for every agent of the run, so an
 * agent waiting on its change holds no token: tokens are 5 minutes, limited
 * to 60 a minute an address, and 1,000 agents each polling their own status
 * would spend the limit on waiting.
 */

/** How a change's submission ends, from the event that ends it. */
export const SETTLES: Readonly<Record<string, string>> = {
  ChangeLanded: "landed",
  ChangeBounced: "bounced",
  ChangeWithdrawn: "withdrawn",
  ChangeSuperseded: "superseded",
  ChangeParked: "parked",
};

type Reader = Pick<KeelClient, "events">;

/** About five minutes of failed reads in a row, longer than a deploy takes. */
const MAX_FAILURES = 30;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Watch {
  readonly events: KeelEvent[] = [];
  readonly #reader: Reader;
  readonly #project: string;
  #cursor: string | undefined;
  /** Each change's settlements so far, in order. */
  readonly #settled = new Map<string, string[]>();
  readonly #waiting = new Map<
    string,
    { readonly nth: number; readonly resolve: (state: string) => void }[]
  >();

  constructor(reader: Reader, project: string, cursor: string | undefined) {
    this.#reader = reader;
    this.#project = project;
    this.#cursor = cursor;
  }

  /** The state the change's `nth` submission (from 1) settled in, once it has. */
  settled(changeId: string, nth: number): Promise<string> {
    const known = this.#settled.get(changeId)?.[nth - 1];
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => {
      const list = this.#waiting.get(changeId) ?? [];
      list.push({ nth, resolve });
      this.#waiting.set(changeId, list);
    });
  }

  /** Takes in one page of events, settling whoever waits on them. */
  take(page: readonly KeelEvent[]): void {
    for (const e of page) {
      if (e.project !== this.#project) continue;
      this.events.push(e);
      const state = SETTLES[e.payload._tag];
      const changeId: unknown = Reflect.get(e.payload, "changeId");
      if (state === undefined || typeof changeId !== "string") continue;
      const so = [...(this.#settled.get(changeId) ?? []), state];
      this.#settled.set(changeId, so);
      const waiting = this.#waiting.get(changeId) ?? [];
      for (const waiter of waiting.filter((w) => w.nth <= so.length))
        waiter.resolve(so[waiter.nth - 1] ?? state);
      this.#waiting.set(
        changeId,
        waiting.filter((w) => w.nth > so.length),
      );
    }
  }

  /**
   * Reads the project's events until `done` holds, asking Keel to hold a read
   * open while there is nothing new. A read that fails (a deploy, a fault) is
   * asked again after a pause; only many failures in a row end the watch.
   */
  async follow(done: () => boolean, pause = (ms: number) => sleep(ms)): Promise<void> {
    let failures = 0;
    while (!done()) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time, in order
        const page = await this.#reader.events({
          project: this.#project,
          limit: 500,
          wait: 5,
          ...(this.#cursor === undefined ? {} : { cursor: this.#cursor }),
        });
        failures = 0;
        this.take(page.items);
        if (page.nextCursor !== undefined) this.#cursor = page.nextCursor;
      } catch (error) {
        failures += 1;
        if (failures > MAX_FAILURES) throw error;
        // oxlint-disable-next-line no-await-in-loop -- the pause is the point
        await pause(Math.min(15_000, 1_000 * failures));
      }
    }
  }

  get cursor(): string | undefined {
    return this.#cursor;
  }
}
