import { LEGAL } from "../legal/legal.ts";

/** The foot of every page: the two documents an account on this Keel is held to. */
export function Footer() {
  return (
    <footer className="shrink-0 border-t border-kumo-line bg-kumo-base">
      <nav
        aria-label="Terms and privacy"
        className="flex h-9 items-center gap-5 px-6 text-[13px] text-kumo-subtle"
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
