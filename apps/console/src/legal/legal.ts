// The two documents an account on this Keel is held to, and where each is read. They are pages above every
// project, as the account's are, but they are nobody's in particular: reading one asks nothing of Keel.

export type Legal = "terms" | "privacy";

export const LEGAL: Record<Legal, { title: string; href: string }> = {
  terms: { title: "Terms of Service", href: "/terms" },
  privacy: { title: "Privacy Notice", href: "/privacy" },
};

/** The document an address is for: `/terms` or `/privacy`, and nothing under either. */
export function legalOf(pathname: string): Legal | null {
  const [first, second] = pathname.split("/").filter((segment) => segment !== "");
  return second === undefined && (first === "terms" || first === "privacy") ? first : null;
}
