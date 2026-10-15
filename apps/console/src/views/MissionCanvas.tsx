// Mission Control's canvas: the project as an architecture diagram that grows
// outward as Keel works on it. The project in the centre; a fork off it for each
// change, with its agents beside it; forks joining into a batch further out; the
// batch's checks; a deploy; a landing back into the project, after which the
// branch dissolves. Every edge points the way work goes, and is animated while
// work is moving along it.
//
// It pans and zooms. Until the reader moves it, the view keeps the whole diagram
// in frame as it grows; once they have, it stays where they put it.

import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type EdgeProps,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  getBezierPath,
  type Node,
  type NodeProps,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "@xyflow/react/dist/style.css";
import {
  ArrowsInIcon,
  ArrowsOutIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  CubeIcon,
  GitForkIcon,
  HourglassIcon,
  MinusCircleIcon,
  RobotIcon,
  RocketLaunchIcon,
  StackIcon,
  StopCircleIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { Badge } from "@cloudflare/kumo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Canvas } from "../engine/canvas.ts";
import type {
  AgentNode,
  BatchNode,
  CheckNode,
  DeployNode,
  ForkNode,
  Growth,
  GrowthEdgeKind,
  GrowthNode,
  PileNode,
  ProjectNode,
} from "../engine/growth.ts";
import type { Mode } from "../theme/mode.ts";
import { navigate } from "../router.tsx";
import { ChangeLink, useChangeAddress } from "./links.tsx";

const count = (value: number): string => value.toLocaleString("en-US");

/** `m:ss`, or `h:mm:ss` past the hour. */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const STAGE_WORD: Record<ForkNode["stage"], string> = {
  declared: "Declared",
  precheck: "Precheck",
  queue: "Queued",
  batch: "Batched",
  bounced: "Bounced",
  landed: "Landed",
  gone: "Withdrawn",
};

const PILE_WORD: Record<PileNode["stage"], string> = {
  declared: "Declared",
  precheck: "Precheck",
  queue: "Queued",
  bounced: "Bounced",
};

const BATCH_WORD: Record<BatchNode["state"], string> = {
  forming: "Forming",
  assembled: "Assembled",
  verifying: "Testing",
  green: "Passed",
  promoting: "Landing",
  red: "Failed",
  cancelled: "Cancelled",
  bisected: "Split",
  declined: "Push refused",
};

type Data<N extends GrowthNode> = { node: N; now: number; chosen: boolean };
type FlowNode<N extends GrowthNode, K extends string> = Node<Data<N>, K>;

/** Where an edge meets a node: edges are drawn between the sides of the cards they join. */
function Ends() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="a-arch-handle"
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="a-arch-handle"
        isConnectable={false}
      />
    </>
  );
}

function ProjectCard({ data }: NodeProps<FlowNode<ProjectNode, "project">>) {
  const { node } = data;
  return (
    <div className="a-arch-project">
      <Ends />
      <div className="a-arch-row">
        <CubeIcon size={18} aria-hidden />
        <b className="truncate">{node.name}</b>
      </div>
      <div className="a-arch-row a-arch-quiet">
        <span>Trunk</span>
        {node.head === undefined ? (
          <span>—</span>
        ) : (
          <>
            <b className="a-num">{count(node.head.height)}</b>
            <span className="a-mono">{node.head.sha.slice(0, 7)}</span>
            <Badge variant={node.head.verified ? "primary" : "outline"}>
              {node.head.verified ? "Verified" : "Unverified"}
            </Badge>
          </>
        )}
      </div>
      <div className="a-arch-row a-arch-quiet a-num">
        <span>Live {count(node.live)}</span>
        <span>Landed {count(node.landed)}</span>
      </div>
    </div>
  );
}

function ForkCard({ data }: NodeProps<FlowNode<ForkNode, "fork">>) {
  const { node, now, chosen } = data;
  return (
    <div
      className="a-arch-fork"
      data-standing={node.standing}
      data-chosen={chosen || undefined}
      title={node.why === undefined ? node.goal : `${node.goal}\n${node.why}`}
    >
      <Ends />
      <div className="a-arch-row">
        <GitForkIcon size={14} aria-hidden />
        <b className="a-mono">{node.label}</b>
        <span className="a-arch-state" data-standing={node.standing}>
          {node.standing === "stuck" && <WarningCircleIcon size={11} weight="fill" aria-hidden />}
          {node.escalated === true ? "Awaiting ruling" : STAGE_WORD[node.stage]}
        </span>
        <span className="a-arch-time a-num">{elapsed(now - node.since)}</span>
      </div>
      <div className="a-arch-goal">{node.goal}</div>
    </div>
  );
}

