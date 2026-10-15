// Where a project is cloned from, as GitHub's Code button gives it: the HTTPS address and one press to copy it.
// Keel serves a project's trunk to stock git at `<origin>/<namespace>/<project>.git`, read-only: a change lands
// through Keel, never by a push. A private project's address needs `keeltown` as git's credential helper.

import { Button, Popover } from "@cloudflare/kumo";
import { CaretDownIcon, CheckIcon, CodeIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { Visibility } from "../engine/projects.ts";
import { cloneAddress } from "../places.ts";
import { useWhere } from "../router.tsx";

/** The address in a field to select, and a button that copies it. */
export function CloneField({ visibility }: { visibility?: Visibility | undefined }) {
  const { namespace, project } = useWhere();
  const url = cloneAddress(window.location.origin, namespace, project);
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-stretch gap-1.5">
        <input
          readOnly
          value={url}
          aria-label="Clone address"
          onFocus={(event) => event.currentTarget.select()}
          className="a-mono min-w-0 flex-1 rounded-md border border-kumo-line bg-kumo-recessed px-2 py-1 text-sm text-kumo-strong"
        />
        <Button
          variant="secondary"
          size="sm"
          aria-label={copied ? "Copied" : "Copy the clone address"}
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon size={15} aria-hidden /> : <CopyIcon size={15} aria-hidden />}
        </Button>
      </div>
      <p className="text-xs text-kumo-subtle">Read-only · changes land through Keel</p>
      {visibility === "private" && (
        <code className="a-mono text-xs text-kumo-default">
          keeltown login, then keeltown auth setup-git
        </code>
      )}
    </div>
  );
}

/** GitHub's Code button: the clone address behind it. */
export function CloneMenu({ visibility }: { visibility?: Visibility | undefined }) {
  return (
    <Popover>
      <Popover.Trigger
        render={
          <Button variant="primary" size="sm">
            <CodeIcon size={15} aria-hidden />
            Code
            <CaretDownIcon size={12} aria-hidden />
          </Button>
        }
      />
      <Popover.Content
        side="bottom"
        align="end"
        className="flex w-[min(380px,90vw)] flex-col gap-2 p-3"
      >
        <Popover.Title className="text-sm font-semibold text-kumo-strong">Clone</Popover.Title>
        <CloneField visibility={visibility} />
      </Popover.Content>
    </Popover>
  );
}
