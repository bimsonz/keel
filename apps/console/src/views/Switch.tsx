// Beside a name in the frame, the others of its kind: the frame is a code host's, `Keel / <namespace> / <project>`,
// where each name is a link and has a dropdown beside it.

import { DropdownMenu } from "@cloudflare/kumo";
import { CaretUpDownIcon } from "@phosphor-icons/react";

/** Something the reader could be in instead of where they are: another project of this namespace, or another account. */
export interface Sibling {
  name: string;
  href: string;
  /** What is said beside its name: for a project, who may read it. */
  note?: string;
}

/**
 * Beside a name in the frame, the others of its kind, a click away: as a code host's frame lets a reader drop
 * down on the owner or on the repository and go to another.
 */
export function Switch({
  what,
  here,
  others,
  all,
}: {
  what: string;
  here: string;
  others: Sibling[];
  all: { label: string; href: string };
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            aria-label={`Switch ${what}`}
            className="flex h-6 w-5 items-center justify-center rounded text-kumo-subtle hover:text-kumo-strong"
          >
            <CaretUpDownIcon size={14} aria-hidden />
          </button>
        }
      />
      <DropdownMenu.Content>
        {others.map((other) => (
          <DropdownMenu.LinkItem
            key={other.name}
            href={other.href}
            aria-current={other.name === here ? "true" : undefined}
          >
            <span className={other.name === here ? "font-semibold text-kumo-strong" : undefined}>
              {other.name}
            </span>
            {other.note !== undefined && (
              <span className="ml-3 text-sm text-kumo-subtle">{other.note}</span>
            )}
          </DropdownMenu.LinkItem>
        ))}
        <DropdownMenu.LinkItem href={all.href}>{all.label}</DropdownMenu.LinkItem>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
