import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@keeltown/sdk";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it, vi } from "vitest";
import { encodeEntry, entryName } from "../src/agent-key.ts";
import { run as exec, type KeyStore } from "../src/key-store.ts";
import { type Io, run } from "../src/run.ts";

const ORIGIN = "https://keel.test";
const TOKEN_ENDPOINT = `${ORIGIN}/v1/auth/oauth2/token`;
const PROJECT = "prj_01HZY8K1K1K1K1K1K1K1K1K1K1";
const AGENT = "agt_01HZY8A3A3A3A3A3A3A3A3A3A3";
const ANCHORED = "src/authz/require-permission.ts";
const D1 = "dec_01HZY8D1D1D1D1D1D1D1D1D1D1";
const G1 = "grd_01HZY8G1G1G1G1G1G1G1G1G1G1";
const CONFLICT = "cfl_01HZY8C1C1C1C1C1C1C1C1C1C1";
const RELYING = "chg_01HZY8A1A1A1A1A1A1A1A1A1A1";
const EFFECT = "chg_01HZY8B1B1B1B1B1B1B1B1B1B1";
const AT = "2026-10-14T00:57:21.555Z";

/** What D-1 upheld. */
const PROPOSITION = {
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
  anchors: [{ path: ANCHORED, symbol: "requirePermission", commit: "6c7417f0".repeat(5) }],
  strength: "must",
};

/** The links of one decision's chain, as `why` answers them: decision, premise, intent, guard, landing. */
function decisionLinks(label: string, id: string, rationale = "The premise holds") {
  return [
    {
      summary: `${label} ruled premise-holds: ${rationale}: authz.permission-evaluation freshness at-most per-request`,
      record: {
        mfp: "0.1",
        kind: "decision",
        id,
        author: { kind: "human", id: "user:usr_01HZY8R1R1R1R1R1R1R1R1R1R1" },
        at: AT,
        cites: [
          { kind: "record", id: `${CONFLICT}.premise` },
          { kind: "record", id: G1 },
        ],
        evidenceClass: "ruling",
        payload: {
          question: `${RELYING} relies on the premise, and ${EFFECT} makes it per-session. Which holds?`,
          chosen: "premise-holds",
          rationale,
          alternatives: [
            { option: "effect-stands", reasonRejected: `${RELYING} must stop relying.` },
          ],
          reversible: true,
        },
      },
    },
    {
      summary: `${RELYING} relies on authz.permission-evaluation freshness at-most per-request`,
      record: {
        mfp: "0.1",
        kind: "premise",
        id: `${CONFLICT}.premise`,
        change: RELYING,
        author: { kind: "agent", id: "agt_01HZY8A2A2A2A2A2A2A2A2A2A2" },
        at: AT,
        cites: [],
        payload: { proposition: PROPOSITION },
      },
    },
    {
      summary: `${EFFECT} intends "Speed up permission checks with a per-session role cache"`,
      record: {
        mfp: "0.1",
        kind: "intent",
        id: `${EFFECT}.intent.2`,
        change: EFFECT,
        author: { kind: "agent", id: "agt_01HZY8B2B2B2B2B2B2B2B2B2B2" },
        at: AT,
        cites: [],
        payload: {
          revision: 2,
          goal: "Speed up permission checks with a per-session role cache",
          footprint: [{ path: ANCHORED, op: "edit" }],
          premises: [],
          declaredEffects: [],
        },
      },
    },
    {
      summary: `G-1 holds ${label}: probe prb_01HZY8P1P1P1P1P1P1P1P1P1P1 told the worlds apart in 3 runs`,
      record: {
        mfp: "0.1",
        kind: "observation",
        id: G1,
        author: { kind: "platform", id: "keel" },
        at: AT,
        cites: [{ kind: "record", id: `${CONFLICT}.premise` }],
        evidenceClass: "proof",
        payload: {
          category: "guard",
          importance: "high",
          summary: `Guard ${G1} asserts the premise ${label} upheld`,
          evidence: [{ class: "proof", ref: "prb_01HZY8P1P1P1P1P1P1P1P1P1P1", at: AT }],
        },
      },
    },
    {
      summary: `${RELYING} landed as ${"7d5f3456".repeat(5)} under ${label}`,
      record: {
        mfp: "0.1",
        kind: "verdict",
        id: `${RELYING}.landed`,
        change: RELYING,
        author: { kind: "platform", id: "keel" },
        at: AT,
        cites: [{ kind: "record", id }],
        payload: {
          outcome: "land",
          reasons: [{ class: "proof", ref: "7d5f3456".repeat(5), at: AT }],
        },
      },
    },
  ];
}

