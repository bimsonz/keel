// The pages of a public project's log that can never change, kept in the browser between visits. A page read
// from a cursor that came back full (as many entries as were asked for) holds exactly the entries that follow
// that cursor, and always will: the log is only ever appended to. So a reader coming back folds those pages from
// here and reads Keel only for the stretch after them. Only a public project's are kept: its log is anyone's to
// read, while what a private one shows depends on who is signed in. Storage that fails is a page not kept.

import type { EventRecord } from "../contract/keel/index.ts";

/** A full page of a project's log, as Keel answered it. */
export interface KeptPage {
  /** How many entries were asked for: a page is only read back for the same ask. */
  readonly limit: number;
  readonly items: readonly EventRecord[];
  readonly nextCursor: string;
}

export interface LogPages {
  get(projectId: string, cursor: string): Promise<KeptPage | undefined>;
  put(projectId: string, cursor: string, page: KeptPage): Promise<void>;
}

const DATABASE = "keel-console";
const STORE = "log-pages";

const keyOf = (projectId: string, cursor: string): string => `${projectId} ${cursor}`;

/** A request's answer, or its error. */
const done = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

/** The pages kept in this browser's IndexedDB, or none where there is no IndexedDB (a test, a private window that refuses it). */
export function browserLogPages(): LogPages | undefined {
  if (typeof indexedDB === "undefined") return undefined;
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (opened === undefined) {
      const request = indexedDB.open(DATABASE, 1);
      request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE));
      opened = done(request);
    }
    return opened;
  };
  return {
    async get(projectId, cursor) {
      try {
        const store = (await open()).transaction(STORE, "readonly").objectStore(STORE);
        const kept: unknown = await done(store.get(keyOf(projectId, cursor)));
        return isKept(kept) ? kept : undefined;
      } catch {
        return undefined;
      }
    },
    async put(projectId, cursor, page) {
      try {
        const store = (await open()).transaction(STORE, "readwrite").objectStore(STORE);
        await done(store.put(page, keyOf(projectId, cursor)));
      } catch {
        // Not kept: the page is read from Keel next time, as it was this time.
      }
    },
  };
}

function isKept(value: unknown): value is KeptPage {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "limit") === "number" &&
    Array.isArray(Reflect.get(value, "items")) &&
    typeof Reflect.get(value, "nextCursor") === "string"
  );
}
