// The pipeline: every change moving through Keel, live, left to right in the
// order Keel takes it. Agents and their runs, then the stages a
// change goes through, the batches in flight with the batches they rest on,
// what verification said, and trunk's spine. It pans and zooms, and the reader
// keeps the view they chose: the canvas is fitted once, when it first has
// something to show, and never again by itself.
//
// Motion means a move Keel recorded while the page is open: the change slides
// to where Keel put it, and one particle runs the way it went. Nothing moves on
// open, and nothing at all where the reader has asked for reduced motion.

import {
  Background,
  BackgroundVariant,
  type Edge,
  type EdgeProps,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  ViewportPortal,
  getBezierPath,
  BaseEdge,
  EdgeLabelRenderer,
} from "@xyflow/react";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "@xyflow/react/dist/style.css";
import {
  ArrowsInIcon,
  ArrowsOutIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  CornersOutIcon,
  HandPalmIcon,
  MinusCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Canvas,
  type CanvasAgent,
  type CanvasBatch,
  type CanvasChange,
  type CanvasCommit,
  type CanvasEdge,
  type CanvasStep,
  type ChipStage,
} from "../engine/canvas.ts";
import {
  BATCH_W,
  type Box,
  CANVAS_W,
  CHIP_W,
  COLUMN,
  COLUMNS,
  DOT,
  DOTS_PER_ROW,
  DOTS_TOP,
  type Placed,
  place,
} from "../engine/place.ts";
import { waitsOnItsAgent } from "../engine/flow.ts";
import type { Mode } from "../theme/mode.ts";
import { ChangeLink, EscalationLink, SubjectLink } from "./links.tsx";

const count = (value: number): string => value.toLocaleString("en-US");

