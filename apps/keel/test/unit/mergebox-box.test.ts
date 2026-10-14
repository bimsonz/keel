// MergeBox's work over a fake container: a box is started with a canary and
// nothing else, readied and planted, and started again when its canary is lost
// or a deploy changed its image; every compose is followed by the check,
// whatever it came to; a failed compose never names its remote; and the egress
// lets out git to the compose's repos alone, with a token minted for each
// request in place of anything the box sent.
import {
  BOX_CANARY_FILE,
  BOX_CHECK_SCRIPT,
  BOX_COMPOSE_SCRIPT,
  BOX_PLANT_SCRIPT,
} from "@keeltown/gitcore";
import { describe, expect, it } from "vitest";
import {
  type BoxContainer,
  type BoxJob,
  type CanaryStore,
  type Composing,
  composeInBox,
  egressDecision,
  egressForward,
  grantFor,
  readyBox,
} from "../../src/adapters/driving/do/mergebox-box.ts";

const OID = (n: number) => n.toString(16).padStart(40, "0");
const ACCOUNT = "0123456789abcdef0123456789abcdef";

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A container that answers each script as told, and records what was asked of it. */
function fakeBox(
  init: {
    running?: boolean;
    stale?: boolean;
    /** How many first commands throw, as a box still starting does. */
    unready?: number;
    compose?: Run;
    /** The check's stream, given the canary the box was started with. */
    check?: (canary: string) => string;
    /** What the trust script answers once the egress is registered. */
    trust?: Run;
  } = {},
) {
  const calls: string[] = [];
  const starts: Record<string, string>[] = [];
  let running = init.running ?? false;
  let unready = init.unready ?? 0;
  let canary = "";
  // As on the platform: the CA is written, and git gets out, only once the egress is registered.
  let intercepted = false;
  const box: BoxContainer = {
    get running() {
      return running;
    },
    start: (env) => {
      starts.push(env);
      canary = env["KEEL_CANARY"] ?? "";
      running = true;
      intercepted = false;
      calls.push("start");
    },
    intercept: async () => {
      intercepted = true;
      calls.push("intercept");
    },
    stale: async () => init.stale ?? false,
    destroy: async () => {
      running = false;
      calls.push("destroy");
    },
    exec: async (argv) => {
      const script = argv[2];
      if (argv[0] === "true") {
        calls.push("ready");
        if (unready > 0) {
          unready -= 1;
          throw new Error("the box is not up yet");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (script === BOX_PLANT_SCRIPT) {
        calls.push(`plant ${argv[4]}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (script === BOX_COMPOSE_SCRIPT) {
        calls.push("compose");
        if (!intercepted)
          return { exitCode: 3, stdout: "", stderr: "fatal: unable to access: no egress" };
        return init.compose ?? composed(2);
      }
      if (script === BOX_CHECK_SCRIPT) {
        calls.push("check");
        return { exitCode: 0, stdout: (init.check ?? clean)(canary), stderr: "" };
      }
      calls.push("trust");
      // The trust script waits 10 s for a CA that never comes.
      if (!intercepted) return { exitCode: 124, stdout: "", stderr: "" };
      return init.trust ?? { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  /** The box runs on, and its object has lost what it registered (an object that restarted). */
  const forget = () => void (intercepted = false);
  return { box, calls, starts, canary: () => canary, forget };
}

function store(initial?: string): CanaryStore & { value: () => string | undefined } {
  let value = initial;
  return { get: () => value, set: (canary) => void (value = canary), value: () => value };
}

/** A clock that moves `step` ms each time it is read. */
function clock(step: number, from = 1_000) {
  let now = from - step;
  return () => (now += step);
}

const composed = (members: number): Run => ({
  exitCode: 0,
  stdout: `${Array.from({ length: members }, (_, i) => `tree ${i} ${OID(100 + i)}`).join("\n")}\npushed ${OID(900)}\n`,
  stderr: "",
});

/** The check's stream with the canary where it was planted, and `extra` in the files. */
const clean = (canary: string, extra = "") =>
  `=== environ\nKEEL_CANARY=${canary}\nHOME=/root\n=== env\nHOME=/root\n=== files\n--- ${BOX_CANARY_FILE}\n${canary}\n${extra}`;

const JOB: BoxJob = {
  candidateId: "cnd_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
  staging: "https://artifacts.example/git/staging",
  base: OID(1),
  members: [
    { remote: "https://artifacts.example/git/ws-a", base: OID(1), head: OID(2) },
    { remote: "https://artifacts.example/git/ws-b", base: OID(1), head: OID(3) },
  ],
};

describe("readyBox", () => {
  it("[mergebox.ready] starts a stopped box with a fresh canary and nothing else, runs its first command, trusts the CA and plants the canary, and leaves a box it knows running", async () => {
    const fake = fakeBox({ unready: 2 });
    const canaries = store();
    const took = await readyBox(fake.box, canaries, clock(10));
    expect(fake.starts).toEqual([{ KEEL_CANARY: fake.canary() }]);
    expect(fake.canary()).toMatch(/^art_v9_keelcanary_[0-9a-f]{32}$/);
    expect(fake.calls).toEqual([
      "start",
      "ready",
      "ready",
      "ready",
      "intercept",
      "trust",
      `plant ${fake.canary()}`,
    ]);
    expect(canaries.value()).toBe(fake.canary());
    expect(took).toBeGreaterThan(0);

    fake.calls.length = 0;
    expect(await readyBox(fake.box, canaries, clock(10))).toBe(0);
    expect(fake.calls).toEqual(["intercept"]);
  });

  it("[mergebox.box.intercept-before-trust] registers the egress before the box trusts its CA, which the platform writes only then, for a fresh box and a restarted one, and again for a box it reuses, so every compose goes out through it", async () => {
    const fresh = fakeBox();
    const canaries = store();
    await readyBox(fresh.box, canaries, clock(10));
    expect(fresh.calls).toEqual([
      "start",
      "ready",
      "intercept",
      "trust",
      `plant ${fresh.canary()}`,
    ]);
    expect(canaries.value()).toBe(fresh.canary());

    const restarted = fakeBox({ running: true });
    const lost = store();
    await readyBox(restarted.box, lost, clock(10));
    expect(restarted.calls).toEqual([
      "destroy",
      "start",
      "ready",
      "intercept",
      "trust",
      `plant ${restarted.canary()}`,
    ]);

    restarted.forget();
    restarted.calls.length = 0;
    expect(await readyBox(restarted.box, lost, clock(10))).toBe(0);
    const answer = await composeInBox(restarted.box, restarted.canary(), JOB, () => [], 0);
    expect(answer.kind).toBe("composed");
    expect(restarted.calls).toEqual(["intercept", "compose", "check"]);
  });

  it("[mergebox.ready-failed-stage] a box whose script fails is not readied, and says which script, its exit and the end of its stderr, with no remote, account id or token", async () => {
    const fake = fakeBox({
      trust: {
        exitCode: 1,
        stdout: "",
        stderr: `cat: https://${ACCOUNT}.artifacts.example/git/ws: art_v1_leaked ${ACCOUNT}`,
      },
    });
    const canaries = store();
    const readied = readyBox(fake.box, canaries, clock(10));
    await expect(readied).rejects.toThrow(
      "the box was not readied: trust exit 1: cat: <remote> <token> <id>",
    );
    expect(canaries.value()).toBeUndefined();
  });

  it("[mergebox.ready-restart] destroys and starts again a running box whose canary this object lost, or whose image a deploy changed", async () => {
    const lost = fakeBox({ running: true });
    const canaries = store();
    await readyBox(lost.box, canaries, clock(10));
    expect(lost.calls.slice(0, 2)).toEqual(["destroy", "start"]);
    expect(canaries.value()).toBe(lost.canary());

    const stale = fakeBox({ running: true, stale: true });
    const known = store("art_v9_keelcanary_old");
    await readyBox(stale.box, known, clock(10));
    expect(stale.calls.slice(0, 2)).toEqual(["destroy", "start"]);
    expect(known.value()).not.toBe("art_v9_keelcanary_old");
    expect(known.value()).toBe(stale.canary());
  });

  it("[mergebox.ready-never] gives up on a box that runs no command within three minutes, its canary unknown", async () => {
    const fake = fakeBox({ unready: 1_000 });
    const canaries = store();
    await expect(readyBox(fake.box, canaries, clock(60_000))).rejects.toThrow(
      /never ran a command/,
    );
    expect(canaries.value()).toBeUndefined();
  });
});