/** A long label by its end, where runs of one sweep differ, from a word's start where one is near: `…checkcolor-tests-007`. */
const endOf = (label: string): string => {
  if (label.length <= 24) return label;
  const tail = label.slice(-23);
  const word = tail.indexOf("-");
  return `…${word >= 0 && word < 6 ? tail.slice(word + 1) : tail}`;
};

function AgentDot({ data }: NodeProps<FlowNode<AgentNode, "agent">>) {
  const { node } = data;
  return (
    <div
      className="a-arch-agent"
      title={node.run === undefined ? node.name : `${node.name} · ${node.run}`}
    >
      <Ends />
      <RobotIcon size={13} aria-hidden />
      {/* The run where its token named one: one account's many runs are as many agents at work. */}
      <span className="truncate">{node.run === undefined ? node.name : endOf(node.run)}</span>
    </div>
  );
}

function PileCard({ data }: NodeProps<FlowNode<PileNode, "pile">>) {
  const { node } = data;
  return (
    <div className="a-arch-pile" data-stage={node.stage}>
      <Ends />
      <HourglassIcon size={14} aria-hidden />
      <b className="a-num">{count(node.count)}</b>
      <span>{PILE_WORD[node.stage]}</span>
    </div>
  );
}

function BatchCard({ data }: NodeProps<FlowNode<BatchNode, "batch">>) {
  const { node, now, chosen } = data;
  const timer = node.verifyingT === undefined ? undefined : (node.endedT ?? now) - node.verifyingT;
  return (
    <div
      className="a-arch-batch"
      data-state={node.state}
      data-chosen={chosen || undefined}
      title={node.why}
    >
      <Ends />
      <div className="a-arch-row">
        <StackIcon size={14} aria-hidden />
        <b>{node.label}</b>
        <span className="a-arch-state" data-state={node.state}>
          {BATCH_WORD[node.state]}
        </span>
        {timer !== undefined && <span className="a-arch-time a-num">{elapsed(timer)}</span>}
      </div>
      <div className="a-arch-row a-arch-quiet a-num">
        <span>
          {count(node.members)} {node.members === 1 ? "change" : "changes"}
        </span>
        {node.why !== undefined && <span className="truncate">{node.why}</span>}
      </div>
    </div>
  );
}

const CHECK_ICON = {
  pass: <CheckCircleIcon size={14} weight="fill" aria-hidden />,
  fail: <XCircleIcon size={14} weight="fill" aria-hidden />,
  running: <CircleNotchIcon size={14} aria-hidden className="a-arch-spin" />,
  stopped: <StopCircleIcon size={14} aria-hidden />,
  abstain: <MinusCircleIcon size={14} aria-hidden />,
  escalate: <WarningCircleIcon size={14} weight="fill" aria-hidden />,
  annotate: <MinusCircleIcon size={14} aria-hidden />,
  said: <MinusCircleIcon size={14} aria-hidden />,
} as const;

function CheckChip({ data }: NodeProps<FlowNode<CheckNode, "check">>) {
  const { node, now } = data;
  return (
    <div className="a-arch-check" data-result={node.result} title={node.line ?? node.name}>
      <Ends />
      {CHECK_ICON[node.result]}
      <span className="a-mono truncate">{node.name}</span>
      {node.took !== undefined ? (
        <span className="a-arch-time a-num">{elapsed(node.took)}</span>
      ) : (
        node.since !== undefined && (
          <span className="a-arch-time a-num">{elapsed(now - node.since)}</span>
        )
      )}
    </div>
  );
}

function DeployCard({ data }: NodeProps<FlowNode<DeployNode, "deploy">>) {
  const { node } = data;
  let host = node.url;
  if (URL.canParse(node.url)) host = new URL(node.url).host;
  return (
    <div className="a-arch-deploy" data-down={node.down || undefined} title={node.url}>
      <Ends />
      <div className="a-arch-row">
        <RocketLaunchIcon size={14} aria-hidden />
        <b>Preview</b>
        <span className="a-arch-state">{node.down ? "Torn down" : "Live"}</span>
      </div>
      <div className="a-arch-goal a-mono">{host}</div>
    </div>
  );
}

