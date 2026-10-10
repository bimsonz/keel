import { Result } from "effect";

/**
 * Where a proposition holds: dimension → the atoms it covers. A dimension a
 * scope does not mention is unconstrained, so `{}` is everywhere.
 *
 * On the wire a scope is a string, `env:prod|staging;tenant:t1`; an absent or
 * empty scope is everywhere.
 */
export type Scope = { readonly [dimension: string]: readonly string[] };

export const everywhere: Scope = {};

const atomPattern = /^[a-z0-9][a-z0-9._-]*$/;

export const readScope = (wire: string | undefined): Result.Result<Scope, string> => {
  if (wire === undefined || wire.trim() === "") return Result.succeed(everywhere);
  const dimensions: Record<string, readonly string[]> = {};
  for (const part of wire.split(";")) {
    const [dimension = "", atoms = "", ...rest] = part.split(":").map((s) => s.trim());
    const list = atoms.split("|").map((a) => a.trim());
    if (rest.length > 0 || !atomPattern.test(dimension) || !list.every((a) => atomPattern.test(a))) {
      return Result.fail(`scope part "${part}" is not dimension:atom|atom`);
    }
    if (dimensions[dimension] !== undefined) return Result.fail(`scope repeats dimension "${dimension}"`);
    dimensions[dimension] = [...new Set(list)].toSorted();
  }
  return Result.succeed(dimensions);
};

export const writeScope = (scope: Scope): string | undefined => {
  const dimensions = Object.keys(scope).toSorted();
  return dimensions.length === 0
    ? undefined
    : dimensions.map((d) => `${d}:${[...(scope[d] ?? [])].toSorted().join("|")}`).join(";");
};

/** Every dimension both scopes constrain shares at least one atom. */
export const scopesIntersect = (a: Scope, b: Scope): boolean =>
  Object.entries(a).every(([dimension, atoms]) => {
    const other = b[dimension];
    return other === undefined || atoms.some((x) => other.includes(x));
  });

/** `inner` lies wholly inside `outer`. */
export const scopeCovers = (outer: Scope, inner: Scope): boolean =>
  Object.entries(outer).every(([dimension, atoms]) => {
    const constrained = inner[dimension];
    return constrained !== undefined && constrained.every((x) => atoms.includes(x));
  });
