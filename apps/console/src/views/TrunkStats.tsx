// Trunk's own numbers: whether it has ever been red, how often it advances,
// how fast changes land, and how rarely a person is asked. One line of them
// rides above the live graph; Insights has each with what it means.

import { usePublicOnly } from "../engine/react.tsx";
import { CheckCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { TrunkStats } from "../engine/select.ts";
import { Unverified } from "./parts.tsx";

const count = (value: number): string => value.toLocaleString("en-US");

interface Stat {
  label: string;
  value: ReactNode;
  means: string;
}

/** `hidden` is whether this reader is not shown the questions put to a person, which are then not counted. */
function statsOf(trunk: TrunkStats, hidden: boolean): Stat[] {
  return [
    {
      label: "Trunk red",
      value: (
        <span className="inline-flex items-center gap-1.5">
          {count(trunk.redCount)}
          {trunk.redCount === 0 && (
            <CheckCircleIcon
              size={15}
              weight="fill"
              style={{ color: "var(--a-pass)" }}
              aria-label="Trunk is green"
            />
          )}
        </span>
      ),
      means: "Audits of trunk's head that came back red. Keel's claim is that this stays at zero.",
    },
    {
      label: "Advances",
      value: (
        <>
          {count(trunk.advances)}
          {trunk.unverifiedAdvances > 0 && (
            <Unverified>{`${count(trunk.unverifiedAdvances)} unverified`}</Unverified>
          )}
        </>
      ),
      means: "Times trunk's head has moved. One advance can land several changes.",
    },
    {
      label: "Landed per minute",
      value: count(trunk.landedPerMinute),
      means: "Changes that landed in the last minute.",
    },
    {
      label: "p50 time-to-land",
      value:
        trunk.p50TimeToLandMs === undefined ? (
          <span className="font-normal text-kumo-subtle">not yet</span>
        ) : (
          `${Math.round(trunk.p50TimeToLandMs / 1000)} s`
        ),
      means:
        "Half of the changes that landed took this long or less, from the intent being declared.",
    },
    {
      label: "People asked / changes landed",
      value: (
        <>
          {hidden ? "—" : count(trunk.humansAsked)}
          <span className="mx-1 font-normal text-kumo-subtle">/</span>
          {count(trunk.changesLanded)}
        </>
      ),
      means: hidden
        ? "Questions put to a person, against changes landed. Keel shows a project's questions to its members, so they are not counted here."
        : "Questions put to a person, against changes landed.",
    },
    ...(trunk.head === undefined
      ? []
      : [
          {
            label: "Head",
            value: <span className="a-mono font-medium">{trunk.head}</span>,
            means: "The commit trunk is at.",
          },
        ]),
  ];
}

/** One line, above the live graph. */
export function TrunkLine({ trunk }: { trunk: TrunkStats }) {
  const hidden = usePublicOnly();
  return (
    <dl className="a-trunk-line" aria-label="Trunk">
      {statsOf(trunk, hidden).map((stat) => (
        <div key={stat.label}>
          <dt>{stat.label}</dt>
          <dd className="a-num">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Each number with what it means. */
export function TrunkTable({ trunk }: { trunk: TrunkStats }) {
  const hidden = usePublicOnly();
  return (
    <table className="a-stats">
      <caption className="sr-only">Trunk</caption>
      <tbody>
        {statsOf(trunk, hidden).map((stat) => (
          <tr key={stat.label}>
            <th scope="row">{stat.label}</th>
            <td className="a-num">{stat.value}</td>
            <td>{stat.means}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