/** `why`'s answer for chains of links, with Keel's next action for each decision. */
const explained = (links: readonly ReturnType<typeof decisionLinks>[number][]) =>
  Response.json({
    ok: true,
    summary: `explains ${ANCHORED}`,
    result: { chain: links },
    findings: [],
    next: links
      .filter((link) => link.record.kind === "decision")
      .map((link) => ({
        kind: "read",
        title: `Read decision ${link.record.id}`,
        operationId: "Memory_getDecision",
        args: { decisionId: link.record.id },
      })),
    notices: [],
    cost: {},
  });

const nothingToExplain = () =>
  Response.json(
    {
      type: "urn:keel:problem:why.nothing_to_explain",
      title: "No active decision explains the path or subject asked about",
      status: 404,
      code: "why.nothing_to_explain",
      detail: `No active decision in your project explains ${ANCHORED}.`,
      requestId: "req-1",
      nextActions: [
        {
          kind: "read",
          title: "List the project's decisions",
          operationId: "Memory_listDecisions",
        },
      ],
    },
    { status: 404 },
  );

const envelope = (summary: string, result: unknown) =>
  Response.json({ ok: true, summary, result, findings: [], next: [], notices: [], cost: {} });

interface Sent {
  readonly url: URL;
  readonly method: string;
  readonly body: string;
  readonly signal: AbortSignal | undefined;
}

/** A clone of `acme/forge` with `remotes`, and the anchored file in it; the path as the OS's temp dir names it, before any symlink resolves. */
function clone(remotes: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "keel-hook-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  for (const [name, url] of Object.entries(remotes))
    execFileSync("git", ["-C", dir, "remote", "add", name, url]);
  mkdirSync(join(dir, "src/authz"), { recursive: true });
  writeFileSync(join(dir, ANCHORED), "export function requirePermission() {}\n");
  return dir;
}

const KEEL_REMOTE = { origin: `${ORIGIN}/acme/forge.git` };

/**
 * A machine holding keelbot's key and a fake Keel: discovery, the token
 * endpoint, the project's lookup, and what `answer` scripts for the rest.
 */
async function hookMachine(
  options: {
    readonly answer?: (url: URL, init: RequestInit) => Response | Promise<Response>;
    readonly stdin?: string;
    readonly env?: Record<string, string>;
    /** Every request waits until it is aborted, and the deadline comes as the first one waits. */
    readonly hang?: boolean;
  } = {},
) {
  const sent: Sent[] = [];
  let waiting: (() => void) | undefined;
  const someoneWaits = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const out: string[] = [];
  const err: string[] = [];
  const { privateJwk } = await generateAgentKey();
  const held = new Map([
    [
      entryName(ORIGIN, "keelbot"),
      encodeEntry({ jwk: privateJwk, agentId: AGENT, handle: "keelbot" }),
    ],
  ]);
  const keyStore: KeyStore = {
    kind: "a test key store",
    read: async (name) => held.get(name),
    write: async (name, secret) => void held.set(name, secret),
    remove: async (name) => void held.delete(name),
  };
  const io: Io = {
    env: {
      KEEL_URL: ORIGIN,
      TMPDIR: mkdtempSync(join(tmpdir(), "keel-hook-state-")),
      ...options.env,
    },
    stdout: (line) => void out.push(line),
    stderr: (line) => void err.push(line),
    stdin: async () => options.stdin ?? "",
    keyStore,
    exec,
    // The deadline never comes unless a test brings it.
    sleep: options.hang === true ? () => someoneWaits : () => new Promise<void>(() => {}),
    fetch: async (url, init) => {
      const at = new URL(url);
      sent.push({
        url: at,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? init.body : "",
        signal: init.signal ?? undefined,
      });
      if (options.hang === true)
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          waiting?.();
        });
      if (url === `${ORIGIN}/.well-known/oauth-authorization-server`)
        return Response.json({
          issuer: `${ORIGIN}/v1/auth`,
          token_endpoint: TOKEN_ENDPOINT,
          registration_endpoint: `${ORIGIN}/v1/oauth/register`,
        });
      if (url === TOKEN_ENDPOINT)
        return Response.json({
          access_token: "token-1",
          token_type: new Headers(init.headers).has("dpop") ? "DPoP" : "Bearer",
          expires_in: 300,
        });
      if (at.pathname === "/v1/namespaces/acme/projects/forge")
        return Response.json({
          id: PROJECT,
          namespace: { handle: "acme", kind: "org" },
          name: "forge",
          visibility: "public",
        });
      if (options.answer !== undefined) return options.answer(at, init);
      return Response.json({ status: 404 }, { status: 404 });
    },
  };
  return { io, sent, out, err };
}

