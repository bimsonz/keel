import type { Context } from "hono";
import { malformedBody, validationFailed } from "./problem.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

/** Parses the request body as a JSON object, or throws a 400 problem. */
export async function readJsonObject(c: Context): Promise<JsonObject> {
  let value: unknown;
  try {
    value = JSON.parse(await c.req.text());
  } catch {
    throw malformedBody("request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformedBody("request body must be a JSON object");
  }
  return value as JsonObject;
}

export function requiredString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw validationFailed(`${field} is required and must be a string`);
  return value;
}

export function optionalString(body: JsonObject, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw validationFailed(`${field} must be a string`);
  return value;
}

/** Throws a 422 problem when a check returned an error message. */
export function check(message: string | undefined): void {
  if (message !== undefined) throw validationFailed(message);
}
