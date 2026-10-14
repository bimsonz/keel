import { LEGAL } from "../legal/legal.ts";

/** Where Keel's source, its walk from a key to a first change and its API's description are. */
export const ABOUT: readonly { label: string; href: string }[] = [
  { label: "Source on GitHub", href: "https://github.com/bimsonz/keel" },
  { label: "Quickstart", href: "/start" },
  { label: "API", href: "/v1/openapi.json" },
];

/** The foot of every page: the two documents an account on this Keel is held to, and where Keel itself is read. */
export function Footer() {
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-5 border-t border-kumo-line bg-kumo-base px-6">
      <nav
        aria-label="Terms and privacy"
        className="flex h-9 items-center gap-5 text-[13px] text-kumo-subtle"
      >
        <a href={LEGAL.terms.href} className="hover:underline">
          {LEGAL.terms.title}
        </a>
        <a href={LEGAL.privacy.href} className="hover:underline">
          {LEGAL.privacy.title}
        </a>
      </nav>
      <nav
        aria-label="About Keel"
        className="flex h-9 items-center gap-5 text-[13px] text-kumo-subtle"
      >
        {ABOUT.map((link) => (
          <a key={link.href} href={link.href} className="hover:underline">
            {link.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}
