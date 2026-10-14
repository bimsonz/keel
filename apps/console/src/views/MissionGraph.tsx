// Mission Control's graph: what exists in Keel right now and how it relates,
// one lane to a subject, one column to each kind of thing. A node arrives when
// the thing it stands for comes into being, changes as events arrive, and
// leaves when the work is done. Nothing is drawn that is not in the event log.
//
// The page scrolls and the graph does not move under it: there is no panning
// and no zooming, and the size it is drawn at depends on the window's width
// alone. So nothing jumps when a node arrives, the column headings stay where
// they are, and a lane further down is reached by scrolling to it.

import {
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "@xyflow/react/dist/style.css";
import {
  CaretDownIcon,
  CaretRightIcon,
  HandPalmIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeState } from "../domain/state.ts";
import {
  type Band,
  COLUMNS,
  COLUMN_X,
  HEIGHT,
  NODE_W,
  WORLD_W,
  arrange,
  zoomFor,
} from "../engine/arrange.ts";
import { type GraphNode, type Lane, type Lanes, NO_SUBJECT, type Tone } from "../engine/lanes.ts";
import type { Mode } from "../theme/mode.ts";
import { ChangeLink, ConflictLink, EscalationLink, SubjectLink } from "./links.tsx";
import { AgentMark, CLASS_WORD, RunMark } from "./parts.tsx";

type ThingNode = Node<{ node: GraphNode; selected: boolean }, "thing">;
type BandNode = Node<
  { band: Band; lane: Lane; onToggle: (key: string, open: boolean) => void },
  "band"
>;

const STROKE: Record<Tone, string> = {
  plain: "var(--color-kumo-interact)",
  suspected: "var(--a-suspected)",
  proven: "var(--a-fail)",
  person: "var(--a-person)",
  pass: "var(--a-pass)",
};

const CHANGE_TONE: Partial<Record<ChangeState, string>> = {
  parked: "person",
  landed: "guarded",
  bounced: "proven",
};

const WORLD_NAME = { trunk: "trunk", "A-noop": "A-noop", A: "A", B: "B", AB: "A+B" } as const;

const count = (value: number): string => value.toLocaleString("en-US");
const plural = (value: number, one: string, many = `${one}s`): string =>
  `${count(value)} ${value === 1 ? one : many}`;

function Kind({ children }: { children: string }) {
  return <span className="a-fn-kind">{children}</span>;
}

function Body({ node }: { node: GraphNode }) {
  switch (node.kind) {
    case "agent":
      return (
        <div className="flex items-center gap-2">
          <AgentMark agentClass={node.agentClass} size={16} />
          <div className="min-w-0">
            <div className="truncate font-semibold text-kumo-strong">{node.label}</div>
            <div className="truncate text-[13px] text-kumo-subtle">
              {[
                CLASS_WORD[node.agentClass],
                node.harness,
                node.run === undefined ? "" : `run “${node.run}”`,
              ]
                .filter((part) => part !== "")
                .join(" · ")}
            </div>
          </div>
        </div>
      );
    case "change": {
      const about = [
        node.holds === undefined
          ? ""
          : `${node.holds.text}${node.holds.derived ? " · derived" : ""}`,
        node.revision > 1 ? `revision ${node.revision}` : "",
        node.where ?? "",
      ]
        .filter((part) => part !== "")
        .join(" · ");
      return (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Kind>Change</Kind>
              <b className="font-semibold text-kumo-strong">{node.label}</b>
            </span>
            <span className="a-chip" data-tone={CHANGE_TONE[node.state] ?? "quiet"}>
              {node.state === "parked" && <HandPalmIcon size={12} weight="fill" />}
              {node.state}
            </span>
          </div>
          <div className="a-fn-clamp text-kumo-default" title={node.goal}>
            {node.goal}
          </div>
          <div className="mt-auto truncate text-[13px] text-kumo-subtle" title={about}>
            {about === "" ? "nothing said about a subject yet" : about}
            {node.unverified === true && (
              <span style={{ color: "var(--a-suspected-ink)" }}> · unverified</span>
            )}
          </div>
        </>
      );
    }
    // A change that stands in another lane: what ties it to this subject, and where it stands.
    case "reference": {
      const holds =
        node.holds === undefined
          ? ""
          : `${node.holds.text}${node.holds.derived ? " · derived" : ""}`;
      const home = node.home === NO_SUBJECT ? "changes on no subject yet" : node.home;
      return (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Kind>Change</Kind>
              <b className="font-semibold text-kumo-strong">{node.label}</b>
            </span>
            <span className="a-chip" data-tone={CHANGE_TONE[node.state] ?? "quiet"}>
              {node.state}
            </span>
          </div>
          <div className="truncate text-kumo-default" title={holds}>
            {holds}
          </div>
          <div className="mt-auto truncate text-[13px] text-kumo-subtle" title={home}>
            in the lane of <span className="a-mono">{home}</span>
          </div>
        </>
      );
    }
    case "stack":
      return (
        <>
          <Kind>Changes</Kind>
          <div className="text-lg font-semibold leading-tight text-kumo-strong">
            <span className="a-num">{count(node.count)}</span>{" "}
            {node.beside > 0 ? "more" : node.count === 1 ? "change" : "changes"}
          </div>
          <div className="truncate text-[13px] text-kumo-subtle">
            {node.byState
              .slice(0, 3)
              .map(([state, each]) => `${each} ${state}`)
              .join(" · ")}
          </div>
        </>
      );
    case "subject":
      return (
        <>
          <Kind>Subject</Kind>
          <div className="a-mono truncate font-semibold text-kumo-strong" title={node.key}>
            {node.key}
          </div>
          {node.gloss !== "" && (
            <div className="truncate text-[13px] text-kumo-default">{node.gloss}</div>
          )}
          <div
            data-counts
            className="mt-auto flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] text-kumo-subtle"
          >
            <span>
              <span className="a-num">{node.premises}</span>{" "}
              {node.premises === 1 ? "premise" : "premises"}
            </span>
            {node.guards > 0 && (
              <span
                className="inline-flex items-center gap-1"
                style={{ color: "var(--a-pass-ink)" }}
              >
                <ShieldCheckIcon size={13} weight="fill" />
                <span className="a-num">{node.guards}</span>{" "}
                {node.guards === 1 ? "guard" : "guards"}
              </span>
            )}
            {node.decisions > 0 && (
              <span>
                <span className="a-num">{node.decisions}</span>{" "}
                {node.decisions === 1 ? "decision" : "decisions"}
              </span>
            )}
          </div>
        </>
      );
    case "conflict":
      return (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Kind>Conflict</Kind>
              <b className="font-semibold text-kumo-strong">{node.label}</b>
            </span>
            <span
              className="a-chip"
              data-tone={
                node.state === "proven" || node.state === "escalated"
                  ? "proven"
                  : node.state === "suspected" || node.state === "probing"
                    ? "suspected"
                    : "quiet"
              }
            >
              {node.state === "escalated" ? "proven" : node.state}
            </span>
          </div>
          <div className="a-fn-clamp text-kumo-default" title={node.summary}>
            {node.summary}
          </div>
          <div className="mt-auto text-[13px] text-kumo-subtle">
            {node.conflictKind}
            {node.costUsd !== undefined && ` · $${node.costUsd.toFixed(3)} to settle`}
          </div>
        </>
      );
    case "probe":
      return (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Kind>Probe</Kind>
              <b className="font-semibold text-kumo-strong">{node.label}</b>
            </span>
            <span className="text-[13px] text-kumo-subtle">
              {node.state === "admitted" ? "now a guard" : node.state}
            </span>
          </div>
          <dl className="mt-0.5 grid grid-cols-[52px_1fr] items-center gap-x-2 gap-y-1">
            {node.runs.map(([world, runs]) => (
              <div key={world} className="contents">
                <dt className="text-[13px] text-kumo-default">{WORLD_NAME[world]}</dt>
                <dd className="flex gap-1">
                  {runs.map((outcome, index) => (
                    // oxlint-disable-next-line react/no-array-index-key -- a run is known by its position: first, second, third
                    <RunMark
                      key={index}
                      outcome={outcome}
                      run={index + 1}
                      size={20}
                      control={world === "A-noop"}
                    />
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </>
      );
    case "escalation":
      return (
        <>
          <div
            className="flex items-center gap-1.5 text-[13px] font-medium"
            style={{ color: node.state === "open" ? "var(--a-person-ink)" : undefined }}
          >
            {node.state === "open" && <HandPalmIcon size={14} weight="fill" />}
            <b className="font-semibold">{node.label}</b>
            {node.state === "open"
              ? "A person is being asked"
              : node.state === "ruled"
                ? "A person ruled"
                : "Withdrawn"}
          </div>
          <div className="a-fn-clamp font-semibold text-kumo-strong" title={node.question}>
            {node.question}
          </div>
          <div
            className="a-fn-clamp mt-auto text-[13px] text-kumo-subtle"
            title={node.decision?.chosen}
          >
            {node.state === "open" ? (
              `Until answered: ${node.standing}.`
            ) : node.decision === undefined ? (
              "Answered"
            ) : (
              <>
                Decision <b className="font-semibold text-kumo-default">{node.decision.label}</b>:{" "}
                {node.decision.chosen}
              </>
            )}
          </div>
        </>
      );
    case "decision":
      return (
        <>
          <span className="flex items-center gap-1.5">
            <Kind>Decision</Kind>
            <b className="font-semibold text-kumo-strong">{node.label}</b>
          </span>
          <div className="a-fn-clamp text-kumo-default" title={node.chosen}>
            {node.chosen}
          </div>
        </>
      );
    case "guard":
      return (
        <div className="flex items-center gap-2">
          <ShieldCheckIcon
            size={18}
            weight="fill"
            style={{ color: node.state === "admitted" ? "var(--a-pass)" : "var(--a-mark-quiet)" }}
          />
          <div>
            <div className="font-semibold text-kumo-strong">Guard {node.label}</div>
            <div className="text-[13px] text-kumo-subtle">
              {node.state === "admitted" ? "guards trunk" : "retired by a decision"}
            </div>
          </div>
        </div>
      );
    default:
      return null;
  }
}

function toneOf(node: GraphNode): string {
  if (node.kind === "subject") return node.tone;
  if (node.kind === "escalation") return node.state === "open" ? "person" : "plain";
  if (node.kind === "change" && node.state === "parked") return "person";
  if (node.kind === "conflict")
    return node.state === "proven" || node.state === "escalated"
      ? "proven"
      : node.state === "suspected" || node.state === "probing"
        ? "suspected"
        : "plain";
  return "plain";
}

/** A node that stands for something with a page of its own is a link to it. */
function Thing({ data }: NodeProps<ThingNode>) {
  const { node } = data;
  const drawn = {
    className: "a-fn",
    "data-kind": node.kind,
    "data-tone": toneOf(node),
    "data-selected": data.selected,
    style: { height: HEIGHT[node.kind] },
  };
  const body = (
    <>
      <Handle type="target" position={Position.Left} />
      <Body node={node} />
      <Handle type="source" position={Position.Right} />
    </>
  );
  switch (node.kind) {
    case "subject":
      return (
        <SubjectLink subject={node.key} {...drawn} data-open>
          {body}
        </SubjectLink>
      );
    // The changes not drawn one by one are listed with their subject.
    case "stack":
      return (
        <SubjectLink subject={node.subjectKey} {...drawn} data-open>
          {body}
        </SubjectLink>
      );
    case "change":
    case "reference":
      return (
        <ChangeLink id={node.changeId} {...drawn} data-open>
          {body}
        </ChangeLink>
      );
    case "conflict":
      return (
        <ConflictLink id={node.conflictId} {...drawn} data-open>
          {body}
        </ConflictLink>
      );
    case "probe":
      return (
        <ConflictLink id={node.conflictId} tab="probe" {...drawn} data-open>
          {body}
        </ConflictLink>
      );
    case "escalation":
      return (
        <EscalationLink id={node.escalationId} {...drawn} data-open>
          {body}
        </EscalationLink>
      );
    default:
      return (
        <div {...drawn} data-open={false}>
          {body}
        </div>
      );
  }
}

const LANE_TONE_WORD: Record<Tone, string> = {
  person: "a person is being asked",
  proven: "a conflict is proven",
  suspected: "contested",
  pass: "guarded",
  plain: "",
};

/** What a lane is called where it is opened and closed: its subject, or that its changes have none. */
const laneName = (lane: Lane): string =>
  lane.subject === undefined ? "changes on no subject yet" : lane.key;

/**
 * A lane's own band. Open, it is the rule above the lane and the control that closes it. Closed, it is the
 * whole lane in one line: the subject, how much is going on there, and the control that opens it.
 */
function LaneBand({ data }: NodeProps<BandNode>) {
  const { band, lane, onToggle } = data;
  if (band.open) {
    return (
      <div className="a-lane" data-open data-lane={lane.key} style={{ height: band.height }}>
        <button
          type="button"
          className="a-lane-toggle"
          aria-expanded
          aria-label={`Close the lane of ${laneName(lane)}`}
          onClick={() => onToggle(lane.key, false)}
        >
          <CaretDownIcon size={15} />
        </button>
      </div>
    );
  }
  const standing = lane.subject === undefined ? "" : LANE_TONE_WORD[lane.subject.tone];
  // What the row says is what is read out: the subject, how much is going on there, and that it opens.
  return (
    <button
      type="button"
      className="a-lane"
      data-open={false}
      data-lane={lane.key}
      aria-expanded={false}
      title={`Open the lane of ${laneName(lane)}`}
      style={{ height: band.height }}
      onClick={() => onToggle(lane.key, true)}
    >
      <span className="a-lane-toggle">
        <CaretRightIcon size={15} />
      </span>
      <span className="a-mono w-[300px] shrink-0 truncate text-left font-semibold text-kumo-strong">
        {lane.subject === undefined ? "No subject yet" : lane.key}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-kumo-subtle">
        {lane.subject === undefined
          ? "Changes that have said nothing about a subject"
          : lane.subject.gloss}
      </span>
      <span className="shrink-0 text-kumo-default">
        {plural(lane.changes, "change")}
        {lane.byState.length > 0 && (
          <span className="text-kumo-subtle">
            {" "}
            ·{" "}
            {lane.byState
              .slice(0, 3)
              .map(([state, each]) => `${each} ${state}`)
              .join(" · ")}
          </span>
        )}
        {lane.references > 0 && (
          <span className="text-kumo-subtle">
            {" "}
            · {count(lane.references)} from {lane.references === 1 ? "another lane" : "other lanes"}
          </span>
        )}
      </span>
      <span
        className="w-[190px] shrink-0 text-right"
        style={{ color: lane.conflicts > 0 ? "var(--a-suspected-ink)" : undefined }}
      >
        {lane.conflicts > 0
          ? `${plural(lane.conflicts, "conflict")} open`
          : standing === ""
            ? "nothing contested"
            : standing}
      </span>
    </button>
  );
}

const NODE_TYPES = { thing: Thing, band: LaneBand };

export function MissionGraph({
  lanes,
  mode,
  selected,
  onToggle,
  onMore,
}: {
  lanes: Lanes;
  mode: Mode;
  /** The key of the subject that is open beside the graph, if one is. */
  selected?: string;
  onToggle: (key: string, open: boolean) => void;
  /** Asks for the lanes not shown. */
  onMore: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ zoom: 1, width: WORLD_W });
  // The size depends on the room there is, and on nothing that happens in the graph.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return undefined;
    const measure = (): void => {
      const width = element.clientWidth;
      setRoom((before) => (before.width === width ? before : { zoom: zoomFor(width), width }));
    };
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(element);
    return () => watching.disconnect();
  }, []);
  const { zoom } = room;
  // A lane's rule runs the width of the window, however much of it the columns take.
  const span = Math.max(WORLD_W, room.width / zoom);

  const { nodes, edges, height } = useMemo(() => {
    const { placed, bands, height: tall } = arrange(lanes.lanes);
    const byKey = new Map(lanes.lanes.map((lane) => [lane.key, lane]));
    const bandNodes = bands.flatMap((band): BandNode[] => {
      const lane = byKey.get(band.key);
      if (lane === undefined) return [];
      return [
        {
          id: `band:${band.key}`,
          type: "band",
          position: { x: 0, y: band.top },
          data: { band, lane, onToggle },
          width: span,
          height: band.height,
          zIndex: -1,
          selectable: false,
          focusable: false,
        },
      ];
    });
    const things = placed.map((item): ThingNode => ({
      id: item.node.id,
      type: "thing",
      position: { x: item.x, y: item.y },
      data: {
        node: item.node,
        selected: item.node.kind === "subject" && item.node.key === selected,
      },
      width: item.width,
      height: item.height,
    }));
    const links = lanes.lanes.flatMap((lane) =>
      lane.edges.map((edge): Edge => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
        style: {
          stroke: STROKE[edge.tone],
          strokeWidth: edge.tone === "plain" ? 1.5 : 2,
          ...(edge.derived === true ? { strokeDasharray: "5 4" } : {}),
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: STROKE[edge.tone],
        },
      })),
    );
    return { nodes: [...bandNodes, ...things], edges: links, height: tall };
  }, [lanes, selected, onToggle, span]);

  // The subject a reader opened is brought into view, once, when they open it. On a page opened at its address
  // the node is drawn a few frames after the page is, so it is looked for until it is there.
  useEffect(() => {
    if (selected === undefined) return undefined;
    let frame = 0;
    let looked = 0;
    const bring = (): void => {
      const node = scroller.current?.querySelector('.a-fn[data-selected="true"]');
      if (node !== null && node !== undefined) {
        node.scrollIntoView({ block: "center", inline: "nearest" });
        return;
      }
      looked += 1;
      if (looked < 120) frame = requestAnimationFrame(bring);
    };
    frame = requestAnimationFrame(bring);
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  // The scroller is there from the first, so the room it has is measured before there is anything to draw in it.
  if (lanes.lanes.length === 0) {
    return (
      <div ref={scroller} className="a-mission a-scroll" data-zoom={zoom}>
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <h2 className="text-xl font-semibold text-kumo-strong">Nothing is being worked on yet</h2>
          <p className="max-w-[56ch] text-base text-kumo-subtle">
            When an agent declares an intent, its change appears here, in the lane of the subject it
            relies on. Conflicts, probes, escalations and guards appear as they happen.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div ref={scroller} className="a-mission a-scroll" data-zoom={zoom}>
      <div className="a-mission-head" style={{ width: span * zoom }} aria-hidden>
        {COLUMNS.map((name, index) => (
          <span key={name} style={{ left: (COLUMN_X[index] ?? 0) * zoom, width: NODE_W * zoom }}>
            {name}
          </span>
        ))}
      </div>
      <div
        className="a-mission-graph"
        style={{ width: span * zoom, height: Math.max(height * zoom, 1) }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          colorMode={mode}
          viewport={{ x: 0, y: 0, zoom }}
          minZoom={zoom}
          maxZoom={zoom}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
        />
      </div>
      <div className="a-mission-foot" style={{ width: span * zoom }}>
        {lanes.more.lanes > 0 && (
          <button type="button" className="a-link" onClick={onMore}>
            Show {plural(lanes.more.lanes, "more subject")}
            <span className="text-kumo-subtle">
              {" "}
              · {plural(lanes.more.changes, "change")}
              {lanes.more.conflicts > 0 && `, ${plural(lanes.more.conflicts, "conflict")} open`}
            </span>
          </button>
        )}
        <p className="a-mission-key">
          <span>
            <i data-line="solid" /> declared by an agent
          </span>
          <span>
            <i data-line="dashed" /> derived by Keel from the diff
          </span>
          <span>A subject, a change, a conflict and an escalation each open their own page.</span>
        </p>
      </div>
    </div>
  );
}
