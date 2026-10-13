import { APIError } from "better-auth/api";
import { isD1Unavailable } from "../d1/unavailable.ts";

/**
 * What a query's error is rethrown as: D1 being away for a moment becomes
 * Better Auth's own `SERVICE_UNAVAILABLE` with D1's error as its cause, and
 * any other error is itself.
 */
const read = (error: unknown): unknown =>
  isD1Unavailable(error)
    ? Object.assign(
        new APIError("SERVICE_UNAVAILABLE", { message: "The database did not answer just now" }),
        { cause: error },
      )
    : error;

async function reached<A>(query: () => Promise<A>): Promise<A> {
  try {
    return await query();
  } catch (error) {
    throw read(error);
  }
}

/** A statement's calls that reach the database. */
const QUERIES: ReadonlySet<string | symbol> = new Set(["first", "all", "run", "raw"]);

/**
 * `db` as Better Auth, and this adapter's own statements, are to reach it.
 * Better Auth's session read rethrows an error of its own class as it is and
 * turns any other into "Failed to get session", which says nothing of why. So
 * a query D1 could not take because it was away is rethrown in Better Auth's
 * class, and the doorway can tell a database that was away from a defect by
 * the cause it carries. `batch` is handed the database's own statements and
 * never these wrappers of them.
 */
export function reaching(db: D1Database): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const statement = (inner: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(inner, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (!QUERIES.has(key)) return value.bind(target);
        return (...given: unknown[]) =>
          reached(async (): Promise<unknown> => Reflect.apply(value, target, given));
      },
    });
    real.set(proxy, inner);
    return proxy;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => statement(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) =>
          reached(() => target.batch(statements.map((one) => real.get(one) ?? one)));
      if (key === "exec") return (sql: string) => reached(() => target.exec(sql));
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