const NODE_TYPES = {
  project: ProjectCard,
  fork: ForkCard,
  agent: AgentDot,
  pile: PileCard,
  batch: BatchCard,
  check: CheckChip,
  deploy: DeployCard,
};

// ── Edges ─────────────────────────────────────────────────────────────────

type WireEdge = Edge<
  {
    kind: GrowthEdgeKind;
    from: { x: number; y: number };
    to: { x: number; y: number };
    sides: [Position, Position];
    fade: number;
  },
  "wire"
>;

/** An edge as React Flow draws one, between the facing sides of the two cards it joins, arrowed where work goes. */
function Wire({ data, markerEnd, style }: EdgeProps<WireEdge>) {
  if (data === undefined) return null;
  const [path] = getBezierPath({
    sourceX: data.from.x,
    sourceY: data.from.y,
    sourcePosition: data.sides[0],
    targetX: data.to.x,
    targetY: data.to.y,
    targetPosition: data.sides[1],
  });
  return (
    <path
      d={path}
      className="react-flow__edge-path a-arch-wire"
      data-kind={data.kind}
      markerEnd={markerEnd}
      style={{ ...style, opacity: data.fade }}
    />
  );
}

const EDGE_TYPES = { wire: Wire };

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which sides of two cards an edge joins: their facing sides, top and bottom where one is mostly under the other. */
function sidesOf(a: Box, b: Box): Pick<NonNullable<WireEdge["data"]>, "from" | "to" | "sides"> {
  const [ax, ay, bx, by] = [a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y + b.h / 2];
  if (Math.abs(by - ay) >= Math.abs(bx - ax) * 0.6)
    return by > ay
      ? {
          from: { x: ax, y: a.y + a.h },
          to: { x: bx, y: b.y },
          sides: [Position.Bottom, Position.Top],
        }
      : {
          from: { x: ax, y: a.y },
          to: { x: bx, y: b.y + b.h },
          sides: [Position.Top, Position.Bottom],
        };
  return bx > ax
    ? {
        from: { x: a.x + a.w, y: ay },
        to: { x: b.x, y: by },
        sides: [Position.Right, Position.Left],
      }
    : {
        from: { x: a.x, y: ay },
        to: { x: b.x + b.w, y: by },
        sides: [Position.Left, Position.Right],
      };
}

/** The colour of each kind of edge's arrow: grey for structure, green into trunk, red for a bounce. */
const ARROW: Record<GrowthEdgeKind, string | undefined> = {
  fork: "#8b949e",
  works: undefined,
  join: "#8b949e",
  test: "#8b949e",
  ship: "#8b949e",
  land: "#3fb950",
  fail: "#f85149",
  chain: undefined,
};

function flowOf(
  growth: Growth,
  now: number,
  chosen: string | undefined,
): { nodes: Node[]; edges: Edge[] } {
  const boxes = new Map<string, Box>();
  const nodes: Node[] = growth.nodes.map((node) => {
    boxes.set(node.id, node);
    const picked =
      chosen !== undefined &&
      ((node.kind === "fork" && node.changeId === chosen) ||
        (node.kind === "batch" && node.batchId === chosen));
    return {
      id: node.id,
      type: node.kind,
      position: { x: node.x, y: node.y },
      width: node.w,
      height: node.h,
      data: { node, now, chosen: picked },
      draggable: false,
      connectable: false,
      selectable: false,
      style: { opacity: node.fade, width: node.w, height: node.h },
      zIndex: node.kind === "project" ? 2 : 1,
    } satisfies Node;
  });
  const edges: Edge[] = growth.edges
    .toSorted((a, b) => onTop(a) - onTop(b))
    .flatMap((edge) => {
      const [a, b] = [boxes.get(edge.source), boxes.get(edge.target)];
      if (a === undefined || b === undefined) return [];
      const colour = ARROW[edge.kind];
      return [
        {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "wire",
          animated: edge.moving,
          ...(colour === undefined
            ? {}
            : {
                markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: colour },
              }),
          data: { kind: edge.kind, fade: edge.fade, ...sidesOf(a, b) },
          selectable: false,
          focusable: false,
          zIndex: 0,
        } satisfies WireEdge,
      ];
    });
  return { nodes, edges };
}

