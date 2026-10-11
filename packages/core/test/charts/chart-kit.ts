/**
 * Statecharts as data: each machine's chart is a plain object in XState's
 * `createMachine` config format. The chart checks the machines (every state
 * change a run makes must be one of its edges, and a deterministic tour must
 * exercise every edge) and draws the docs' diagrams. It never drives decide or
 * evolve, so a wrong edge cannot agree with itself.
 */

export type Target = string | readonly { readonly target: string; readonly guard: string }[];

export interface ChartState {
  readonly type?: "final";
  /** `terminal`: a run may end here though the state has exits (e.g. a Red batch nobody will bisect). */
  readonly tags?: readonly string[];
  readonly initial?: string;
  readonly on?: Readonly<Record<string, Target>>;
  readonly states?: Readonly<Record<string, ChartState>>;
}

export interface Chart extends ChartState {
  readonly id: string;
  readonly initial: string;
  /**
   * The event that creates the entity, and the docs section (heading text) the
   * diagram belongs to. `alsoCreated`: other events that create it, in a state
   * other than `initial`.
   */
  readonly meta: {
    readonly createdBy: string;
    readonly section: string;
    readonly alsoCreated?: readonly Creation[];
  };
  readonly states: Readonly<Record<string, ChartState>>;
}

/** An event that creates the entity in `target`, under `guard`. */
export interface Creation {
  readonly event: string;
  readonly target: string;
  readonly guard?: string;
}

export interface Edge {
  readonly from: string;
  readonly event: string;
  readonly to: string;
  /** For one of several targets of the same event: the condition that picks it. */
  readonly guard?: string;
}

export const edgeKey = (e: Pick<Edge, "from" | "event" | "to">): string =>
  `${e.from} --${e.event}--> ${e.to}`;

/** A target as a state path relative to the root: `#change.parked.leaseLapsed` → `parked.leaseLapsed`. */
const resolve = (chart: Chart, target: string): string =>
  target.startsWith(`#${chart.id}.`) ? target.slice(chart.id.length + 2) : target;

const walk = (
  states: Readonly<Record<string, ChartState>>,
  prefix: string,
): [string, ChartState][] =>
  Object.entries(states).flatMap(([name, state]) => {
    const path = `${prefix}${name}`;
    return [
      [path, state] as [string, ChartState],
      ...(state.states === undefined ? [] : walk(state.states, `${path}.`)),
    ];
  });

/** Every state path, compound states included. */
export const statesOf = (chart: Chart): readonly [string, ChartState][] => walk(chart.states, "");

/** The leaf states: where an entity can actually be. */
export const leavesOf = (chart: Chart): readonly string[] =>
  statesOf(chart)
    .filter(([, s]) => s.states === undefined)
    .map(([p]) => p);

/** Every edge, with a compound state's transitions inherited by its children. */
export const edgesOf = (chart: Chart): readonly Edge[] => {
  const all = statesOf(chart);
  return leavesOf(chart).flatMap((leaf) =>
    all
      .filter(([path]) => leaf === path || leaf.startsWith(`${path}.`))
      .flatMap(([, state]) =>
        Object.entries(state.on ?? {}).flatMap(([event, target]) =>
          typeof target === "string"
            ? [{ from: leaf, event, to: resolve(chart, target) }]
            : target.map((t) => ({
                from: leaf,
                event,
                to: resolve(chart, t.target),
                guard: t.guard,
              })),
        ),
      ),
  );
};

/** The states a run may end in: finals, and those tagged terminal. */
export const terminalsOf = (chart: Chart): readonly string[] =>
  statesOf(chart)
    .filter(([, s]) => s.type === "final" || (s.tags ?? []).includes("terminal"))
    .map(([p]) => p);

/** What the chart says of one observed transition: on the chart, or not. */
export const conforms = (chart: Chart): ((from: string, event: string, to: string) => boolean) => {
  const edges = edgesOf(chart);
  const listed = new Set(edges.map((e) => `${e.from}|${e.event}`));
  const allowed = new Set(edges.map(edgeKey));
  // An event the chart lists at `from` must go where it says; any other event is a fact and must not move the state.
  return (from, event, to) =>
    listed.has(`${from}|${event}`) ? allowed.has(edgeKey({ from, event, to })) : from === to;
};

const title = (path: string): string => {
  const leaf = path.split(".").at(-1) ?? path;
  return leaf.charAt(0).toUpperCase() + leaf.slice(1);
};

/** The chart as a mermaid `stateDiagram-v2`, the form the docs show. */
export const toMermaid = (chart: Chart): string => {
  const lines = [
    "stateDiagram-v2",
    `  [*] --> ${title(chart.initial)}: ${chart.meta.createdBy}`,
    ...(chart.meta.alsoCreated ?? []).map(
      (c) =>
        `  [*] --> ${title(c.target)}: ${c.event}${c.guard === undefined ? "" : ` [${c.guard}]`}`,
    ),
  ];
  for (const [path, state] of statesOf(chart)) {
    if (state.states === undefined) continue;
    lines.push(
      `  state ${title(path)} {`,
      ...Object.keys(state.states).map((child) => `    ${title(child)}`),
      "  }",
    );
  }
  // Each state's own transitions, drawn once from where the chart declares them: a compound state's from the compound.
  for (const [path, state] of statesOf(chart)) {
    for (const [event, target] of Object.entries(state.on ?? {})) {
      const targets = typeof target === "string" ? [{ target, guard: undefined }] : target;
      for (const t of targets) {
        lines.push(
          `  ${title(path)} --> ${title(resolve(chart, t.target))}: ${event}${t.guard === undefined ? "" : ` [${t.guard}]`}`,
        );
      }
    }
  }
  for (const t of terminalsOf(chart)) lines.push(`  ${title(t)} --> [*]`);
  return lines.join("\n");
};
