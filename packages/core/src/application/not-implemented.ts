import { Effect } from "effect";


/**
 * The defect a use-case stub dies with until its lane implements it. It is a
 * defect, not a tagged error, so stubs keep the exact error union their real
 * implementation will have. The HTTP doorway recognises it by class and answers
 * the declared 503 `service.not_implemented`.
 */
export class NotImplemented extends Error {
  readonly _tag = "NotImplemented";
  readonly useCase: string;

  constructor(useCase: string) {
    super(`${useCase} is not implemented yet`);
    this.name = "NotImplemented";
    this.useCase = useCase;
  }
}

/**
 * A use-case stub: an `Effect.fn` span named after the use-case that dies with
 * `NotImplemented`. Annotate the exported const with the use-case's exact
 * signature; the stub satisfies any of them.
 */
export function stub(name: string) {
  return Effect.fn(name)(function* (..._args: readonly unknown[]) {
    return yield* Effect.die(new NotImplemented(name));
  });
}
