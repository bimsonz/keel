// Copies every R2 object keyed under one namespace id to the same key under
// another. Keel reads `ns/<namespaceId>/<family>/<hex>` and nothing else, so a
// migration that gives a namespace a new id leaves its objects unread until
// they sit under the new one. Nothing here deletes, and nothing overwrites.

/** One namespace id that becomes another, and whose it is. */
export interface Rehoming {
  readonly from: string;
  readonly to: string;
  readonly handle: string;
}

/** A mapping this step will not act on. */
export class MappingRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MappingRefused";
  }
}

/** The migration this step follows: the one that gives each personal org's projects to its person. */
export const MIGRATION = "apps/keel/migrations/0010_namespaces.sql";

/** How that migration pairs a personal org with its person: the org named after a user. */
const PERSONAL_ORG_JOIN = 'organization o JOIN "user" u ON u.username = o.slug';

const oneSpaced = (sql: string): string => sql.replace(/\s+/g, " ");

/**
 * The query that answers who becomes whom, built on the join the migration's
 * own text re-homes projects by. A migration that pairs them any other way is
 * refused, so this step never copies to ids the migration did not write.
 */
export function mappingQueryFor(migration: string): string {
  const rehomesProjects = /UPDATE projects\b[^;]*;/.exec(oneSpaced(migration))?.[0] ?? "";
  if (
    !rehomesProjects.includes(
      `SET namespace_id = ( SELECT u.id FROM ${PERSONAL_ORG_JOIN} WHERE o.id = projects.namespace_id )`,
    )
  )
    throw new MappingRefused(
      `${MIGRATION} does not re-home projects by the join this step mirrors (${PERSONAL_ORG_JOIN}): change them together`,
    );
  return `SELECT o.id AS "from", u.id AS "to", u.username AS handle FROM ${PERSONAL_ORG_JOIN} ORDER BY u.username`;
}

const ID = "[0-9A-HJKMNP-TV-Z]{26}";
const ORG = new RegExp(`^org_${ID}$`);
const USER = new RegExp(`^usr_${ID}$`);
const HANDLE = /^[a-z0-9][a-z0-9-]*$/;

const field = (from: unknown, name: string): unknown =>
  typeof from === "object" && from !== null ? Reflect.get(from, name) : undefined;

/** The rows of a mapping, each an org's id becoming a user's, no id named twice. */
export function mappingOf(rows: unknown): readonly Rehoming[] {
  if (!Array.isArray(rows)) throw new MappingRefused("the mapping is not a list of rows");
  if (rows.length === 0) throw new MappingRefused("the mapping has no rows");
  const mapping: Rehoming[] = [];
  for (const row of rows) {
    const from = field(row, "from");
    const to = field(row, "to");
    const handle = field(row, "handle");
    if (typeof from !== "string" || !ORG.test(from))
      throw new MappingRefused(`from ${JSON.stringify(from)} is not an org's id`);
    if (typeof to !== "string" || !USER.test(to))
      throw new MappingRefused(`${from}: to ${JSON.stringify(to)} is not a user's id`);
    if (typeof handle !== "string" || !HANDLE.test(handle))
      throw new MappingRefused(`${from}: handle ${JSON.stringify(handle)} is not a handle`);
    if (mapping.some((seen) => seen.from === from))
      throw new MappingRefused(`${from} is mapped twice`);
    if (mapping.some((seen) => seen.to === to))
      throw new MappingRefused(`${to} would take the objects of two orgs`);
    mapping.push({ from, to, handle });
  }
  return mapping;
}

/** The mapping in what `wrangler d1 execute --json` prints for the mapping query. */
export function mappingFromD1(answer: unknown): readonly Rehoming[] {
  const statement: unknown = Array.isArray(answer) && answer.length === 1 ? answer[0] : undefined;
  const rows = field(statement, "results");
  if (field(statement, "success") !== true || !Array.isArray(rows))
    throw new MappingRefused("D1 did not answer the one query with its rows");
  if (rows.length === 0)
    throw new MappingRefused(
      "D1 answers no personal org: the migration that deletes them has run, and the mapping must come from the file written before it",
    );
  return mappingOf(rows);
}

