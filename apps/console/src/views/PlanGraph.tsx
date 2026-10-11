// A change's compiled Verification Plan, drawn as the flow it is: steps in
// sequence, steps in parallel, a step run once per world. Each step shows
// where it runs, why it exists for this change, and how it came out.

import { type Edge, Handle, type Node, type NodeProps, Position, ReactFlow } from "@xyflow/react";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import type { FlowNode } from "../contract/provisional.ts";
import type { PlanStep, World } from "../domain/state.ts";
import type { Mode } from "../theme/mode.ts";
import { ClassMark, OutcomeWord, TierBadge } from "./parts.tsx";

const STEP_W = 214;
const STEP_H = 124;
const GAP_X = 34;
const GAP_Y = 16;
const FRAME_PAD = 14;
const FRAME_HEAD = 26;

type StepNodeData = { step: PlanStep };
type FrameNodeData = { label: string };
type StepFlowNode = Node<StepNodeData, "step">;
type FrameFlowNode = Node<FrameNodeData, "frame">;

interface Placed {
  w: number;
  h: number;
  /** Step ids a predecessor connects to, and ones a successor connects from. */
  entries: string[];
  exits: string[];
  place(x: number, y: number, nodes: (StepFlowNode | FrameFlowNode)[], edges: Edge[]): void;
}

const WORLD_NAME: Record<World, string> = {
  trunk: "trunk",
  "A-noop": "A-noop",
  A: "A",
  B: "B",
  AB: "A+B",
};

function arrange(node: FlowNode, steps: ReadonlyMap<string, PlanStep>, key: string): Placed | null {
  if (node.op === "step") {
    const step = steps.get(node.step.id);
    if (step === undefined) return null;
    return {
      w: STEP_W,
      h: STEP_H,
      entries: [step.id],
      exits: [step.id],
      place(x, y, nodes) {
        nodes.push({
          id: step.id,
          type: "step",
          position: { x, y },
          data: { step },
          width: STEP_W,
          height: STEP_H,
        });
      },
    };
  }
  if (node.op === "when" || node.op === "budget") return arrange(node.of, steps, `${key}/0`);
  if (node.op === "worlds") {
    const inner = arrange(node.of, steps, `${key}/0`);
    if (inner === null) return null;
    const label = `Once per world: ${node.over.map((world) => WORLD_NAME[world]).join(" · ")}`;
    return {
      w: inner.w + FRAME_PAD * 2,
      h: inner.h + FRAME_PAD * 2 + FRAME_HEAD,
      entries: inner.entries,
      exits: inner.exits,
      place(x, y, nodes, edges) {
        nodes.push({
          id: `frame:${key}`,
          type: "frame",
          position: { x, y },
          data: { label },
          width: inner.w + FRAME_PAD * 2,
          height: inner.h + FRAME_PAD * 2 + FRAME_HEAD,
          zIndex: -1,
          selectable: false,
        });
        inner.place(x + FRAME_PAD, y + FRAME_PAD + FRAME_HEAD, nodes, edges);
      },
    };
  }
  const children = node.of.flatMap(
    (child, index) => arrange(child, steps, `${key}/${index}`) ?? [],
  );
  if (children.length === 0) return null;
  if (node.op === "seq") {
    const h = Math.max(...children.map((child) => child.h));
    return {
      w: children.reduce((sum, child) => sum + child.w, 0) + GAP_X * (children.length - 1),
      h,
      entries: children[0]?.entries ?? [],
      exits: children.at(-1)?.exits ?? [],
      place(x, y, nodes, edges) {
        let cursor = x;
        children.forEach((child, index) => {
          child.place(cursor, y + (h - child.h) / 2, nodes, edges);
          cursor += child.w + GAP_X;
          const next = children[index + 1];
          if (next === undefined) return;
          for (const from of child.exits) {
            for (const to of next.entries)
              edges.push({ id: `${from}>${to}`, source: from, target: to, type: "smoothstep" });
          }
        });
      },
    };
  }
  // `par` runs together; `cascade` tries each in turn until one settles it. Both stack.
  const w = Math.max(...children.map((child) => child.w));
  return {
    w,
    h: children.reduce((sum, child) => sum + child.h, 0) + GAP_Y * (children.length - 1),
    entries:
      node.op === "cascade"
        ? (children[0]?.entries ?? [])
        : children.flatMap((child) => child.entries),
    exits: children.flatMap((child) => child.exits),
    place(x, y, nodes, edges) {
      let cursor = y;
      children.forEach((child, index) => {
        child.place(x + (w - child.w) / 2, cursor, nodes, edges);
        cursor += child.h + GAP_Y;
        const next = children[index + 1];
        if (node.op !== "cascade" || next === undefined) return;
        for (const from of child.exits) {
          for (const to of next.entries) {
            edges.push({
              id: `${from}>${to}`,
              source: from,
              target: to,
              sourceHandle: "down",
              targetHandle: "up",
              type: "smoothstep",
            });
          }
        }
      });
    },
  };
}

