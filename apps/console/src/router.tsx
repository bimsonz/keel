// The console's place in the browser's history. An address is read by
// route.ts; this is the part that touches the browser: it follows the address
// as it changes, moves to another without loading the page again, and gives
// every link a real `href`, so a link can be opened in a new tab, copied, or
// gone back from.

import {
  type AnchorHTMLAttributes,
  type ReactNode,
  type Ref,
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { NamespaceKind } from "./contract/keel/index.ts";
import { type Address, type Route, carriedOf, href, parse } from "./route.ts";

const listeners = new Set<() => void>();

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  window.addEventListener("popstate", notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener("popstate", notify);
  };
}

const address = (): string => `${window.location.pathname}${window.location.search}`;

const movers = new Set<() => void>();

/**
 * Hears of a move before any view does. It is for what must be in step with the address by the time the views
 * read it: which project's events are folded.
 */
export function onMove(hear: () => void): () => void {
  movers.add(hear);
  window.addEventListener("popstate", hear);
  return () => {
    movers.delete(hear);
    window.removeEventListener("popstate", hear);
  };
}

/** Goes to an address without loading the page again. `replace` is for an address being corrected, not a move. */
export function navigate(to: string, how: "push" | "replace" = "push"): void {
  if (to === address()) return;
  if (how === "push") window.history.pushState(null, "", to);
  else window.history.replaceState(null, "", to);
  for (const hear of movers) hear();
  for (const notify of listeners) notify();
}

let carried: string | undefined;

/** What every link carries: read once, from the address the console was opened at. */
export function carriedParams(): string {
  carried ??= carriedOf(window.location.search, import.meta.env.DEV);
  return carried;
}

/** The address the browser is at, read as a place. It changes as the reader moves, and on Back. */
export function useAddress(): Address {
  const at = useSyncExternalStore(subscribe, address);
  return useMemo(() => {
    const mark = at.indexOf("?");
    return mark < 0 ? parse(at, "") : parse(at.slice(0, mark), at.slice(mark + 1));
  }, [at]);
}

export interface Where {
  /** The handle of the namespace the project is in. */
  namespace: string;
  /** Whose that namespace is, as Keel said when it found the project. Absent above every project. */
  kind?: NamespaceKind;
  project: string;
  route: Route;
  /** The address of a place in this project. */
  to: (route: Route) => string;
}

const WhereContext = createContext<Where | null>(null);

export function WhereProvider({
  namespace,
  kind,
  project,
  route,
  children,
}: {
  namespace: string;
  kind?: NamespaceKind;
  project: string;
  route: Route;
  children: ReactNode;
}) {
  const where = useMemo(
    (): Where => ({
      namespace,
      ...(kind === undefined ? {} : { kind }),
      project,
      route,
      to: (next) => href(namespace, project, next, carriedParams()),
    }),
    [namespace, kind, project, route],
  );
  return <WhereContext.Provider value={where}>{children}</WhereContext.Provider>;
}

export function useWhere(): Where {
  const where = useContext(WhereContext);
  if (where === null) throw new Error("useWhere needs a WhereProvider above it");
  return where;
}

/**
 * An anchor with an address of the console's own. It moves without a page load only on a plain click: with a
 * modifier held, or another button, the browser does what it always does.
 */
export function Anchor({
  href: target,
  ref,
  onClick,
  children,
  ...rest
}: { href: string; ref?: Ref<HTMLAnchorElement>; children: ReactNode } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "children"
>) {
  return (
    <a
      {...rest}
      ref={ref}
      href={target}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(target);
      }}
    >
      {children}
    </a>
  );
}

/** A link to a place in the project: an anchor with the place's own address, and a part of that page where one is named. */
export function Link({
  to,
  section,
  children,
  ...rest
}: { to: Route; section?: string; ref?: Ref<HTMLAnchorElement>; children: ReactNode } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "children"
>) {
  const place = useWhere().to(to);
  return (
    <Anchor {...rest} href={section === undefined ? place : `${place}#${section}`}>
      {children}
    </Anchor>
  );
}
