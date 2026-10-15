import { useEffect } from "react";
import { Footer } from "../views/Footer.tsx";
import { HomeLink } from "../views/HomeLink.tsx";
import { MAIN, SkipLink } from "../views/SkipLink.tsx";
import { Markdown } from "../views/later.tsx";
import { TEXT } from "./documents.ts";
import { LEGAL, type Legal } from "./legal.ts";

/** One of the two documents, read by anyone, signed in or not. The page asks Keel nothing. */
export function LegalPage({ which }: { which: Legal }) {
  const { title } = LEGAL[which];
  useEffect(() => {
    document.title = `${title} · Keel`;
  }, [title]);
  return (
    <div className="a-root flex min-h-screen w-screen flex-col bg-kumo-canvas text-base text-kumo-default">
      <SkipLink />
      <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
        <div className="flex h-12 items-center px-6">
          <HomeLink named />
        </div>
      </header>
      <main id={MAIN} tabIndex={-1} className="flex-1 outline-none">
        <article className="mx-auto w-full max-w-[820px] px-6 py-10" data-legal={which}>
          <Markdown source={TEXT[which]} />
        </article>
      </main>
      <Footer />
    </div>
  );
}
