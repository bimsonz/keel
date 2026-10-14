// An agent's link to the person it asks to sponsor it: `/sponsor#agent=<agentId>&code=<code>`. Keel makes
// it for the agent, with the code in the fragment so that it is in no request line. Whoever holds the code can
// sponsor the agent, so the page keeps it nowhere but in memory: it is read once, taken out of the address
// at once, and rides only in the body of the one call that approves.

/** What the link names: the agent, and the code Keel gave it to show one person. */
export interface SponsorLink {
  agentId: string;
  code: string;
}

/** The link a fragment holds, or null where it is not whole. */
export function linkOf(hash: string): SponsorLink | null {
  const read = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const agentId = read.get("agent") ?? "";
  const code = read.get("code") ?? "";
  return agentId === "" || code === "" ? null : { agentId, code };
}

/**
 * Reads the link from the address and takes the fragment out of it, in the same history entry: the code is
 * then in no entry of the history, no address a person copies and nothing a later page is told. It is put in
 * no storage. What is returned is the only copy.
 */
export function takeLink(
  at: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): SponsorLink | null {
  const link = linkOf(at.hash);
  if (at.hash !== "") history.replaceState(history.state, "", `${at.pathname}${at.search}`);
  return link;
}