/** What Claude Code hands the hook after its agent reads `file`. */
const readEvent = (file: string, session = randomUUID()) =>
  JSON.stringify({
    session_id: session,
    transcript_path: "/dev/null",
    cwd: tmpdir(),
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: file },
    tool_response: { type: "text" },
  });

const startEvent = (cwd: string, source = "startup", session = randomUUID()) =>
  JSON.stringify({
    session_id: session,
    transcript_path: "/dev/null",
    cwd,
    hook_event_name: "SessionStart",
    source,
  });

const POST_TOOL_USE = ["hook", "post-tool-use", "--profile", "keelbot"];

/** The context a hook's one line of output adds, after checking it names its own event. */
function contextOf(out: readonly string[], event: string): string {
  expect(out).toHaveLength(1);
  const output: unknown = JSON.parse(out[0] ?? "");
  expect(
    Reflect.get(Object(Reflect.get(Object(output), "hookSpecificOutput")), "hookEventName"),
  ).toBe(event);
  const context: unknown = Reflect.get(
    Object(Reflect.get(Object(output), "hookSpecificOutput")),
    "additionalContext",
  );
  expect(typeof context).toBe("string");
  return String(context);
}

/** The `why` requests a run made. */
const whyAsked = (sent: readonly Sent[]) => sent.filter((s) => s.url.pathname === "/v1/why");

const answering =
  (why: () => Response, rest: (url: URL) => Response | undefined = () => undefined) =>
  (url: URL) =>
    url.pathname === "/v1/why" ? why() : (rest(url) ?? Response.json({}, { status: 404 }));

