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