/** A landing and a bounce are drawn over the other edges, and every edge under the cards. */
const onTop = (edge: Growth["edges"][number]): number =>
  edge.kind === "fail" || edge.kind === "land" ? 1 : 0;

export interface MissionCanvasProps {
  canvas: Canvas;
  growth: Growth;
  now: number;
  mode: Mode;
  live: boolean;
  /** Whether the log has been read to its end. */
  loaded: boolean;
}

export function MissionCanvas({ canvas, growth, now, mode, live, loaded }: MissionCanvasProps) {
  const [chosen, setChosen] = useState<string | undefined>();
  const changeAddress = useChangeAddress();
  const frame = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance | null>(null);
  const fitted = useRef(false);
  // The view keeps the whole diagram in frame as it grows, until the reader moves it.
  const follow = useRef(true);

  const { nodes, edges } = useMemo(() => flowOf(growth, now, chosen), [growth, now, chosen]);

  const something = growth.nodes.length > 1;
  // The diagram's bounds to the nearest card or so outward, so the view is fitted again when it grows by one and
  // not at every reading.
  const STEP = 60;
  const left = Math.floor(growth.focus.x / STEP) * STEP;
  const top = Math.floor(growth.focus.y / STEP) * STEP;
  const right = Math.ceil((growth.focus.x + growth.focus.width) / STEP) * STEP;
  const bottom = Math.ceil((growth.focus.y + growth.focus.height) / STEP) * STEP;
  const bounds = useRef({ x: left, y: top, width: right - left, height: bottom - top });
  const fit = useCallback((duration: number): void => {
    void flow.current?.fitBounds(bounds.current, { padding: 0.02, duration });
  }, []);
  useEffect(() => {
    bounds.current = { x: left, y: top, width: right - left, height: bottom - top };
    if (!follow.current) return;
    const duration = fitted.current ? 700 : 0;
    fitted.current = true;
    requestAnimationFrame(() => fit(duration));
  }, [left, top, right, bottom, fit]);

  const full = useCallback((): void => {
    const element = frame.current;
    if (element === null) return;
    if (document.fullscreenElement === null) void element.requestFullscreen?.();
    else void document.exitFullscreen();
  }, []);
  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    const on = (): void => {
      setIsFull(document.fullscreenElement !== null);
      if (follow.current) requestAnimationFrame(() => fit(300));
    };
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, [fit]);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key !== "f" && event.key !== "F") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]") != null) return;
      event.preventDefault();
      full();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [full]);

  const picked = growth.nodes.find(
    (node) =>
      (node.kind === "fork" && node.changeId === chosen) ||
      (node.kind === "batch" && node.batchId === chosen),
  );

  return (
    <div ref={frame} className="a-mc a-arch" data-full={isFull || undefined}>
      <Header canvas={canvas} runs={growth.runs} live={live} />
      <div className="a-mc-stage">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode={mode}
          onInit={(instance) => {
            flow.current = instance;
            // The diagram may have been drawn whole before the view was ready to be fitted.
            if (follow.current) requestAnimationFrame(() => fit(0));
          }}
          onNodeClick={(_, node) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a node's type names its data
            const data = node.data as Data<GrowthNode>;
            if (data.node.kind === "fork" && data.node.escalated === true)
              navigate(changeAddress(data.node.changeId));
            else if (data.node.kind === "fork") setChosen(data.node.changeId);
            else if (data.node.kind === "batch") setChosen(data.node.batchId);
          }}
          onPaneClick={() => setChosen(undefined)}
          onMoveStart={(event) => {
            if (event !== null) follow.current = false;
          }}
          minZoom={0.04}
          maxZoom={2}
          defaultViewport={{ x: 960, y: 500, zoom: 0.5 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} className="a-mc-ground" />
          <Controls
            showInteractive={false}
            onFitView={() => {
              // The whole diagram, drawn or not: only what is in view is rendered, so React Flow's own fit sees less.
              follow.current = true;
              fit(300);
            }}
            fitViewOptions={{ padding: 0.02 }}
            aria-label="Zoom and fit"
          />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            className="a-mc-minimap"
            ariaLabel="Where the view is on the whole diagram"
          />
          <Panel position="top-left" className="a-arch-legend" aria-label="Key">
            <span data-standing="moving">Moving</span>
            <span data-standing="waiting">Waiting</span>
            <span data-standing="stuck">Stuck</span>
            <span data-kind="land">Landing</span>
            <span data-kind="fail">Bounce</span>
          </Panel>
        </ReactFlow>
        <div className="a-mc-tools">
          <button type="button" onClick={full} aria-keyshortcuts="F">
            {isFull ? (
              <ArrowsInIcon size={15} aria-hidden />
            ) : (
              <ArrowsOutIcon size={15} aria-hidden />
            )}
            {isFull ? "Leave full screen" : "Full screen"}
          </button>
        </div>
        {!something && (
          <output className="a-mc-empty">
            <h2>{loaded ? "No live changes" : "Loading"}</h2>
          </output>
        )}
        {picked !== undefined && (picked.kind === "fork" || picked.kind === "batch") && (
          <Inspector
            picked={picked}
            growth={growth}
            now={now}
            onClose={() => setChosen(undefined)}
          />
        )}
      </div>
    </div>
  );
}

