// The top right of every page's header, as a code host has it: for someone signed in, their avatar and a menu
// of their own places and the way out; for a visitor, a Sign in button that comes back to the page they were on.

import { DropdownMenu, buttonVariants } from "@cloudflare/kumo";
import { CaretDownIcon, GearIcon, SignOutIcon, UserIcon, BooksIcon } from "@phosphor-icons/react";
import { createAccount } from "../account/account.ts";
import { hrefOf } from "../places.ts";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "./frame.css";

/** Who is reading: a visitor, or someone signed in, by the name the pages call them and their handle once chosen. */
export type MenuReader = { is: "visitor" } | { is: "user"; name: string; handle?: string };

/** Signs out, and goes home: what this browser may read has changed. */
async function signOut(): Promise<void> {
  await createAccount({ origin: window.location.origin })
    .signOut()
    .catch(() => undefined);
  window.location.assign("/");
}

export function ReaderMenu({ reader }: { reader: MenuReader }) {
  if (reader.is === "visitor")
    return (
      <a
        href={hrefOf({ at: "login" }, `${window.location.pathname}${window.location.search}`)}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        Sign in
      </a>
    );
  const initial = (reader.handle ?? reader.name).slice(0, 1).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            aria-label={`Account menu, signed in as ${reader.handle ?? reader.name}`}
            className="flex items-center gap-1 rounded-full text-kumo-subtle hover:text-kumo-strong"
          >
            <span className="a-avatar" aria-hidden>
              {initial}
            </span>
            <CaretDownIcon size={12} aria-hidden />
          </button>
        }
      />
      <DropdownMenu.Content align="end">
        {/* A plain line, not a menu part: Base UI takes a menu's label only inside one of its groups. */}
        <p className="px-2 py-1.5 text-sm text-kumo-subtle">
          Signed in as{" "}
          <b className="font-semibold text-kumo-strong">{reader.handle ?? reader.name}</b>
        </p>
        <DropdownMenu.Separator />
        {reader.handle !== undefined && (
          <>
            <DropdownMenu.LinkItem
              href={hrefOf({ at: "namespace", handle: reader.handle })}
              icon={UserIcon}
            >
              Your profile
            </DropdownMenu.LinkItem>
            <DropdownMenu.LinkItem
              href={hrefOf({ at: "namespace", handle: reader.handle, tab: "projects" })}
              icon={BooksIcon}
            >
              Your projects
            </DropdownMenu.LinkItem>
          </>
        )}
        <DropdownMenu.LinkItem href={hrefOf({ at: "settings" })} icon={GearIcon}>
          Settings
        </DropdownMenu.LinkItem>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={SignOutIcon} onClick={() => void signOut()}>
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
