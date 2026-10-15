// How Settings and an org's People list things, as a code host's settings do: a bordered box with a header and
// its count, one row per thing (its avatar, its name, what it is, and its actions on the right), and the
// Danger zone's red box at the foot of a page.

import { Button, Dialog, DropdownMenu } from "@cloudflare/kumo";
import { DotsThreeIcon, RobotIcon } from "@phosphor-icons/react";
import type { FormEvent, ReactNode } from "react";
import { Refusal, type Said } from "./parts.tsx";

/** Keel's code, on `/v1`, for a move that wants a passkey sign-in from the last ten minutes. */
const FRESH_SIGN_IN = "auth.fresh_sign_in_required";

/** A bordered list under its header: the title, a count where there is one, and the header's own actions. */
export function Box({
  title,
  count,
  actions,
  children,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-base"
    >
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline bg-kumo-tint px-4 py-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-kumo-strong">
          {title}
          {count !== undefined && (
            <span className="a-num rounded-full bg-kumo-fill px-2 text-xs leading-5 font-medium text-kumo-default">
              {count.toLocaleString("en-US")}
            </span>
          )}
        </h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Rows({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="divide-y divide-kumo-hairline">
      {children}
    </ul>
  );
}

/** One row: its avatar, its name with its badges, a quiet line under it, what it is on the right, and its menu. */
export function Row({
  avatar,
  title,
  badges,
  meta,
  side,
  menu,
  label,
}: {
  avatar?: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode;
  side?: ReactNode;
  menu?: ReactNode;
  /** The row's accessible name, where its title alone does not say which it is. */
  label?: string;
}) {
  return (
    <li aria-label={label} className="flex items-center gap-3 px-4 py-3">
      {avatar}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {title}
          {badges}
        </div>
        {meta !== undefined && (
          <div className="text-sm text-kumo-subtle [overflow-wrap:anywhere]">{meta}</div>
        )}
      </div>
      {side !== undefined && (
        <div className="flex shrink-0 items-center gap-3 text-sm text-kumo-default">{side}</div>
      )}
      {menu !== undefined && <div className="flex w-8 shrink-0 justify-end">{menu}</div>}
    </li>
  );
}

/** A row's picture: a person's initial in a circle, an agent's mark in a rounded square. */
export function Avatar({ name, agent = false }: { name: string; agent?: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex size-8 shrink-0 items-center justify-center bg-kumo-fill text-sm font-semibold text-kumo-default ${agent ? "rounded-md" : "rounded-full"}`}
    >
      {agent ? <RobotIcon size={18} /> : (name.at(0) ?? "?").toUpperCase()}
    </span>
  );
}

/** A small label beside a name: Agent, You, Pending. */
export function Tag({ children, tone }: { children: ReactNode; tone?: "quiet" | "person" }) {
  return (
    <span className="a-chip" data-tone={tone ?? "quiet"}>
      {children}
    </span>
  );
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  select: () => void;
}

/** The row's actions behind its ⋯ button. Nothing is drawn where the reader is offered none. */
export function RowMenu({
  label,
  items,
  disabled = false,
}: {
  label: string;
  items: readonly MenuItem[];
  disabled?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        disabled={disabled}
        render={
          <button
            type="button"
            aria-label={label}
            className="flex size-8 items-center justify-center rounded-md text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-strong disabled:opacity-50"
          >
            <DotsThreeIcon size={18} weight="bold" aria-hidden />
          </button>
        }
      />
      <DropdownMenu.Content>
        {items.map((item) => (
          <DropdownMenu.Item
            key={item.label}
            variant={item.danger === true ? "danger" : "default"}
            onClick={item.select}
          >
            {item.label}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** A setting as a row: its name, its value or a line under the name, and its control on the right. */
export function Setting({
  name,
  value,
  children,
}: {
  name: string;
  value?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="text-sm font-semibold text-kumo-strong">{name}</span>
        {value !== undefined && (
          <span className="text-sm text-kumo-default [overflow-wrap:anywhere]">{value}</span>
        )}
      </div>
      {children}
    </li>
  );
}

/** The foot of a settings page: what cannot be taken back, in GitHub's red box. */
export function DangerZone({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Danger zone" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold text-kumo-strong">Danger zone</h2>
      <ul className="divide-y divide-kumo-hairline overflow-hidden rounded-lg border border-kumo-danger bg-kumo-base">
        {children}
      </ul>
    </section>
  );
}

/** A dialog with a title and a form: the reader's one task, its fields, and Cancel beside the action. */
export function FormDialog({
  open,
  close,
  title,
  action,
  busy,
  ready,
  submit,
  children,
}: {
  open: boolean;
  close: () => void;
  title: string;
  action: string;
  busy: boolean;
  ready: boolean;
  submit: (event: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(opened) => {
        if (!opened) close();
      }}
    >
      <Dialog size="lg" className="flex flex-col gap-4 p-6">
        <Dialog.Title className="text-lg font-semibold text-kumo-strong">{title}</Dialog.Title>
        <form className="flex flex-col gap-4" onSubmit={submit} aria-label={title}>
          {children}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !ready}>
              {action}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

/** Keel's refusal, and the passkey touch where Keel asked for a fresher sign-in. */
export function Refused({
  said,
  busy,
  again,
}: {
  said: Said | null;
  busy: boolean;
  again: () => void;
}) {
  return (
    <>
      <Refusal said={said} />
      {said?.code === FRESH_SIGN_IN && (
        <div>
          <Button type="button" variant="secondary" disabled={busy} onClick={again}>
            Confirm with passkey
          </Button>
        </div>
      )}
    </>
  );
}