describe("keeltown hook post-tool-use", () => {
  it("[hook.note] adds Keel's note when the agent reads a file a decision is anchored in", async () => {
    const repo = clone(KEEL_REMOTE);
    const { io, out } = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED)),
      answer: answering(() => explained(decisionLinks("D-1", D1))),
    });

    expect(await run(POST_TOOL_USE, io)).toBe(0);

    const context = contextOf(out, "PostToolUse");
    expect(context).toContain(`Keel: 1 active decision explains ${ANCHORED} in acme/forge`);
    expect(context).toContain("D-1 ruled premise-holds: The premise holds");
    expect(context).toContain("G-1 holds D-1");
    expect(context).toContain(`Read decision ${D1} [Memory_getDecision {"decisionId":"${D1}"}]`);
  });

  it("[hook.machine] reaches Keel with the machine's own fetch, as the installed command runs it", async () => {
    const repo = clone(KEEL_REMOTE);
    const { io, out, sent } = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED)),
      answer: answering(() => explained(decisionLinks("D-1", D1))),
    });
    const { fetch: machineFetch, ...withoutFetch } = io;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => machineFetch?.(url, init));
    try {
      expect(await run(POST_TOOL_USE, withoutFetch)).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(whyAsked(sent)).toHaveLength(1);
    expect(contextOf(out, "PostToolUse")).toContain("D-1 ruled");
  });

  it("[hook.silent] says nothing, and lets the tool's result stand, when no decision explains the file", async () => {
    const repo = clone(KEEL_REMOTE);
    const { io, out, sent } = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED)),
      answer: answering(nothingToExplain),
    });

    expect(await run(POST_TOOL_USE, io)).toBe(0);

    expect(whyAsked(sent)).toHaveLength(1);
    expect(out).toEqual([]);
  });

  it("[hook.fails-quiet] exits 0 with nothing on stdout when Keel cannot be reached or the event is not one", async () => {
    const repo = clone(KEEL_REMOTE);
    const unreachable = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED)),
      answer: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await run(POST_TOOL_USE, unreachable.io)).toBe(0);
    expect(unreachable.out).toEqual([]);

    const garbled = await hookMachine({ stdin: "{not json" });
    expect(await run(POST_TOOL_USE, garbled.io)).toBe(0);
    expect(garbled.out).toEqual([]);
  });

  it("[hook.relative] asks `why` for the path as the repository names it", async () => {
    const repo = clone(KEEL_REMOTE);
    const { io, sent } = await hookMachine({
      // The temp dir's own name, which on macOS resolves through a symlink: git names the real one.
      stdin: readEvent(join(repo, ANCHORED)),
      answer: answering(nothingToExplain),
    });

    await run(POST_TOOL_USE, io);

    const [asked] = whyAsked(sent);
    expect(asked?.url.searchParams.get("path")).toBe(ANCHORED);
  });

  it("[hook.project] reads in the project the file's Keel remote names, as the run it was installed with", async () => {
    const repo = clone({ upstream: "https://github.com/acme/forge.git", ...KEEL_REMOTE });
    const { io, sent } = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED)),
      answer: answering(nothingToExplain),
    });

    await run([...POST_TOOL_USE, "--run", "lane-x"], io);

    const scoped = sent
      .filter((s) => s.url.href === TOKEN_ENDPOINT)
      .map((s) => new URLSearchParams(s.body))
      .filter((form) => form.has("project"));
    expect(scoped.map((form) => [form.get("project"), form.get("run")])).toEqual([
      [PROJECT, "lane-x"],
    ]);
    expect(whyAsked(sent)).toHaveLength(1);
  });

  it("[hook.remote] asks nothing of Keel for a file whose repository has no Keel remote", async () => {
    const repo = clone({ origin: "https://github.com/acme/forge.git" });
    const { io, out, sent } = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED)),
      answer: answering(() => explained(decisionLinks("D-1", D1))),
    });

    expect(await run(POST_TOOL_USE, io)).toBe(0);

    expect(sent).toEqual([]);
    expect(out).toEqual([]);
  });

  it("[hook.deadline] gives up silently, and stops asking, when Keel does not answer in time", async () => {
    const repo = clone(KEEL_REMOTE);
    const { io, out, sent } = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED)),
      // Keel never answers anything, and the deadline comes once the hook is waiting on it.
      hang: true,
    });

    expect(await run(POST_TOOL_USE, io)).toBe(0);

    expect(out).toEqual([]);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.signal?.aborted === true)).toBe(true);
  }, 2_000);

  it("[hook.mfp] carries every record of the chain as MFP that the MFP schema accepts", async () => {
    const repo = clone(KEEL_REMOTE);
    const { io, out } = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED)),
      answer: answering(() => explained(decisionLinks("D-1", D1))),
    });

    await run(POST_TOOL_USE, io);

    const records = recordsIn(contextOf(out, "PostToolUse"));
    expect(records.map((r) => Reflect.get(Object(r), "kind"))).toEqual([
      "decision",
      "premise",
      "intent",
      "observation",
      "verdict",
    ]);
    const validate = mfpValidator();
    for (const record of records)
      expect({ valid: validate(record), errors: validate.errors }).toEqual({
        valid: true,
        errors: null,
      });
  });

  it("[hook.dedupe] tells a session of a decision once, and a new session again", async () => {
    const repo = clone(KEEL_REMOTE);
    const session = randomUUID();
    const first = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED), session),
      answer: answering(() => explained(decisionLinks("D-1", D1))),
    });
    await run(POST_TOOL_USE, first.io);
    contextOf(first.out, "PostToolUse");

    const again = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED), session),
      env: { TMPDIR: first.io.env["TMPDIR"] ?? "" },
      answer: answering(() => explained(decisionLinks("D-1", D1))),
    });
    expect(await run(POST_TOOL_USE, again.io)).toBe(0);
    expect(again.out).toEqual([]);

    const fresh = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED)),
      env: { TMPDIR: first.io.env["TMPDIR"] ?? "" },
      answer: answering(() => explained(decisionLinks("D-1", D1))),
    });
    await run(POST_TOOL_USE, fresh.io);
    expect(contextOf(fresh.out, "PostToolUse")).toContain("D-1 ruled");
  });

  it("[hook.budget] keeps the note under Claude Code's cap, naming the decisions it leaves out", async () => {
    const repo = clone(KEEL_REMOTE);
    const many = Array.from({ length: 12 }, (_, i) =>
      decisionLinks(
        `D-${i + 1}`,
        `dec_01HZY8D1D1D1D1D1D1D1D1D${"0123456789AB"[i] ?? "0"}`,
        `The premise holds ${"because the revoke must bite at once ".repeat(8)}`,
      ),
    ).flat();
    const { io, out } = await hookMachine({
      stdin: readEvent(join(repo, ANCHORED)),
      answer: answering(() => explained(many)),
    });

    await run(POST_TOOL_USE, io);

    const context = contextOf(out, "PostToolUse");
    expect(context.length).toBeLessThanOrEqual(9_000);
    expect(context).toContain("D-1 ruled");
    expect(context).toMatch(/Not shown here: .*D-12/u);
    expect(context).toContain(`keeltown why --path ${ANCHORED}`);
  });
});

