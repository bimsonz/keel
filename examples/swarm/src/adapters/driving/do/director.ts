import { DurableObject } from "cloudflare:workers";
import { dispatch, init } from "@flue/runtime";
import { Coder } from "../../../agents/coder.ts";
import { CEILINGS, NO_SLOTS, give, take, type Slots } from "../../../run/ceilings.ts";
import { eventsIn, recordsFrom, type KeelEvent } from "../../../run/events.ts";
import { workerAt } from "../../../run/dispatch.ts";
import { summarise, type Report, type WorkerRecord } from "../../../run/report.ts";
import type { GivenTask } from "../../../run/start.ts";
import type { Member, Namespaces, SettingsChange } from "./keyring.ts";

/**
 * The two shapes a swarm takes: (a) "one" agent account running many runs
 * at once, each with its own label, changes and workspaces; (b) "many"
 * accounts, one run each.
 */
export type Shape = "one" | "many";

interface Roster {
  readonly one?: Member & { readonly keyring: string };
  readonly many: readonly (Member & { readonly keyring: string })[];
  /** How many "many" accounts are wanted; the alarm signs them up one at a time. */
  readonly wanted: number;
  /** "many" accounts still to accept an invitation, and the project. */
  readonly accepting?: {
    readonly project: string;
    readonly next: number;
    readonly states: Readonly<Record<string, string>>;
  };
  /** What stopped the last sign-up or accept, if anything did; cleared by the next that succeeds. */
  readonly lastError?: string | undefined;
}

interface Run {
  readonly id: string;
  readonly shape: Shape;
  readonly workers: number;
  readonly seed: number;
  readonly project: string;
  readonly startedAt: string;
  readonly rampMs: number;
  /** Trunk's head as the run began: where its pairs' premises are anchored. */
  readonly base?: string | undefined;
  /** The tasks it was given, one a worker, in place of planned ones. */
  readonly tasks?: readonly GivenTask[] | undefined;
  /** The Workers AI model its workers think with, when not the Worker's own. */
  readonly model?: string | undefined;
  readonly dispatched: number;
  readonly slots: Slots;
  readonly stoppedAt?: string;
  readonly errors: readonly string[];
}

const EMPTY: Roster = { many: [], wanted: 0 };
/** Sign-ups share one address's limit of 30 a minute with every other workers.dev Worker: 20 a minute. */
const SIGN_UP_EVERY_MS = 3_000;
/** Each accept mints a token; tokens are limited to 60 a minute an address. */
const ACCEPT_EVERY_MS = 1_500;
/** About the pool's refill rate: two workspaces forked every few seconds. */
const DEFAULT_RAMP_MS = 2_500;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The swarm's one director: who its accounts are, the run under way, and the
 * model's ceilings. It starts each worker through Flue's dispatch, ramped so
 * tokens and workspaces keep up, and reads the run's outcome from Keel's own
 * record of the project.
 */
