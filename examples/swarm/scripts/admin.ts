import * as v from "valibot";
import type { Report } from "../src/run/report.ts";

/** The swarm Worker's admin routes, from a script: its URL and admin bearer come from the environment. */
export function swarmAdmin(): <S extends v.GenericSchema>(
  schema: S,
  method: string,
  path: string,
  body?: unknown,
) => Promise<v.InferOutput<S>> {
  const url = process.env["SWARM_URL"];
  const token = process.env["SWARM_ADMIN_TOKEN"];
  if (url === undefined || token === undefined || token.length === 0)
    throw new Error(
      "Set SWARM_URL to the swarm Worker's address and SWARM_ADMIN_TOKEN to its admin bearer.",
    );
  return async (schema, method, path, body) => {
    const response = await fetch(new URL(path, url), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
    const parsed: unknown = JSON.parse(text);
    return v.parse(schema, parsed);
  };
}

const Member = v.looseObject({ handle: v.string(), keyring: v.string() });
export const Roster = v.looseObject({ one: v.optional(Member), many: v.array(Member) });
export const Started = v.looseObject({ id: v.string() });
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;
/** The run's report as the Worker answers it; its numbers are the Worker's own `Report`. */
export const RunReport = v.looseObject({
  run: v.looseObject({
    id: v.string(),
    workers: v.number(),
    dispatched: v.number(),
    errors: v.array(v.string()),
    modelCalls: v.number(),
    modelLimited: v.number(),
  }),
  report: v.custom<Report>(isObject),
  records: v.array(v.looseObject({ outcome: v.string() })),
});
export const Anything = v.unknown();