/** What Keel answers the primer's reads with. */
const primerAnswers = (url: URL): Response | undefined => {
  if (url.pathname === "/v1/agents/me")
    return envelope(
      `You are keelbot (${AGENT}), in run claude-code, holding agent:work, agent:read.`,
      {},
    );
  if (url.pathname === "/v1/changes")
    return Response.json({
      items: [
        {
          changeId: EFFECT,
          number: 3,
          state: "working",
          agentId: AGENT,
          goal: "Cache role lookups",
          revision: 1,
          declaredAt: AT,
          updatedAt: AT,
        },
        {
          changeId: RELYING,
          number: 2,
          state: "landed",
          agentId: AGENT,
          goal: "An old landed change",
          revision: 1,
          declaredAt: AT,
          updatedAt: AT,
        },
      ],
    });
  if (url.pathname === "/v1/inbox")
    return envelope("2 notices.", {
      notices: [
        { id: "ntc_1", at: AT, kind: "drift", title: "A premise drifted" },
        { id: "ntc_2", at: AT, kind: "landed", title: "#2 landed" },
      ],
      cursor: "c-1",
    });
  if (url.pathname === "/v1/decisions")
    return Response.json({
      items: [
        {
          id: D1,
          label: "D-1",
          option: "premise-holds",
          summary: "The premise holds: authz.permission-evaluation freshness at-most per-request",
          decidedAt: AT,
          state: "active",
          escalationId: "esc_01HZY8E1E1E1E1E1E1E1E1E1E1",
          project: PROJECT,
          subject: "authz.permission-evaluation",
          holds: [PROPOSITION],
          guards: [G1],
        },
      ],
    });
  return undefined;
};

describe("keeltown hook session-start", () => {
  it("[hook.primer] primes the session with who the agent is, its project, open changes, notices and decisions", async () => {
    const repo = clone(KEEL_REMOTE);
    const { io, out } = await hookMachine({
      stdin: startEvent(repo),
      answer: answering(nothingToExplain, primerAnswers),
    });

    expect(await run(["hook", "session-start", "--profile", "keelbot"], io)).toBe(0);

    const context = contextOf(out, "SessionStart");
    expect(context).toContain(`You are keelbot (${AGENT})`);
    expect(context).toContain(`acme/forge (${PROJECT}, public)`);
    expect(context).toContain("1 open change");
    expect(context).toContain("#3 working: Cache role lookups");
    expect(context).not.toContain("An old landed change");
    expect(context).toContain("2 notices waiting");
    expect(context).toContain(
      `D-1 on authz.permission-evaluation: The premise holds: authz.permission-evaluation freshness at-most per-request (anchored in ${ANCHORED})`,
    );
  });

  it("[hook.primer-compact] forgets which notes the session was given when its context is compacted", async () => {
    const repo = clone(KEEL_REMOTE);
    const session = randomUUID();
    const state = mkdtempSync(join(tmpdir(), "keel-hook-state-"));
    const read = async () => {
      const machine = await hookMachine({
        stdin: readEvent(join(repo, ANCHORED), session),
        env: { TMPDIR: state },
        answer: answering(() => explained(decisionLinks("D-1", D1))),
      });
      await run(POST_TOOL_USE, machine.io);
      return machine.out;
    };
    expect(await read()).toHaveLength(1);
    expect(await read()).toEqual([]);

    const compacted = await hookMachine({
      stdin: startEvent(repo, "compact", session),
      env: { TMPDIR: state },
      answer: answering(nothingToExplain, primerAnswers),
    });
    await run(["hook", "session-start", "--profile", "keelbot"], compacted.io);

    expect(await read()).toHaveLength(1);
  });
});

