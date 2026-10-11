// One conflict.

import { conflictNamed } from "../engine/lists.ts";
import { useSelected } from "../engine/react.tsx";
import { conflictPageOf } from "../engine/select.ts";
import type { ConflictTab } from "../route.ts";
import type { Mode } from "../theme/mode.ts";
import { Notice } from "../views/Frame.tsx";
import { Conflict } from "../views/Conflict.tsx";

export function ConflictPage({ name, tab, mode }: { name: string; tab: ConflictTab; mode: Mode }) {
  const id = useSelected((world) => conflictNamed(world, name)?.id, [name]);
  const state = useSelected(
    (world, resources) => (id === undefined ? null : conflictPageOf(world, id, resources)),
    [id],
  );
  if (id === undefined) {
    return (
      <Notice title={`There is no conflict ${name} in what Keel has said so far`}>
        A conflict opens when two changes hold incompatible propositions about one subject.
      </Notice>
    );
  }
  // A conflict is drawn as two changes on one subject. Until Keel has named both sides there is nothing to set against what.
  if (state === null)
    return (
      <Notice title={`Conflict ${name} is not drawn yet`}>
        Keel has opened it, and has not yet said which two changes disagree, or about which subject.
      </Notice>
    );
  return <Conflict state={state} mode={mode} tab={tab} />;
}