// ── The header and the inspector ──────────────────────────────────────────

function Header({ canvas, runs, live }: { canvas: Canvas; runs: number; live: boolean }) {
  const { answers, counts } = canvas;
  const rate = answers.perMinute.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return (
    <div className="a-mc-strip">
      <p className="a-mc-live" data-live={live || undefined}>
        <i aria-hidden />
        {live ? "Live" : "Playback"}
      </p>
      <dl className="a-mc-answers">
        <div>
          <dt>
            {answers.advances > 0 && answers.unverified === answers.advances
              ? "Advances"
              : "Green advances"}
          </dt>
          <dd className="a-num">
            {answers.advances === 0
              ? "—"
              : // Where Keel verified no advance, none is green: say so, not "0 of n".
                answers.unverified === answers.advances
                ? `Unverified ${count(answers.unverified)}`
                : `${count(answers.green)} of ${count(answers.advances)}`}
          </dd>
        </div>
        <div>
          <dt>Caught</dt>
          <dd className="a-num">{count(answers.caught)}</dd>
        </div>
        <div>
          <dt>Recovered</dt>
          <dd className="a-num">
            {answers.bounced === 0
              ? "—"
              : `${count(answers.recovered)} of ${count(answers.bounced)}`}
          </dd>
        </div>
        <div>
          <dt>Landings / min</dt>
          <dd className="a-num">{rate}</dd>
        </div>
      </dl>
      <p className="a-mc-counts a-num">
        Agents {count(counts.agents)}
        {runs > counts.agents ? ` · Runs ${count(runs)}` : ""} · Live {count(canvas.live)} · Batches{" "}
        {count(counts.batches)} · Landed {count(counts.landed)}
      </p>
    </div>
  );
}

function Inspector({
  picked,
  growth,
  now,
  onClose,
}: {
  picked: ForkNode | BatchNode;
  growth: Growth;
  now: number;
  onClose: () => void;
}) {
  if (picked.kind === "batch") {
    const checks = growth.nodes.filter(
      (node): node is CheckNode =>
        node.kind === "check" && node.id.startsWith(`check:${picked.batchId}:`),
    );
    return (
      <aside className="a-mc-inspect" aria-label={picked.label}>
        <button type="button" className="a-mc-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2>{picked.label}</h2>
        <p className="text-kumo-subtle">
          {BATCH_WORD[picked.state]} · {count(picked.members)}{" "}
          {picked.members === 1 ? "change" : "changes"}
        </p>
        {picked.why !== undefined && <p>{picked.why}</p>}
        {checks.length > 0 && (
          <ul>
            {checks.map((check) => (
              <li key={check.id} className="a-mono text-[12px]">
                {check.line ?? `${check.name}: ${elapsed(now - (check.since ?? now))}`}
              </li>
            ))}
          </ul>
        )}
      </aside>
    );
  }
  return (
    <aside className="a-mc-inspect" aria-label={`Change ${picked.label}`}>
      <button type="button" className="a-mc-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <h2>
        <ChangeLink id={picked.changeId}>{picked.label}</ChangeLink>
      </h2>
      <p>{picked.goal}</p>
      <p className="text-kumo-subtle">
        {STAGE_WORD[picked.stage]} · <span className="a-num">{elapsed(now - picked.since)}</span>
      </p>
      {picked.why !== undefined && <p className="a-mc-why">{picked.why}</p>}
    </aside>
  );
}
