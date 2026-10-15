/** The marks the platform puts on the error a failed object call is rejected with. */
const MARKS = ["durableObjectReset", "retryable", "overloaded", "remote"] as const;

/**
 * What a defect says of itself, as strings. An Error inside a logged object
 * prints as `{}` in the tail and in Workers Logs, so a line that names a
 * defect spreads this instead. `marks` are the platform's own on a failed
 * object call: they tell an object that restarted from one whose code threw.
 */
export interface DefectLine {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: string;
  readonly marks: readonly (typeof MARKS)[number][];
}

const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** A cause and the causes under it, nearest first, to a depth that ends a cycle. */
const causeOf = (cause: unknown, depth = 0): string =>
  cause instanceof Error && cause.cause !== undefined && depth < 4
    ? `${text(cause)} <- ${causeOf(cause.cause, depth + 1)}`
    : text(cause);

/**
 * What the platform says when an object could not take a call just now and
 * nothing is wrong with the call: it had more work queued than it could take,
 * or it restarted under the call (a deploy). The error carries the platform's
 * marks where it was thrown; a defect that crossed an object's RPC keeps only
 * its name and message, so the platform's sentences are looked for too.
 */
const BUSY = [
  "Durable Object is overloaded.",
  "Your account is generating too much load on Durable Objects.",
  "Durable Object reset because its code was updated.",
] as const;

/** How many causes under an error are read: enough for a wrapper or two, and an end to a cycle. */
const CAUSES = 4;

/** Whether an error, or a cause under it, is an object that could not take the call just now: one to make again after a wait. */
export function isObjectBusy(error: unknown): boolean {
  let at = error;
  for (let depth = 0; depth <= CAUSES && typeof at === "object" && at !== null; depth += 1) {
    if (Reflect.get(at, "overloaded") === true || Reflect.get(at, "retryable") === true)
      return true;
    const message = Reflect.get(at, "message");
    if (typeof message === "string" && BUSY.some((sentence) => message.includes(sentence)))
      return true;
    at = Reflect.get(at, "cause");
  }
  return false;
}

export function describeDefect(defect: unknown): DefectLine {
  const marks = MARKS.filter(
    (mark) => typeof defect === "object" && defect !== null && Reflect.get(defect, mark) === true,
  );
  if (!(defect instanceof Error)) return { name: typeof defect, message: text(defect), marks };
  return {
    name: defect.name,
    message: defect.message,
    ...(defect.stack === undefined ? {} : { stack: defect.stack }),
    ...(defect.cause === undefined ? {} : { cause: causeOf(defect.cause) }),
    marks,
  };
}