describe("composeInBox", () => {
  it("[mergebox.check-always] checks the box after every compose, whatever it came to, and answers what the compose did only when the check passes", async () => {
    const runs: [Run, string][] = [
      [composed(2), "composed"],
      [{ exitCode: 1, stdout: "refused 1\npath src/a.ts\npath src/b.ts\n", stderr: "" }, "refused"],
      [{ exitCode: 134, stdout: "", stderr: "" }, "crashed"],
      [{ exitCode: 3, stdout: "", stderr: "fatal: could not fetch" }, "failed"],
    ];
    for (const [run, kind] of runs) {
      const fake = fakeBox({ running: true, compose: run });
      await readyBox(fake.box, store(), clock(10));
      fake.calls.length = 0;
      const answer = await composeInBox(fake.box, fake.canary(), JOB, () => [], 0, clock(5));
      expect(fake.calls).toEqual(["compose", "check"]);
      expect(answer.kind).toBe(kind);
      expect("paths" in answer ? answer.paths : []).toEqual(
        kind === "refused" ? ["src/a.ts", "src/b.ts"] : [],
      );
    }
    const crashedWithToken = fakeBox({
      running: true,
      compose: { exitCode: 134, stdout: "", stderr: "" },
      check: (canary) => clean(canary, "--- /root/.git-credentials\nart_v1_leaked\n"),
    });
    await readyBox(crashedWithToken.box, store(), clock(10));
    const answer = await composeInBox(
      crashedWithToken.box,
      crashedWithToken.canary(),
      JOB,
      () => [],
      0,
    );
    expect(answer.kind).toBe("check-failed");
  });

  it("[mergebox.check] passes a box whose canary is seen and holds no token, with what the compose and the check cost, and refuses one that is blind or holds a minted token", async () => {
    const fake = fakeBox({ running: true });
    await readyBox(fake.box, store(), clock(10));
    const passed = await composeInBox(fake.box, fake.canary(), JOB, () => ["tok-1"], 42, clock(7));
    expect(passed).toEqual({
      kind: "composed",
      trees: [OID(100), OID(101)],
      scratch: `refs/keel/box/${JOB.candidateId}`,
      tip: OID(900),
      boxCheck: { canary: "found", tokens: "none" },
      timings: {
        startMs: 42,
        composeMs: 7,
        checkMs: 7,
        checkBytes: new TextEncoder().encode(clean(fake.canary())).length,
      },
    });

    const blind = fakeBox({ running: true, check: () => "=== environ\nHOME=/root\n=== files\n" });
    await readyBox(blind.box, store(), clock(10));
    const unseen = await composeInBox(blind.box, blind.canary(), JOB, () => [], 0);
    expect(unseen.kind).toBe("check-failed");
    expect("reason" in unseen ? unseen.reason : "").toContain("blind");

    const holding = fakeBox({
      running: true,
      check: (canary) => clean(canary, "--- /root/work/.git/config\nextraheader = tok-minted\n"),
    });
    await readyBox(holding.box, store(), clock(10));
    const found = await composeInBox(holding.box, holding.canary(), JOB, () => ["tok-minted"], 0);
    expect(found.kind).toBe("check-failed");
    expect("reason" in found ? found.reason : "").toContain("token-found");
  });

  it("[mergebox.failed-no-remote] says why a compose failed without the remote git named, which carries the account id", async () => {
    const fake = fakeBox({
      running: true,
      compose: {
        exitCode: 3,
        stdout: "",
        stderr: `error: RPC failed\nfatal: unable to access 'https://${ACCOUNT}.artifacts.example/git/ws-a/': Could not resolve host\n`,
      },
    });
    await readyBox(fake.box, store(), clock(10));
    const answer = await composeInBox(fake.box, fake.canary(), JOB, () => [], 0);
    expect(answer.kind).toBe("failed");
    const reason = "reason" in answer ? answer.reason : "";
    expect(reason).toContain("unable to access '<remote>");
    expect(reason).not.toContain(ACCOUNT);
  });
});

