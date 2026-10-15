// The one way the console shows a thing: what it is and what Keel calls it,
// the state it is in and a line about it, tabs for its parts, and beside the
// main column the other things it is tied to, each a link. A change, a
// conflict and an escalation are all shown so.

import type { ReactNode } from "react";
import type { Route } from "../route.ts";
import { Link } from "../router.tsx";

/** A page that scrolls, as wide as a diff or a matrix needs. */
export function Detail({ children }: { children: ReactNode }) {
  return (
    <div className="a-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-4 px-6 py-5">{children}</div>
    </div>
  );
}

/** `label` is Keel's short name for the thing (#7, C-1, E-1). `state` is its chips; `meta` the line about it. */
export function Head({
  title,
  label,
  state,
  meta,
}: {
  title: ReactNode;
  label: string;
  state: ReactNode;
  meta: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      <h1
        className="text-[24px] font-semibold leading-tight text-kumo-strong"
        style={{ textWrap: "balance" }}
      >
        {title} <span className="a-detail-label">{label}</span>
      </h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-kumo-subtle">
        {state}
        {meta}
      </div>
    </header>
  );
}

export function SubTabs<Tab extends string>({
  label,
  tabs,
  active,
}: {
  label: string;
  tabs: { id: Tab; label: string; count?: number; to: Route }[];
  active: Tab;
}) {
  return (
    <nav aria-label={label} className="a-tabs">
      {tabs.map((tab) => (
        <Link key={tab.id} to={tab.to} aria-current={tab.id === active ? "page" : undefined}>
          {tab.label}
          {tab.count !== undefined && (
            <span className="a-count">{tab.count.toLocaleString("en-US")}</span>
          )}
        </Link>
      ))}
    </nav>
  );
}

/** The main column, and beside it what the thing is tied to. */
export function Split({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">{main}</div>
      <aside className="a-side sticky top-0">{side}</aside>
    </div>
  );
}

/** One kind of tie in the sidebar: a small heading, and the things under it. */
export function Tied({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      <div className="flex flex-col gap-1.5 text-sm text-kumo-default">{children}</div>
    </section>
  );
}