/** `m:ss`, or `h:mm:ss` past the hour. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const STAGE_WORD: Record<ChipStage | "batch", string> = {
  bounced: "bounced",
  declared: "declared",
  precheck: "in precheck",
  queue: "queued",
  batch: "in a batch",
};

const BATCH_WORD: Record<CanvasBatch["state"], string> = {
  forming: "forming",
  assembled: "assembled",
  verifying: "verifying",
  green: "verified",
  promoting: "landing",
  red: "failed",
  cancelled: "cancelled",
  bisected: "split",
  declined: "push refused",
};

const Swatch = ({ hue }: { hue: number }) => (
  <i className="a-mc-swatch" data-hue={hue} aria-hidden />
);

// ── Nodes ──────────────────────────────────────────────────────────────────

type HeadNode = Node<{ title: string; count?: number }, "head">;
type BandNode = Node<{ id: string }, "band">;
type ChipNode = Node<{ change: CanvasChange; selected: boolean; member: boolean }, "chip">;
type AgentNode = Node<{ agent: CanvasAgent }, "agent">;
type BatchNode = Node<{ batch: CanvasBatch; compact: boolean; selected: boolean }, "batch">;
type VerifyNode = Node<{ batch: CanvasBatch; now: number }, "verify">;
type CommitNode = Node<{ commit: CanvasCommit; head: boolean }, "commit">;
type SpineNode = Node<Record<string, never>, "spine">;
type DenseNode = Node<
  { stage: ChipStage; changes: CanvasChange[]; onOpen: (id: string) => void },
  "dense"
>;

function Head({ data }: NodeProps<HeadNode>) {
  return (
    <div className="a-mc-head">
      <span>{data.title}</span>
      {data.count !== undefined && <b className="a-num">{count(data.count)}</b>}
    </div>
  );
}

function Band() {
  return <div className="a-mc-band" />;
}

const HIDDEN = { opacity: 0, pointerEvents: "none" } as const;

function Chip({ data }: NodeProps<ChipNode>) {
  const { change, member } = data;
  return (
    <div
      className="a-mc-chip"
      data-stage={change.stage}
      data-member={member || undefined}
      data-quiet={change.quiet || undefined}
      data-parked={change.parked === undefined || waitsOnItsAgent(change) ? undefined : true}
      data-selected={data.selected || undefined}
    >
      <Handle type="target" position={Position.Left} style={HIDDEN} isConnectable={false} />
      <div className="a-mc-chip-top">
        <Swatch hue={change.hue} />
        <b className="a-mono">{change.label}</b>
        {change.revision > 1 && <span className="a-mc-rev">r{change.revision}</span>}
        {change.parked !== undefined &&
          (waitsOnItsAgent(change) ? (
            // Its agent's lease lapsed: it waits on its agent, as the list of changes says, and asks nobody.
            <span className="a-mc-flag">Waiting on its agent</span>
          ) : (
            <span className="a-mc-flag" data-tone="person">
              <HandPalmIcon size={11} weight="fill" aria-hidden />
              Needs a ruling
            </span>
          ))}
        {change.requeued !== undefined && change.parked === undefined && (
          <span className="a-mc-flag">requeued: {change.requeued}</span>
        )}
      </div>
      <div className="a-mc-goal" title={change.goal}>
        {change.goal}
      </div>
      {!member &&
        (change.bounced === undefined ? (
          change.facts.length > 0 && <div className="a-mc-facts">{change.facts.join(" · ")}</div>
        ) : (
          <div className="a-mc-why" title={change.bounced}>
            {change.bounced}
          </div>
        ))}
      <Handle type="source" position={Position.Right} style={HIDDEN} isConnectable={false} />
    </div>
  );
}

function Agent({ data }: NodeProps<AgentNode>) {
  const { agent } = data;
  return (
    <div className="a-mc-agent">
      <div className="a-mc-agent-top">
        <Swatch hue={agent.hue} />
        <div className="min-w-0">
          <b className="block truncate">{agent.name}</b>
          <span className="block truncate text-[12px] text-kumo-subtle">
            {[agent.handle === undefined ? "" : `@${agent.handle}`, `${count(agent.live)} live`]
              .filter((part) => part !== "")
              .join(" · ")}
          </span>
        </div>
      </div>
      <ul className="a-mc-runs">
        {agent.runs.map((run) => (
          <li key={run.id}>
            <Swatch hue={run.hue} />
            <span className="truncate">{run.label}</span>
            <b className="a-num">{count(run.changes)}</b>
          </li>
        ))}
        {agent.moreRuns > 0 && (
          <li className="text-kumo-subtle">and {count(agent.moreRuns)} more runs</li>
        )}
      </ul>
    </div>
  );
}

function BatchGroup({ data }: NodeProps<BatchNode>) {
  const { batch, compact } = data;
  const where = batch.on === undefined ? "on trunk" : `depth ${batch.depth} · on ${batch.on}`;
  return (
    <div
      className="a-mc-batch"
      data-state={batch.state}
      data-speculative={batch.on === undefined ? undefined : true}
      data-compact={compact || undefined}
      data-selected={data.selected || undefined}
    >
      <Handle type="target" position={Position.Top} style={HIDDEN} isConnectable={false} />
      <div className="a-mc-batch-top">
        <b>{batch.label}</b>
        <span>{where}</span>
        {batch.attempt > 0 && <span>attempt {batch.attempt + 1}</span>}
        {batch.tier !== undefined && <span>tier {batch.tier}</span>}
        <span className="a-mc-batch-state">{BATCH_WORD[batch.state]}</span>
      </div>
      {compact && (
        <div className="a-mc-dots" aria-label={`${count(batch.members.length)} changes`}>
          {batch.members.slice(0, 40).map((id) => (
            <i key={id} />
          ))}
        </div>
      )}
      {!compact && batch.more > 0 && <div className="a-mc-more">and {count(batch.more)} more</div>}
      {batch.why !== undefined && <div className="a-mc-batch-why">{batch.why}</div>}
      <Handle type="source" position={Position.Bottom} style={HIDDEN} isConnectable={false} />
    </div>
  );
}

const STEP_ICON: Record<CanvasStep["result"], typeof CheckCircleIcon> = {
  pass: CheckCircleIcon,
  fail: XCircleIcon,
  abstain: MinusCircleIcon,
  escalate: HandPalmIcon,
  annotate: MinusCircleIcon,
  said: MinusCircleIcon,
};

function Verify({ data }: NodeProps<VerifyNode>) {
  const { batch, now } = data;
  const running = batch.verifyingT !== undefined && batch.endedT === undefined;
  const took =
    batch.verifyingT === undefined ? undefined : (batch.endedT ?? now) - batch.verifyingT;
  return (
    <div className="a-mc-verify" data-state={batch.state} data-running={running || undefined}>
      <div className="a-mc-verify-top">
        {running ? (
          <CircleNotchIcon size={14} className="a-mc-spin" aria-hidden />
        ) : batch.state === "red" ? (
          <XCircleIcon size={14} weight="fill" aria-hidden />
        ) : batch.steps.length > 0 ? (
          <CheckCircleIcon size={14} weight="fill" aria-hidden />
        ) : null}
        <span>
          {running
            ? "verifying"
            : batch.verifyingT === undefined
              ? batch.endedT === undefined
                ? "waiting to verify"
                : "not verified"
              : BATCH_WORD[batch.state]}
        </span>
        {took !== undefined && <b className="a-num">{elapsed(took)}</b>}
      </div>
      {batch.steps.length > 0 ? (
        <ul className="a-mc-steps">
          {batch.steps.map((step) => {
            const Icon = STEP_ICON[step.result];
            return (
              <li key={step.name} data-result={step.result} title={step.line}>
                <Icon size={13} weight="fill" aria-hidden />
                <span className="a-mono truncate">{step.name}</span>
                <span className="a-mc-step-word">
                  {step.result === "said" ? "" : step.result}
                  {step.tier === undefined ? "" : ` · tier ${step.tier}`}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        running && <div className="a-mc-shimmer" aria-hidden />
      )}
    </div>
  );
}

function Commit({ data }: NodeProps<CommitNode>) {
  const { commit, head } = data;
  return (
    <div className="a-mc-commit" data-head={head || undefined} data-verified={commit.verified}>
      <Handle type="target" position={Position.Left} style={HIDDEN} isConnectable={false} />
      <i className="a-mc-commit-dot" aria-hidden />
      <div className="min-w-0">
        <div className="a-mc-commit-top">
          <b className="a-num">{count(commit.height)}</b>
          <span className="a-mono">{commit.sha.slice(0, 7)}</span>
          {!commit.verified && <span className="a-mc-flag">unverified</span>}
        </div>
        <div className="a-mc-commit-changes">
          {commit.changes.slice(0, 6).map((change) => (
            <span key={change.id} className="a-mono">
              <Swatch hue={change.hue} />
              {change.label}
            </span>
          ))}
          {commit.changes.length > 6 && <span>+{count(commit.changes.length - 6)}</span>}
        </div>
      </div>
    </div>
  );
}

function Spine() {
  return <div className="a-mc-spine" />;
}

/** A stage with too many changes to draw one by one: a dot each, in its run's colour. */
function Dense({ data }: NodeProps<DenseNode>) {
  const { changes, onOpen } = data;
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const at = (event: ReactMouseEvent<HTMLDivElement>): CanvasChange | undefined => {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = box.width / CHIP_W;
    const column = Math.floor((event.clientX - box.left) / scale / DOT);
    const row = Math.floor((event.clientY - box.top - DOTS_TOP * scale) / scale / DOT);
    if (column < 0 || column >= DOTS_PER_ROW || row < 0) return undefined;
    return changes[row * DOTS_PER_ROW + column];
  };
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a pointer shortcut to one dot; every change is reachable from the Changes list
    <div
      className="a-mc-dense nodrag"
      onMouseMove={(event) => {
        const change = at(event);
        const box = event.currentTarget.getBoundingClientRect();
        const scale = box.width / CHIP_W;
        setTip(
          change === undefined
            ? null
            : {
                x: (event.clientX - box.left) / scale,
                y: (event.clientY - box.top) / scale,
                text: `${change.label} ${change.goal}`,
              },
        );
      }}
      onMouseLeave={() => setTip(null)}
      onClick={(event) => {
        const change = at(event);
        if (change !== undefined) onOpen(change.id);
      }}
    >
      <div className="a-mc-dense-dots">
        {changes.map((change) => (
          <i
            key={change.id}
            data-hue={change.hue}
            data-parked={change.parked === undefined || waitsOnItsAgent(change) ? undefined : true}
            data-quiet={change.quiet || undefined}
          />
        ))}
      </div>
      {tip !== null && (
        <div className="a-mc-tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

const NODE_TYPES = {
  head: Head,
  band: Band,
  chip: Chip,
  agent: Agent,
  batch: BatchGroup,
  verify: Verify,
  commit: Commit,
  spine: Spine,
  dense: Dense,
};

// ── Edges ──────────────────────────────────────────────────────────────────

type TieEdge = Edge<{ tie: CanvasEdge }, "tie">;
type RailEdge = Edge<{ depth: number }, "rail">;

function Tie({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<TieEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  });
  const tie = data?.tie;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className="a-mc-tie"
        data-kind={tie?.kind}
        data-state={tie?.state}
      />
      {tie !== undefined && tie.label !== "" && (
        <EdgeLabelRenderer>
          <div
            className="a-mc-tie-label nodrag nopan"
            data-state={tie.state}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {tie.subject === undefined ? (
              tie.label
            ) : (
              <SubjectLink subject={tie.subject}>{tie.label}</SubjectLink>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function Rail({ id, sourceX, sourceY, targetX, targetY }: EdgeProps<RailEdge>) {
  return (
    <BaseEdge
      id={id}
      path={`M ${sourceX - BATCH_W / 2 + 14} ${sourceY} L ${targetX - BATCH_W / 2 + 14} ${targetY}`}
      className="a-mc-rail"
    />
  );
}

const EDGE_TYPES = { tie: Tie, rail: Rail };

// ── Particles ──────────────────────────────────────────────────────────────

type Tone = "move" | "bounce" | "land";

interface Flight {
  from: { x: number; y: number };
  to: { x: number; y: number };
  tone: Tone;
}

const centre = (box: Box): { x: number; y: number } => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/** A point along a flight, `k` from 0 to 1: forward moves arc right, a bounce dips under the flow on its way back. */
function along({ from, to, tone }: Flight, k: number): { x: number; y: number } {
  const back = to.x < from.x;
  const dip = back ? 140 : 0;
  const c1 = back
    ? { x: from.x, y: from.y + dip }
    : { x: from.x + (to.x - from.x) * 0.5, y: from.y };
  const c2 = back ? { x: to.x, y: to.y + dip } : { x: to.x - (to.x - from.x) * 0.5, y: to.y };
  const u = 1 - k;
  void tone;
  return {
    x: u * u * u * from.x + 3 * u * u * k * c1.x + 3 * u * k * k * c2.x + k * k * k * to.x,
    y: u * u * u * from.y + 3 * u * u * k * c1.y + 3 * u * k * k * c2.y + k * k * k * to.y,
  };
}

const FLIGHT_MS = 900;
const TAIL = 7;
const MOST_IN_FLIGHT = 80;
const SVG = "http://www.w3.org/2000/svg";

/** Whether the reader has asked for less motion. */
function useStill(): boolean {
  const [still, setStill] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = (): void => setStill(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  return still;
}

/**
 * The flights of the moves Keel recorded since the last reading: each change that moved since, from where it
 * was to where it is, and each that landed, into trunk's newest advance that carried it. The first reading has
 * none: the canvas opens on the present and replays nothing.
 */
export function flightsOf(
  before: { canvas: Canvas; placed: Placed } | undefined,
  canvas: Canvas,
  placed: Placed,
): Flight[] {
  if (before === undefined) return [];
  const flights: Flight[] = [];
  const was = new Map(before.canvas.changes.map((change) => [change.id, change]));
  for (const change of canvas.changes) {
    const prior = was.get(change.id);
    if (prior === undefined || prior.moves === change.moves) continue;
    const from =
      before.placed.changes.get(change.id) ?? before.placed.batches.get(prior.batchId ?? "");
    const to = placed.changes.get(change.id) ?? placed.batches.get(change.batchId ?? "");
    if (from === undefined || to === undefined) continue;
    flights.push({
      from: centre(from),
      to: centre(to),
      tone: change.stage === "bounced" ? "bounce" : "move",
    });
  }
  const live = new Set(canvas.changes.map((change) => change.id));
  for (const commit of canvas.commits) {
    const box = placed.commits.get(commit.height);
    if (box === undefined || before.placed.commits.has(commit.height)) continue;
    for (const { id: landed } of commit.changes) {
      if (live.has(landed)) continue;
      const prior = was.get(landed);
      const from =
        before.placed.changes.get(landed) ?? before.placed.batches.get(prior?.batchId ?? "");
      if (from !== undefined) flights.push({ from: centre(from), to: centre(box), tone: "land" });
    }
  }
  return flights;
}

/** Runs each flight as one particle with a short tail, drawn straight into the canvas's own coordinates. */
function Particles({ flights, still }: { flights: readonly Flight[]; still: boolean }) {
  const layer = useRef<SVGGElement>(null);
  useEffect(() => {
    const group = layer.current;
    if (group === null || still || flights.length === 0) return undefined;
    const started = performance.now();
    const running = flights.slice(0, MOST_IN_FLIGHT).map((flight, index) => {
      const dots = Array.from({ length: TAIL }, (_, k) => {
        const dot = document.createElementNS(SVG, "circle");
        dot.setAttribute("r", String(5 - k * 0.55));
        dot.setAttribute("class", "a-mc-particle");
        dot.dataset["tone"] = flight.tone;
        dot.style.opacity = "0";
        group.append(dot);
        return dot;
      });
      // Several moves read at once start a beat apart, so they read as several.
      return { flight, dots, delay: Math.min(index, 12) * 40 };
    });
    let frame = 0;
    const step = (time: number): void => {
      let alive = false;
      for (const { flight, dots, delay } of running) {
        const k = (time - started - delay) / FLIGHT_MS;
        dots.forEach((dot, index) => {
          const at = k - index * 0.035;
          if (at < 0 || at > 1) {
            dot.style.opacity = "0";
            return;
          }
          const eased = 1 - (1 - at) ** 3;
          const point = along(flight, eased);
          dot.setAttribute("cx", String(point.x));
          dot.setAttribute("cy", String(point.y));
          dot.style.opacity = String((1 - index / TAIL) * (at > 0.85 ? (1 - at) / 0.15 : 1));
        });
        if (k - TAIL * 0.035 < 1) alive = true;
      }
      if (alive) frame = requestAnimationFrame(step);
      else for (const { dots } of running) for (const dot of dots) dot.remove();
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      for (const { dots } of running) for (const dot of dots) dot.remove();
    };
  }, [flights, still]);
  return (
    <ViewportPortal>
      <svg className="a-mc-particles" width={1} height={1} aria-hidden>
        <g ref={layer} />
      </svg>
    </ViewportPortal>
  );
}

// ── The canvas ─────────────────────────────────────────────────────────────

const HEAD_Y = -72;

function nodesOf(
  canvas: Canvas,
  placed: Placed,
  now: number,
  selected: string | undefined,
  onOpen: (id: string) => void,
): Node[] {
  const nodes: Node[] = [];
  const tall = Math.max(placed.height, 480) + 120;
  const countOf: Partial<Record<string, number>> = {
    agents: canvas.counts.agents,
    bounced: canvas.counts.bounced,
    declared: canvas.counts.declared,
    precheck: canvas.counts.precheck,
    queue: canvas.counts.queue,
    batches: canvas.counts.batches,
    verify: canvas.counts.verifying,
    trunk: canvas.answers.advances,
  };
  for (const column of COLUMNS) {
    nodes.push({
      id: `band:${column.id}`,
      type: "band",
      position: { x: column.x - 14, y: HEAD_Y - 14 },
      data: { id: column.id },
      width: column.width + 28,
      height: tall,
      zIndex: -2,
      selectable: false,
      focusable: false,
      draggable: false,
    } satisfies BandNode);
    const columnCount = countOf[column.id];
    nodes.push({
      id: `head:${column.id}`,
      type: "head",
      position: { x: column.x, y: HEAD_Y },
      data: { title: column.title, ...(columnCount === undefined ? {} : { count: columnCount }) },
      width: column.width,
      height: 40,
      selectable: false,
      focusable: false,
      draggable: false,
    } satisfies HeadNode);
  }
  for (const agent of canvas.agents) {
    const box = placed.agents.get(agent.id);
    if (box === undefined) continue;
    nodes.push({
      id: `agent:${agent.id}`,
      type: "agent",
      position: { x: box.x, y: box.y },
      data: { agent },
      width: box.width,
      height: box.height,
      draggable: false,
    } satisfies AgentNode);
  }
  for (const stage of canvas.dotted) {
    const changes = canvas.changes
      .filter((change) => change.stage === stage)
      .toSorted((a, b) => a.since - b.since || a.id.localeCompare(b.id));
    if (changes.length === 0) continue;
    nodes.push({
      id: `dense:${stage}`,
      type: "dense",
      position: { x: COLUMN[stage].x, y: 0 },
      data: { stage, changes, onOpen },
      width: CHIP_W,
      height: DOTS_TOP + Math.ceil(changes.length / DOTS_PER_ROW) * DOT,
      draggable: false,
    } satisfies DenseNode);
  }
  for (const change of canvas.changes) {
    if (change.stage !== "batch" && canvas.dotted.includes(change.stage)) continue;
    const box = placed.changes.get(change.id);
    if (box === undefined) continue;
    nodes.push({
      id: `change:${change.id}`,
      type: "chip",
      position: { x: box.x, y: box.y },
      data: { change, selected: change.id === selected, member: change.stage === "batch" },
      width: box.width,
      height: box.height,
      zIndex: 1,
      draggable: false,
    } satisfies ChipNode);
  }
  for (const batch of canvas.batches) {
    const box = placed.batches.get(batch.id);
    const verify = placed.verify.get(batch.id);
    if (box === undefined || verify === undefined) continue;
    nodes.push({
      id: `batch:${batch.id}`,
      type: "batch",
      position: { x: box.x, y: box.y },
      data: { batch, compact: canvas.compact, selected: batch.id === selected },
      width: box.width,
      height: box.height,
      zIndex: 0,
      draggable: false,
    } satisfies BatchNode);
    nodes.push({
      id: `verify:${batch.id}`,
      type: "verify",
      position: { x: verify.x, y: verify.y },
      data: { batch, now },
      width: verify.width,
      height: verify.height,
      draggable: false,
    } satisfies VerifyNode);
  }
  nodes.push({
    id: "spine",
    type: "spine",
    position: { x: COLUMN.trunk.x + 15, y: 0 },
    data: {},
    width: 2,
    height: tall - 120,
    zIndex: -1,
    selectable: false,
    focusable: false,
    draggable: false,
  } satisfies SpineNode);
  canvas.commits.forEach((commit, index) => {
    const box = placed.commits.get(commit.height);
    if (box === undefined) return;
    nodes.push({
      id: `commit:${commit.height}`,
      type: "commit",
      position: { x: box.x, y: box.y },
      data: { commit, head: index === 0 },
      width: box.width,
      height: box.height,
      draggable: false,
    } satisfies CommitNode);
  });
  return nodes;
}

function edgesOf(canvas: Canvas): Edge[] {
  const edges: Edge[] = [];
  if (!canvas.dense)
    for (const tie of canvas.edges)
      edges.push({
        id: tie.id,
        type: "tie",
        source: `change:${tie.from}`,
        target: `change:${tie.to}`,
        data: { tie },
        selectable: false,
        focusable: false,
      } satisfies TieEdge);
  const byLabel = new Map(canvas.batches.map((batch) => [batch.label, batch]));
  for (const batch of canvas.batches) {
    const under = batch.on === undefined ? undefined : byLabel.get(batch.on);
    if (under === undefined) continue;
    edges.push({
      id: `rail:${batch.id}`,
      type: "rail",
      source: `batch:${under.id}`,
      target: `batch:${batch.id}`,
      data: { depth: batch.depth },
      selectable: false,
      focusable: false,
    } satisfies RailEdge);
  }
  return edges;
}

const MINIMAP_COLOUR = (node: Node): string => {
  switch (node.type) {
    case "chip":
      return "var(--mc-mini-chip)";
    case "batch":
      return "var(--mc-mini-batch)";
    case "commit":
      return "var(--mc-mini-commit)";
    case "agent":
      return "var(--mc-mini-agent)";
    case "dense":
      return "var(--mc-mini-chip)";
    default:
      return "transparent";
  }
};

export interface PipelineProps {
  canvas: Canvas;
  now: number;
  mode: Mode;
  /** Whether the log has been read to its end: until it has, nothing is said to be still, and nothing flies. */
  loaded: boolean;
}

export function Pipeline({ canvas, now, mode, loaded }: PipelineProps) {
  const placed = useMemo(() => place(canvas), [canvas]);
  const before = useRef<{ canvas: Canvas; placed: Placed } | undefined>(undefined);
  const [flights, setFlights] = useState<Flight[]>([]);
  const still = useStill();
  const [selected, setSelected] = useState<string | undefined>();
  const [far, setFar] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance | null>(null);
  const fitted = useRef(false);

  // Each reading is laid beside the one before: what moved between them flies.
  useEffect(() => {
    const moved = flightsOf(before.current, canvas, placed);
    // What the first read of the log folds is history: it is drawn where it ends, and flies nowhere.
    before.current = loaded ? { canvas, placed } : undefined;
    if (moved.length > 0) setFlights(moved);
  }, [canvas, placed, loaded]);

  const open = useCallback((id: string) => setSelected(id), []);
  const nodes = useMemo(
    () => nodesOf(canvas, placed, now, selected, open),
    [canvas, placed, now, selected, open],
  );
  const edges = useMemo(() => edgesOf(canvas), [canvas]);

  // Fitted once, when there is first something to fit, and never again by itself: every column across the
  // width, the top of each in view. A long column is followed down by panning.
  // Trunk's starting commit alone is no history to draw: a project with nothing else says it has no live changes.
  const something =
    canvas.changes.length + canvas.batches.length > 0 ||
    canvas.commits.some((commit) => commit.height > 0);
  const across = useCallback((duration: number): void => {
    const room = frame.current?.querySelector(".a-mc-stage")?.getBoundingClientRect();
    if (room === undefined || flow.current === null) return;
    const zoom = Math.min(1, (room.width - 48) / CANVAS_W);
    void flow.current.setViewport({ x: 24, y: 24 - HEAD_Y * zoom + 8, zoom }, { duration });
  }, []);
  useEffect(() => {
    if (fitted.current || !something) return;
    fitted.current = true;
    across(0);
  }, [something, across]);

  const full = useCallback((): void => {
    const element = frame.current;
    if (element === null) return;
    if (document.fullscreenElement === null) void element.requestFullscreen?.();
    else void document.exitFullscreen();
  }, []);
  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    const on = (): void => setIsFull(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
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

  const chosen =
    selected === undefined
      ? undefined
      : (canvas.changes.find((change) => change.id === selected) ??
        canvas.batches.find((batch) => batch.id === selected));

  return (
    <div ref={frame} className="a-mc" data-full={isFull || undefined} data-far={far || undefined}>
      <Header canvas={canvas} />
      <div className="a-mc-stage">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode={mode}
          onInit={(instance) => {
            flow.current = instance;
          }}
          onMove={(_, viewport) => {
            const isFar = viewport.zoom < 0.5;
            setFar((was) => (was === isFar ? was : isFar));
          }}
          onNodeClick={(_, node) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a node's type names its data
            if (node.type === "chip") setSelected((node.data as ChipNode["data"]).change.id);
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a node's type names its data
            else if (node.type === "batch") setSelected((node.data as BatchNode["data"]).batch.id);
          }}
          onPaneClick={() => setSelected(undefined)}
          minZoom={0.08}
          maxZoom={2}
          defaultViewport={{ x: 24, y: 96, zoom: 0.8 }}
          translateExtent={[
            [-800, -800],
            [CANVAS_W + 800, Math.max(placed.height, 600) + 1200],
          ]}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} className="a-mc-ground" />
          <MiniMap
            pannable
            zoomable
            nodeColor={MINIMAP_COLOUR}
            nodeStrokeWidth={0}
            className="a-mc-minimap"
            ariaLabel="Where the view is on the whole canvas"
          />
          <Particles flights={flights} still={still} />
        </ReactFlow>
        <div className="a-mc-tools">
          <button type="button" onClick={() => across(300)}>
            <CornersOutIcon size={15} aria-hidden /> Fit
          </button>
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
            {loaded ? (
              <>
                <h2>No live changes</h2>
              </>
            ) : (
              <h2>Loading</h2>
            )}
          </output>
        )}
        {chosen !== undefined && (
          <Inspector
            chosen={chosen}
            canvas={canvas}
            now={now}
            onClose={() => setSelected(undefined)}
          />
        )}
      </div>
    </div>
  );
}

// ── The header and the inspector ──────────────────────────────────────────

function Header({ canvas }: { canvas: Canvas }) {
  const { answers, counts } = canvas;
  const rate = answers.perMinute.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return (
    <div className="a-mc-strip">
      <dl className="a-mc-answers">
        <div>
          <dt>Green advances</dt>
          <dd className="a-num">
            {answers.advances === 0 ? "—" : `${count(answers.green)} of ${count(answers.advances)}`}
            {answers.unverified > 0 && (
              <span className="a-mc-note"> · Unverified {count(answers.unverified)}</span>
            )}
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
        Agents {count(counts.agents)} · Live {count(canvas.live)} · Batches {count(counts.batches)}{" "}
        · Landed {count(counts.landed)}
      </p>
    </div>
  );
}

function Inspector({
  chosen,
  canvas,
  now,
  onClose,
}: {
  chosen: CanvasChange | CanvasBatch;
  canvas: Canvas;
  now: number;
  onClose: () => void;
}) {
  const isBatch = "members" in chosen;
  return (
    <aside className="a-mc-inspect" aria-label={isBatch ? chosen.label : `Change ${chosen.label}`}>
      <button type="button" className="a-mc-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      {isBatch ? (
        <>
          <h2>{chosen.label}</h2>
          <p className="text-kumo-subtle">
            {BATCH_WORD[chosen.state]}
            {chosen.on === undefined ? " · on trunk" : ` · depth ${chosen.depth}, on ${chosen.on}`}
            {chosen.tier === undefined ? "" : ` · tier ${chosen.tier}`}
            {chosen.composer === undefined ? "" : ` · ${chosen.composer}`}
          </p>
          {chosen.verifyingT !== undefined && (
            <p>
              Verifying for{" "}
              <b className="a-num">{elapsed((chosen.endedT ?? now) - chosen.verifyingT)}</b>
            </p>
          )}
          {chosen.why !== undefined && <p>{chosen.why}</p>}
          <h3>Changes</h3>
          <ul>
            {chosen.members.map((id) => {
              const change = canvas.changes.find((each) => each.id === id);
              return (
                <li key={id}>
                  <ChangeLink id={id}>{change?.label ?? id}</ChangeLink>{" "}
                  <span className="text-kumo-subtle">{change?.goal}</span>
                </li>
              );
            })}
          </ul>
          {chosen.steps.length > 0 && (
            <>
              <h3>Verdict</h3>
              <ul>
                {chosen.steps.map((step) => (
                  <li key={step.name} className="a-mono text-[12px]">
                    {step.line}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <>
          <h2>
            <ChangeLink id={chosen.id}>{chosen.label}</ChangeLink>
          </h2>
          <p>{chosen.goal}</p>
          <p className="text-kumo-subtle">
            {STAGE_WORD[chosen.stage]} for <b className="a-num">{elapsed(now - chosen.since)}</b>
            {chosen.revision > 1 ? ` · revision ${chosen.revision}` : ""}
          </p>
          {chosen.facts.length > 0 && (
            <p className="text-kumo-subtle">{chosen.facts.join(" · ")}</p>
          )}
          {chosen.bounced !== undefined && <p className="a-mc-why">{chosen.bounced}</p>}
          {chosen.parked?.escalationId !== undefined && (
            <p>
              <EscalationLink id={chosen.parked.escalationId}>Open question</EscalationLink>
            </p>
          )}
          <p>
            <ChangeLink id={chosen.id}>Open {chosen.label}</ChangeLink>
          </p>
        </>
      )}
    </aside>
  );
}