const STAGING = "/acct/ns/keel-st-x.git";
const WS = "/acct/ns/keel-ws-a.git";
const scope = { staging: STAGING, reads: new Set([STAGING, WS]) };
const at = (path: string) => new URL(`https://artifacts.example${path}`);

describe("the egress", () => {
  it("[mergebox.egress] lets out git's smart HTTP to the compose's repos alone: reads of any of them, a push to staging only", () => {
    const cases: [string, string, unknown][] = [
      ["GET", `${WS}/info/refs?service=git-upload-pack`, { repo: WS, access: "read" }],
      ["POST", `${WS}/git-upload-pack`, { repo: WS, access: "read" }],
      ["POST", `${STAGING}/git-upload-pack`, { repo: STAGING, access: "read" }],
      ["GET", `${STAGING}/info/refs?service=git-receive-pack`, { repo: STAGING, access: "write" }],
      ["POST", `${STAGING}/git-receive-pack`, { repo: STAGING, access: "write" }],
      ["POST", `${WS}/git-receive-pack`, { refused: "a push only to staging" }],
      [
        "POST",
        "/acct/ns/keel-ws-other.git/git-upload-pack",
        { refused: "a repo the compose does not name" },
      ],
      ["GET", `${WS}/HEAD`, { refused: `GET ${WS}/HEAD is not git's smart HTTP` }],
      ["GET", `${WS}/info/refs`, { refused: `GET ${WS}/info/refs is not git's smart HTTP` }],
    ];
    for (const [method, path, expected] of cases)
      expect(egressDecision(at(path), method, scope), `${method} ${path}`).toEqual(expected);
    expect(egressDecision(at(`${WS}/git-upload-pack`), "POST", undefined)).toEqual({
      refused: "no compose is running",
    });
  });

  it("[mergebox.egress-mint] mints a fresh token for every request, keeps each for the check, and mints none for a request it refuses", async () => {
    const minted: string[] = [];
    const composing: Composing<string> = {
      scope,
      repos: new Map([
        [STAGING, "staging"],
        [WS, "ws-a"],
      ]),
      minted,
    };
    const asked: string[] = [];
    let n = 0;
    const mint = async (repo: string, access: "read" | "write") => {
      asked.push(`${repo} ${access}`);
      n += 1;
      return `tok-${n}`;
    };
    const ask = (method: string, path: string) =>
      grantFor({ url: at(path).toString(), method }, composing, mint);
    expect(await ask("POST", `${WS}/git-upload-pack`)).toEqual({ token: "tok-1" });
    expect(await ask("POST", `${WS}/git-upload-pack`)).toEqual({ token: "tok-2" });
    expect(await ask("POST", `${STAGING}/git-receive-pack`)).toEqual({ token: "tok-3" });
    expect(await ask("POST", `${WS}/git-receive-pack`)).toEqual({
      refused: "a push only to staging",
    });
    expect(asked).toEqual(["ws-a read", "ws-a read", "staging write"]);
    expect(minted).toEqual(["tok-1", "tok-2", "tok-3"]);
    expect(
      await grantFor(
        { url: at(`${WS}/git-upload-pack`).toString(), method: "POST" },
        undefined,
        mint,
      ),
    ).toEqual({ refused: "no compose is running" });
    expect(asked).toHaveLength(3);
  });

  it("[mergebox.egress-auth] sends a granted request over HTTPS with the minted token as its only credential, and sends nothing it refuses", async () => {
    const sent: Request[] = [];
    const send = async (request: Request) => {
      sent.push(request);
      return new Response("ok");
    };
    const request = new Request(`http://artifacts.example${WS}/git-upload-pack`, {
      method: "POST",
      headers: { authorization: "Basic Ym94OnNlY3JldA==", "content-type": "x-git" },
      body: "0000",
    });
    const answer = await egressForward(request, async () => ({ token: "tok-fresh" }), send);
    expect(await answer.text()).toBe("ok");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`https://artifacts.example${WS}/git-upload-pack`);
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer tok-fresh");
    expect(sent[0]?.headers.get("content-type")).toBe("x-git");

    const refused = await egressForward(
      new Request(`https://artifacts.example${WS}/git-receive-pack`, { method: "POST" }),
      async () => ({ refused: "a push only to staging" }),
      send,
    );
    expect(refused.status).toBe(403);
    expect(sent).toHaveLength(1);
  });
});
