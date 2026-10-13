// What the pages above every project are made of.

import { type ReactNode, useCallback, useState } from "react";
import { KeelRefused } from "../source/types.ts";
import { Refused } from "./account.ts";

/** A handle is a user's name on this Keel, or an org's: the first segment of every address under it. */
export const HANDLE = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;

/** What Keel said in refusing, and the ways forward it gave with that, each by its title. */
export interface Said {
  words: string;
  next: readonly string[];
  /** Keel's own code for the refusal, where it gave one. */
  code: string;
}

export const saidOf = (error: unknown): Said => ({
  words: error instanceof Error ? error.message : "Keel could not be reached",
  next: error instanceof Refused || error instanceof KeelRefused ? error.next : [],
  code: error instanceof Refused || error instanceof KeelRefused ? error.code : "",
});

/** Runs one thing the reader asked for, and says so if Keel refuses it. */
export function useAsking(): {
  busy: boolean;
  refused: Said | null;
  ask: (what: () => Promise<void>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Said | null>(null);
  const ask = useCallback(async (what: () => Promise<void>) => {
    setBusy(true);
    setRefused(null);
    try {
      await what();
    } catch (error) {
      setRefused(saidOf(error));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, refused, ask };
}

/** Keel's refusal in Keel's words, and under it the ways forward Keel gave, where it gave any. */
export function Refusal({ said }: { said: Said | null }) {
  if (said === null) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 text-sm"
      style={{ color: "var(--a-critical-ink, #f87171)" }}
    >
      <p>{said.words}</p>
      {said.next.length > 0 && (
        <ul className="list-disc pl-5" aria-label="Ways forward Keel gave">
          {said.next.map((title) => (
            <li key={title}>{title}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Card({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[420px] flex-col gap-5 px-6 py-14">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[22px] font-semibold text-kumo-strong">{title}</h1>
        {lede !== undefined && <p className="text-base text-kumo-default">{lede}</p>}
      </div>
      {children}
    </div>
  );
}

export const go = (address: string): void => window.location.assign(address);