/** What this step uses of an R2 bucket: the binding's own methods, in a Worker or through wrangler's proxy. */
export interface Stored {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
}

export interface StoredBody extends Stored {
  readonly httpMetadata?: object;
  readonly customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Bucket {
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    readonly objects: readonly Stored[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
  head(key: string): Promise<Stored | null>;
  get(key: string): Promise<StoredBody | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options: {
      httpMetadata?: object;
      customMetadata?: Record<string, string>;
      md5: string;
      onlyIf: { etagDoesNotMatch: string };
    },
  ): Promise<Stored | null>;
}

/**
 * - `copy`: nothing is at the destination (a dry run's word); `copied` once it is written.
 * - `same`: the destination already holds these bytes.
 * - `differs`: the destination holds other bytes. It is left as it is.
 * - `in-parts`: the source was uploaded in parts, so R2 holds no hash of it to check a copy against. Not copied.
 */
export type MoveState = "copy" | "copied" | "same" | "differs" | "in-parts";

export interface Move {
  /** The bucket, by the name the caller gave it. */
  readonly bucket: string;
  readonly source: string;
  readonly destination: string;
  readonly size: number;
  readonly state: MoveState;
}

/** A move the operator must look at before the step counts as done. */
export const unsettled = (move: Move): boolean =>
  move.state === "differs" || move.state === "in-parts";

/** R2's etag for an object written in one put: the MD5 of its bytes. */
const MD5 = /^[0-9a-f]{32}$/;

const sameBytes = (a: Stored, b: Stored): boolean => a.size === b.size && a.etag === b.etag;

async function everyObjectUnder(bucket: Bucket, prefix: string, page: number): Promise<Stored[]> {
  const found: Stored[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page is asked for by the last one's cursor
    const listed = await bucket.list({
      prefix,
      limit: page,
      ...(cursor === undefined ? {} : { cursor }),
    });
    found.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return found;
}

/**
 * Writes `source`'s bytes at `destination`, unless something is there. R2
 * checks the bytes it is handed against the source's own MD5 and stores
 * nothing if they differ, so a copy that is written is the source's bytes.
 */
async function copyOne(bucket: Bucket, source: Stored, destination: string): Promise<MoveState> {
  const object = await bucket.get(source.key);
  if (object === null) throw new Error(`${source.key}: listed, and gone before it was read`);
  const written = await bucket.put(destination, await object.arrayBuffer(), {
    ...(object.httpMetadata === undefined ? {} : { httpMetadata: object.httpMetadata }),
    ...(object.customMetadata === undefined ? {} : { customMetadata: object.customMetadata }),
    md5: source.etag,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) return "copied";
  // Something was written there between the look and the put: it stays.
  const there = await bucket.head(destination);
  return there !== null && sameBytes(there, source) ? "same" : "differs";
}

export interface RehomeOptions {
  /** Copy; without it nothing is written and each absent destination reads `copy`. */
  readonly apply: boolean;
  /** Keys asked for in one listing call. */
  readonly page?: number;
}

/**
 * Every object under each `ns/<from>/` in each bucket, with where it goes
 * (`ns/<to>/` and the rest of its key unchanged) and what became of it.
 */
export async function rehome(
  buckets: Readonly<Record<string, Bucket>>,
  mapping: readonly Rehoming[],
  options: RehomeOptions,
): Promise<readonly Move[]> {
  const moves: Move[] = [];
  for (const [name, bucket] of Object.entries(buckets)) {
    for (const { from, to } of mapping) {
      const prefix = `ns/${from}/`;
      // oxlint-disable no-await-in-loop -- one object after another, so the order printed is the order done
      for (const source of await everyObjectUnder(bucket, prefix, options.page ?? 1000)) {
        const destination = `ns/${to}/${source.key.slice(prefix.length)}`;
        const there = await bucket.head(destination);
        const state: MoveState =
          there !== null
            ? sameBytes(there, source)
              ? "same"
              : "differs"
            : !MD5.test(source.etag)
              ? "in-parts"
              : options.apply
                ? await copyOne(bucket, source, destination)
                : "copy";
        moves.push({ bucket: name, source: source.key, destination, size: source.size, state });
      }
      // oxlint-enable no-await-in-loop
    }
  }
  return moves;
}
