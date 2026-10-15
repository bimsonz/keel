// A person's own sessions, as their settings word them. Keel lists each by the
// id of its row, which signs nothing in, with how it was signed in, what the
// browser called itself, and when it was made and last used. Nothing here is
// worked out about a session but a shorter way to say what Keel answered.

import type { OwnSession, SignedInBy } from "./account.ts";

/**
 * How a session was signed in, in plain words. `other` is a session whose row names no way, as every session
 * made before Keel recorded one does: it is a session like any other, and is never worded as a fault.
 */
const SIGNED_IN: Record<SignedInBy, string> = {
  passkey: "Signed in with a passkey",
  "email-otp": "Signed in with an email code",
  github: "Signed in with GitHub",
  device: "Signed in from a terminal",
  other: "Signed in",
};

/** A browser by the mark its user agent carries. The order matters: Edge and Opera carry Chrome's, and Chrome carries Safari's. */
const BROWSERS: readonly (readonly [string, string])[] = [
  ["Edg/", "Edge"],
  ["OPR/", "Opera"],
  ["Firefox/", "Firefox"],
  ["Chrome/", "Chrome"],
  ["Safari/", "Safari"],
];

/** A system by its mark. The order matters: Android carries Linux's, and an iPhone's and an iPad's carry the Mac's. */
const SYSTEMS: readonly (readonly [string, string])[] = [
  ["Windows", "Windows"],
  ["Android", "Android"],
  ["iPhone", "iOS"],
  ["iPad", "iPadOS"],
  ["CrOS", "ChromeOS"],
  ["Mac OS X", "macOS"],
  ["Linux", "Linux"],
];

const marked = (marks: readonly (readonly [string, string])[], userAgent: string) =>
  marks.find(([mark]) => userAgent.includes(mark))?.[1];

/**
 * What a session's browser called itself, shortened to a browser and a system where its user agent names ones
 * known here. Anything else is shown by its own first word, and a session that sent nothing is said to have
 * named none. It is the browser's own claim: Keel records it and checks none of it.
 */
export function deviceOf(userAgent: string | null): string {
  if (userAgent === null || userAgent.trim() === "") return "A device that named no browser";
  const browser = marked(BROWSERS, userAgent);
  if (browser === undefined) return userAgent.trim().split(/[\s/]/)[0] ?? userAgent;
  const system = marked(SYSTEMS, userAgent);
  return system === undefined ? browser : `${browser} on ${system}`;
}

/** One session as a row of the list. */
export interface SessionRow {
  id: string;
  device: string;
  /** What the browser called itself, whole. Empty where it sent nothing. */
  userAgent: string;
  /** The session this page is asking with: it is ended by signing out, so it is offered no End. */
  current: boolean;
  /** How it was signed in, the day and the minute: Keel keeps that exactly, and it tells one session from another. */
  signedIn: string;
  /** The day it was last used. Keel writes a session's row once an hour while it is used, so no minute is claimed. */
  lastUsed: string;
}

const day = (iso: string): string => iso.slice(0, 10);
const minute = (iso: string): string => iso.slice(11, 16);

/** The list as Keel ordered it, the one used last first. No row is moved, left out or added. */
export function rowsOf(sessions: readonly OwnSession[]): SessionRow[] {
  return sessions.map((session) => ({
    id: session.id,
    device: deviceOf(session.userAgent),
    userAgent: session.userAgent ?? "",
    current: session.current,
    signedIn: `${SIGNED_IN[session.signedInBy]} on ${day(session.createdAt)} at ${minute(session.createdAt)}`,
    lastUsed: day(session.lastUsedAt),
  }));
}
