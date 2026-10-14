import { LEGAL } from "../legal/legal.ts";

/** The foot of every page, as a hosted product's is: the two documents an account on this Keel is held to. */
export function Footer() {
  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-x-5 border-t border-kumo-line bg-kumo-base px-6">
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
    </footer>
  );
}