function StepNode({ data }: NodeProps<StepFlowNode>) {
  const { step } = data;
  return (
    <div className="a-step" data-outcome={step.outcome}>
      <Handle type="target" position={Position.Left} />
      <Handle type="target" id="up" position={Position.Top} />
      <div className="flex items-center justify-between gap-2">
        <TierBadge tier={step.tier} />
        <span className="flex items-center gap-1.5 text-sm text-kumo-subtle">
          <ClassMark evidenceClass={step.evidenceClass} size={10} />
          {step.evidenceClass}
        </span>
      </div>
      <div
        className="shrink-0 truncate text-base font-semibold leading-snug text-kumo-strong"
        title={step.title}
      >
        {step.title}
      </div>
      <div className="a-step-because" title={step.because}>
        because {step.because.charAt(0).toLowerCase()}
        {step.because.slice(1)}
      </div>
      <div className="mt-auto flex items-center justify-between text-sm">
        <StepState step={step} />
        {step.ms !== undefined && (
          <span className="a-num text-kumo-subtle">
            {step.ms < 1000 ? `${step.ms} ms` : `${(step.ms / 1000).toFixed(1)} s`}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
      <Handle type="source" id="down" position={Position.Bottom} />
    </div>
  );
}

function StepState({ step }: { step: PlanStep }) {
  if (
    step.outcome === "pass" ||
    step.outcome === "fail" ||
    step.outcome === "n/a" ||
    step.outcome === "running" ||
    step.outcome === "pending"
  ) {
    return <OutcomeWord outcome={step.outcome} size={14} />;
  }
  const word = { annotate: "annotated", abstain: "abstained", waiting: "waiting for a person" }[
    step.outcome
  ];
  return (
    <span
      className={step.outcome === "waiting" ? "a-step-waiting font-medium" : "text-kumo-default"}
    >
      {word}
    </span>
  );
}

function FrameNode({ data }: NodeProps<FrameFlowNode>) {
  return (
    <div className="a-step-frame">
      <span>{data.label}</span>
    </div>
  );
}

const NODE_TYPES = { step: StepNode, frame: FrameNode };

export function PlanGraph({
  spec,
  steps,
  mode,
}: {
  spec: FlowNode;
  steps: PlanStep[];
  mode: Mode;
}) {
  const { nodes, edges, height } = useMemo(() => {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const placed = arrange(spec, byId, "root");
    const laidOut: (StepFlowNode | FrameFlowNode)[] = [];
    const links: Edge[] = [];
    placed?.place(0, 0, laidOut, links);
    // An edge is live while the step it leads to is running.
    const lit = links.map((edge) => ({
      ...edge,
      animated: byId.get(edge.target)?.outcome === "running",
    }));
    return { nodes: laidOut, edges: lit, height: (placed?.h ?? 0) + 48 };
  }, [spec, steps]);

  if (nodes.length === 0) return null;
  return (
    <div className="a-plan-graph" style={{ height: Math.min(Math.max(height, 200), 440) }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode={mode}
        fitView
        fitViewOptions={{ padding: 0.02, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.4}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        preventScrolling={false}
      />
    </div>
  );
}
