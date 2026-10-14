import { Context } from "effect";

/** JSON as stored: Effect Schema encodes entities into this and decodes them out. */
export type Stored =
  | null
  | boolean
  | number
  | string
  | readonly Stored[]
  | { readonly [key: string]: Stored };

/**
 * A Durable Object's own storage. **Synchronous on purpose**: a decision path
 * reads state, decides and writes state plus outbox inside one `transaction`,
 * with no `await` between, so no other request can interleave.
 */
export class EntityStore extends Context.Service<
  EntityStore,
  {
    readonly get: (kind: string, id: string) => Stored | undefined;
    readonly put: (kind: string, id: string, value: Stored) => void;
    readonly remove: (kind: string, id: string) => void;
    /**
     * The kind's rows in id order: every one, or with `idPrefix` only those
     * whose id starts with it, read as a range of the key rather than a scan
     * of the kind. An empty prefix is the whole kind.
     */
    readonly list: (
      kind: string,
      idPrefix?: string,
    ) => readonly { readonly id: string; readonly value: Stored }[];
    /** Runs `body` atomically: every write inside commits together or not at all. */
    readonly transaction: <A>(body: () => A) => A;
  }
>()("keel/EntityStore") {}