export class Director extends DurableObject<Env> {
  #keyring(name: string) {
    return this.env.KEYRING.get(this.env.KEYRING.idFromName(name));
  }

  // The roster is read and written synchronously, and every change reads it
  // again: a sign-up or an accept that waited on Keel writes onto the roster
  // as it is when the answer comes, not the copy it read before, which another
  // call may have changed meanwhile.
  #roster(): Roster {
    return this.ctx.storage.kv.get<Roster>("roster") ?? EMPTY;
  }

  #change(change: (roster: Roster) => Roster): Roster {
    const next = change(this.#roster());
    this.ctx.storage.kv.put("roster", next);
    return next;
  }

  async #run(): Promise<Run | undefined> {
    return this.ctx.storage.get<Run>("run");
  }

  /** The accounts, as far as they are signed up. */
  async roster(): Promise<Roster> {
    return this.#roster();
  }

  /**
   * Signs up the shape's accounts: "one" at once; "many" up to `count`, one
   * every three seconds from the alarm.
   */
  async enlist(shape: Shape, count: number): Promise<Roster> {
    if (shape === "one") {
      const member = await this.#keyring("one").enlist("swarm-one");
      return this.#change((roster) => ({ ...roster, one: { ...member, keyring: "one" } }));
    }
    const next = this.#change((roster) => ({
      ...roster,
      wanted: Math.max(roster.wanted, count),
    }));
    await this.ctx.storage.setAlarm(Date.now());
    return next;
  }

  /** Accepts the shape's invitations to `project`: "one" at once; "many" one at a time from the alarm. */
  async accept(shape: Shape, project: string): Promise<Roster | string> {
    if (shape === "one") return this.#keyring("one").accept(project);
    const next = this.#change((roster) => ({
      ...roster,
      accepting: { project, next: 0, states: {} },
    }));
    await this.ctx.storage.setAlarm(Date.now());
    return next;
  }

  /** A project the one account owns, for a rehearsal that needs no person. */
  async ownProject(name: string): Promise<{ readonly id: string; readonly name: string }> {
    return this.#keyring("one").ownProject(name);
  }

  /** A project the one account owns: public, so a person can watch a run on Mission Control, and verified. */
  async configure(project: string, change: SettingsChange): Promise<SettingsChange> {
    return this.#keyring("one").configure(project, change);
  }

  /** What Keel says the one account is, and what it should do next, as JSON. */
  async whoami(): Promise<string> {
    return this.#keyring("one").whoami();
  }

  /** Accepts the one account's invitation into `namespace`; answers the namespaces it was invited into. */
  async join(namespace: string): Promise<Namespaces> {
    return this.#keyring("one").join(namespace);
  }

  /** Starts a run of `workers` workers, on given tasks or planned ones; one run at a time. */
  async start(options: {
    readonly shape: Shape;
    readonly workers: number;
    readonly seed: number;
    readonly project: string;
    readonly rampMs?: number;
    readonly tasks?: readonly GivenTask[];
    readonly model?: string;
  }): Promise<Run> {
    const current = await this.#run();
    if (current !== undefined && current.stoppedAt === undefined)
      throw new Error(`Run ${current.id} is still under way.`);
    const roster = this.#roster();
    if (options.shape === "one" && roster.one === undefined)
      throw new Error("Enlist the one account first.");
    if (options.shape === "many" && roster.many.length < options.workers)
      throw new Error(
        `Only ${roster.many.length} accounts are signed up; the run needs ${options.workers}.`,
      );
    const reader = options.shape === "one" ? "one" : roster.many[0]?.keyring;
    const base =
      reader === undefined ? undefined : await this.#keyring(reader).head(options.project);
    const now = new Date();
    const run: Run = {
      id: `r${now.toISOString().replace(/\D/g, "").slice(2, 12)}`,
      shape: options.shape,
      workers: options.workers,
      seed: options.seed,
      project: options.project,
      startedAt: now.toISOString(),
      rampMs: options.rampMs ?? DEFAULT_RAMP_MS,
      base,
      ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
      ...(options.model === undefined ? {} : { model: options.model }),
      dispatched: 0,
      slots: NO_SLOTS,
      errors: [],
    };
    await this.ctx.storage.put("run", run);
    await this.ctx.storage.setAlarm(Date.now());
    return run;
  }

  /** Stops the run: no more workers start, and those working are aborted. */
  async stop(): Promise<Run | undefined> {
    const run = await this.#run();
    if (run === undefined || run.stoppedAt !== undefined) return run;
    const stopped = { ...run, stoppedAt: new Date().toISOString() };
    await this.ctx.storage.put("run", stopped);
    await Promise.allSettled(
      Array.from({ length: run.dispatched }, (_, i) =>
        init(Coder, { id: `${run.id}-${i}` }).abort(),
      ),
    );
    return stopped;
  }

  /** A slot for one model call of the run under way. */
  async take(id: string): Promise<{
    readonly granted: boolean;
    readonly reason?: "busy" | "paced" | "spent";
    readonly retryInMs?: number;
  }> {
    const run = await this.#run();
    if (run === undefined || run.stoppedAt !== undefined)
      return { granted: false, reason: "spent", retryInMs: 0 };
    const taken = take(run.slots, id, Date.now(), CEILINGS);
    await this.ctx.storage.put("run", { ...run, slots: taken.slots });
    return taken.granted
      ? { granted: true }
      : { granted: false, reason: taken.reason, retryInMs: taken.retryInMs };
  }

  async give(id: string, limited = false): Promise<void> {
    const run = await this.#run();
    if (run !== undefined)
      await this.ctx.storage.put("run", { ...run, slots: give(run.slots, id, limited) });
  }

  /** The run's numbers, from Keel's record of the project and the calls the gate granted. */
  async report(): Promise<{
    readonly run: Omit<Run, "slots"> & {
      readonly modelCalls: number;
      readonly modelLimited: number;
    };
    readonly report: Report;
    readonly records: readonly WorkerRecord[];
  } | null> {
    const run = await this.#run();
    if (run === undefined) return null;
    const keyring = this.#keyring(
      run.shape === "one" ? "one" : (this.#roster().many[0]?.keyring ?? "one"),
    );
    const scope = { project: run.project, run: run.shape === "one" ? `${run.id}-report` : run.id };
    // Page after page, oldest first, until the feed has no more; at most 200 pages of 500.
    const read = async (cursor: string | undefined, pages: number): Promise<KeelEvent[]> => {
      const answer = await keyring.events({
        ...scope,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const events = eventsIn(answer.page);
      if (answer.count === 0 || answer.cursor === cursor || pages >= 200) return events;
      return [...events, ...(await read(answer.cursor, pages + 1))];
    };
    const events = await read(undefined, 1);
    const records = recordsFrom(events, {
      dir: `test/swarm/${run.id}`,
      workers: run.workers,
      label: run.id,
      ...(run.tasks?.some((t) => t.label !== undefined) === true
        ? { labels: run.tasks.map((t, i) => t.label ?? `${run.id}-${i}`) }
        : {}),
    });
    const { slots, ...rest } = run;
    return {
      run: { ...rest, modelCalls: slots.used, modelLimited: slots.limited },
      report: summarise(records, slots.used, slots.limited),
      records,
    };
  }

  /** Wipes every account's key and the roster. */
  async forget(): Promise<{ readonly forgotten: number }> {
    const roster = this.#roster();
    const names = [
      ...(roster.one === undefined ? [] : ["one"]),
      ...roster.many.map((m) => m.keyring),
    ];
    await Promise.all(names.map((name) => this.#keyring(name).forget()));
    this.#change(() => EMPTY);
    return { forgotten: names.length };
  }

  /** One step of whatever is under way: a sign-up, an accept, or a worker's start. */
  override async alarm(): Promise<void> {
    const roster = this.#roster();
    if (roster.many.length < roster.wanted) {
      const index = roster.many.length;
      const keyring = `many-${index}`;
      try {
        const member = await this.#keyring(keyring).enlist(`swarm-${index}`);
        this.#change((latest) => ({
          ...latest,
          many: [...latest.many, { ...member, keyring }],
          lastError: undefined,
        }));
      } catch (error) {
        // The sign-up limit's 429 names no retry time: wait a full window.
        this.#change((latest) => ({ ...latest, lastError: `sign-up ${index}: ${message(error)}` }));
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + SIGN_UP_EVERY_MS);
      return;
    }
    const accepting = roster.accepting;
    if (accepting !== undefined && accepting.next < roster.many.length) {
      const member = roster.many[accepting.next];
      if (member !== undefined) {
        try {
          const state = await this.#keyring(member.keyring).accept(accepting.project);
          this.#change((latest) => ({
            ...latest,
            accepting: {
              ...accepting,
              next: accepting.next + 1,
              states: { ...accepting.states, [member.handle]: state },
            },
            lastError: undefined,
          }));
        } catch (error) {
          this.#change((latest) => ({
            ...latest,
            lastError: `accept ${member.handle}: ${message(error)}`,
          }));
          await this.ctx.storage.setAlarm(Date.now() + 60_000);
          return;
        }
      }
      await this.ctx.storage.setAlarm(Date.now() + ACCEPT_EVERY_MS);
      return;
    }
    const run = await this.#run();
    if (run === undefined || run.stoppedAt !== undefined || run.dispatched >= run.workers) return;
    const index = run.dispatched;
    const worker = workerAt(run, index, run.shape === "one" ? "one" : roster.many[index]?.keyring);
    let errors = run.errors;
    if (worker === undefined) {
      errors = [...errors, `worker ${index}: no task or account`];
    } else {
      try {
        await dispatch(Coder, worker);
      } catch (error) {
        errors = [...errors, `worker ${index}: ${message(error)}`];
      }
    }
    // Read again: slots were taken and given while the dispatch was awaited.
    const latest = (await this.#run()) ?? run;
    await this.ctx.storage.put("run", { ...latest, dispatched: index + 1, errors });
    if (index + 1 < run.workers) await this.ctx.storage.setAlarm(Date.now() + run.rampMs);
  }
}