/** A clone's local Claude Code settings. */
const settingsOf = (repo: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repo, ".claude/settings.local.json"), "utf8"));

describe("keeltown hooks install", () => {
  it("[hooks.install] merges Keel's two hooks into the clone's local settings once, keeping the rest, with no credential", async () => {
    const repo = clone(KEEL_REMOTE);
    mkdirSync(join(repo, ".claude"));
    const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] };
    writeFileSync(
      join(repo, ".claude/settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { PostToolUse: [theirs] } }),
    );
    const { io } = await hookMachine();

    for (let i = 0; i < 2; i++)
      expect(
        await run(
          ["hooks", "install", "--profile", "keelbot", "--run", "lane-x", "--dir", repo],
          io,
        ),
      ).toBe(0);

    const settings = settingsOf(repo);
    expect(settings["permissions"]).toEqual({ allow: ["Read"] });
    const hooks = Object(settings["hooks"]);
    expect(hooks.PostToolUse).toEqual([
      theirs,
      {
        matcher: "Read|Edit|MultiEdit|Write|NotebookEdit",
        hooks: [
          {
            type: "command",
            command: `KEEL_URL='${ORIGIN}' keeltown hook post-tool-use --profile 'keelbot' --run 'lane-x'`,
            timeout: 10,
          },
        ],
      },
    ]);
    expect(hooks.SessionStart).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `KEEL_URL='${ORIGIN}' keeltown hook session-start --profile 'keelbot' --run 'lane-x'`,
            timeout: 10,
          },
        ],
      },
    ]);
    const written = readFileSync(join(repo, ".claude/settings.local.json"), "utf8");
    expect(written).not.toMatch(/token-1|Bearer|DPoP|eyJ/u);
  });

  it("[hooks.install-names] refuses a run label that is not one, so nothing it writes runs as shell", async () => {
    const repo = clone(KEEL_REMOTE);
    const { io, err } = await hookMachine();

    expect(await run(["hooks", "install", "--run", "x'; rm -rf ~; '", "--dir", repo], io)).toBe(2);

    expect(err.join("\n")).toContain("--run takes a run label");
    expect(() => readFileSync(join(repo, ".claude/settings.local.json"))).toThrow(/ENOENT/u);
  });
});

describe("keeltown why", () => {
  it("[why.cli] prints the chain Keel answers, as the hook's note does", async () => {
    const { io, out, sent } = await hookMachine({
      env: { KEEL_PROFILE: "keelbot", KEEL_PROJECT: PROJECT },
      answer: answering(() => explained(decisionLinks("D-1", D1))),
    });

    expect(await run(["why", "--subject", "authz.permission-evaluation"], io)).toBe(0);

    expect(whyAsked(sent).map((s) => s.url.searchParams.get("subject"))).toEqual([
      "authz.permission-evaluation",
    ]);
    const printed = out.join("\n");
    expect(printed).toContain("D-1 ruled premise-holds");
    expect(printed).toContain("G-1 holds D-1");
    expect(printed).toContain(`Read decision ${D1} [Memory_getDecision {"decisionId":"${D1}"}]`);
  });
});

/** The MFP records a note carries: one JSON object a line, after its records heading. */
function recordsIn(context: string): unknown[] {
  const at = context.indexOf("MFP records");
  expect(at).toBeGreaterThan(-1);
  return context
    .slice(at)
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

/** MFP's own schema for a record, from the package Keel pins. */
function mfpValidator() {
  const schema: unknown = createRequire(import.meta.url)("@bimsonz/mfp");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(Object(schema), "mfp.json");
  return ajv.compile({ $ref: "mfp.json#/$defs/MfpRecord" });
}
