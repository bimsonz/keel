// What the pages above every project are made of.

import { type ReactNode, useCallback, useState } from "react";

/** A handle is a user's name on this Keel, or an org's: the first segment of every address under it. */
export const HANDLE = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;

/** Runs one thing the reader asked for, and says so if Keel refuses it. */
export function useAsking(): {
  busy: boolean;
  refused: string | null;
  ask: (what: () => Promise<void>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const ask = useCallback(async (what: () => Promise<void>) => {
    setBusy(true);
    setRefused(null);
    try {
      await what();
    } catch (error) {
      setRefused(error instanceof Error ? error.message : "Keel could not be reached");
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, refused, ask };
}

export function Refusal({ said }: { said: string | null }) {
  if (said === null) return null;
  return (
    <p role="alert" className="text-sm" style={{ color: "var(--a-critical-ink, #f87171)" }}>
      {said}
    </p>
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
