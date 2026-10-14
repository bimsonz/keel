/**
 * Keel's mark, at the far left of every page's header: the way home, as a code host's logo is. Where the header
 * goes on to name a namespace or a project, the mark stands alone and the names lead; on a page above them it
 * carries Keel's name.
 */
export function HomeLink({ named }: { named: boolean }) {
  return (
    <a
      href="/"
      aria-label={named ? undefined : "Keel"}
      className="flex shrink-0 items-center gap-2.5 text-base text-kumo-default hover:underline"
    >
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
        <path d="M2.5 5h15L10 17.5Z" fill="var(--text-color-kumo-strong)" />
      </svg>
      {named && <span>Keel</span>}
    </a>
  );
}
