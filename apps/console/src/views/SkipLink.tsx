import type { MouseEvent } from "react";

/** Where every page's main content starts: the skip link's target. */
export const MAIN = "main";

/**
 * "Skip to content", a code host's first tab stop: hidden until it has focus, and then it takes focus past the
 * header and the tabs to the page's main content, leaving the address as it was.
 */
export function SkipLink() {
  const skip = (event: MouseEvent<HTMLAnchorElement>): void => {
    const main = document.getElementById(MAIN);
    if (main === null) return;
    event.preventDefault();
    main.focus();
  };
  return (
    <a
      href={`#${MAIN}`}
      onClick={skip}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:border focus:border-kumo-line focus:bg-kumo-base focus:px-3 focus:py-2 focus:text-sm focus:text-kumo-strong"
    >
      Skip to content
    </a>
  );
}
