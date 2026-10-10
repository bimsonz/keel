import { existsSync } from "node:fs";
import { join } from "node:path";
import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { read } from "../scan.ts";

export const EVENT_NAMES = "event-names";

const CATALOGUE = "docs/domain/events.md";
const MACHINES = "docs/domain/state-machines.md";

/** Irregular past participles accepted as an event's verb. */
const IRREGULAR = new Set([
  "Begun",
  "Broken",
  "Brought",
  "Built",
  "Caught",
  "Chosen",
  "Cut",
  "Done",
  "Drawn",
  "Found",
  "Frozen",
  "Given",
  "Held",
  "Kept",
  "Known",
  "Left",
  "Lost",
  "Made",
  "Met",
  "Paid",
  "Proven",
  "Put",
  "Ran",
  "Read",
  "Run",
  "Sent",
  "Set",
  "Shown",
  "Split",
  "Taken",
  "Thrown",
  "Torn",
  "Withdrawn",
  "Won",
  "Written",
]);

/** Backticked PascalCase names in state-machines.md that are not events. */
const NOT_EVENTS = new Set(["PendingGroup", "PlatformFunction"]);

/** `ChangeSubmitted` → ["Change", "Submitted"]. */
function words(name: string): string[] {
  return name.match(/[A-Z][a-z]*/g) ?? [];
}

/** An event name is a noun followed by a past-tense verb: some word after the first is one. */
export function isPastTense(name: string): boolean {
  return words(name)
    .slice(1)
    .some((word) => /[a-z]ed$/.test(word) || IRREGULAR.has(word));
}

/** Event names: the backticked first cell of each catalogue table row. */
export function catalogued(markdown: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  markdown.split("\n").forEach((text, index) => {
    const match = /^\|\s*`([A-Z][A-Za-z]+)`\s*\|/.exec(text);
    if (match?.[1] !== undefined) out.push({ name: match[1], line: index + 1 });
  });
  return out;
}

/**
 * Every event is a past-tense verb, named once; every event a state machine
 * names is in the catalogue. Canary: `ChangeSubmitted`, the event that starts
 * Precheck, must be catalogued.
 */
export function checkEventNames(root: string, options: GuardOptions = {}): GuardResult {
  const scanned: string[] = [];
  const violations: Violation[] = [];
  const events = existsSync(join(root, CATALOGUE)) ? catalogued(read(root, CATALOGUE)) : [];
  if (events.length > 0) scanned.push(CATALOGUE);

  const seen = new Map<string, number>();
  for (const { name, line } of events) {
    if (!isPastTense(name)) {
      violations.push({
        rule: EVENT_NAMES,
        file: CATALOGUE,
        line,
        message: `${name} is not a past-tense verb`,
      });
    }
    const first = seen.get(name);
    if (first !== undefined) {
      violations.push({
        rule: EVENT_NAMES,
        file: CATALOGUE,
        line,
        message: `${name} is catalogued twice (first at line ${first})`,
      });
    } else {
      seen.set(name, line);
    }
  }

  if (existsSync(join(root, MACHINES))) {
    scanned.push(MACHINES);
    read(root, MACHINES)
      .split("\n")
      .forEach((text, index) => {
        if (!text.startsWith("|")) return;
        for (const match of text.matchAll(/`([A-Z][a-z]+(?:[A-Z][a-z]+)+)`/g)) {
          const name = match[1];
          if (name === undefined || NOT_EVENTS.has(name) || seen.has(name)) continue;
          violations.push({
            rule: EVENT_NAMES,
            file: MACHINES,
            line: index + 1,
            message: `${name} is used by a state machine but missing from the catalogue`,
          });
        }
      });
  }

  const canary = seen.has("ChangeSubmitted") ? [...scanned, "event:ChangeSubmitted"] : scanned;
  return withVacuityCheck(
    EVENT_NAMES,
    canary,
    violations,
    options.vacuity ?? { minFiles: 3, canary: "event:ChangeSubmitted" },
  );
}
