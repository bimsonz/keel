import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { CodeHost, type RepoRef } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { codeHostLayer } from "../../../composition/do.ts";
import { BoxComposeAnswer, BoxComposeRequest, type EgressGrant } from "../../../rpc/mergebox.ts";
import {
  type BoxContainer,
  type CanaryStore,
  type Composing,
  composeInBox,
  egressForward,
  grantFor,
  readyBox,
} from "./mergebox-box.ts";

/** A token the egress mints lasts ten minutes, and is minted for one request. */
const TOKEN_TTL_SECONDS = 600;

/** A box idles out after fifteen minutes with nothing to compose. */
const INACTIVITY_TIMEOUT_MS = 15 * 60_000;

/** The image a box starts from: wrangler's `containers[].images` names it. */
const IMAGE = "base";

/** Where the running box's canary is kept. */
const CANARY = "canary";

const decodeRequest = Schema.decodeUnknownExit(BoxComposeRequest);
const encodeAnswer = Schema.encodeSync(BoxComposeAnswer);

/** The box of a project is named `mergebox:<projectId>`. */
const projectOf = (name: string | undefined) => (name ?? "").replace(/^mergebox:/, "");

/**
 * MergeBox (Tier 2): composes the candidates GitCore refuses, with git's own
 * merge-tree, in a container on the GA API under the `durable_object`
 * scheduling policy, gated by BoxGate. One object per project
 * (`mergebox:<projectId>`) composes one batch at a time. The box has no
 * internet and no credential: its only way out is the Artifacts host, where
 * MergeBoxEgress asks this object for a fresh ten-minute token for each git
 * request and refuses any repo or path the compose does not name; every other
 * host, over HTTPS or HTTP, is refused by MergeBoxDeny. After every compose
 * the box is checked: the canary planted at its start must be seen, and none
 * of the tokens minted for the compose may be.
 */
export class MergeBox extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private composing: Composing<RepoRef> | undefined;

  /** The box, whose egress lets out a compose's git to `artifactsHost` alone. */
  private box(artifactsHost: string): BoxContainer {
    const container = this.ctx.container;
    if (container === undefined) throw new Error("MergeBox has no container");
    const image = () => {
      const named = container.images[IMAGE];
      if (named === undefined) throw new Error(`MergeBox has no image named ${IMAGE}`);
      return named;
    };
    return {
      get running() {
        return container.running;
      },
      start: (env) =>
        container.start({ image: image(), enableInternet: false, instance: "standard-1", env }),
      // A box still starting reads an empty image: it is the one just asked for.
      stale: async () => {
        const info = await container.inspect();
        return info !== null && info.image !== "" && info.image !== image();
      },
      destroy: () => container.destroy(),
      intercept: () => this.intercept(artifactsHost),
      exec: async (argv, env) => {
        const proc = await container.exec([...argv], { env });
        const out = await proc.output();
        const text = new TextDecoder();
        return {
          exitCode: out.exitCode,
          stdout: text.decode(out.stdout),
          stderr: text.decode(out.stderr),
        };
      },
    };
  }

  private get canaries(): CanaryStore {
    return {
      get: () => this.ctx.storage.kv.get<string>(CANARY),
      set: (canary) =>
        canary === undefined
          ? void this.ctx.storage.kv.delete(CANARY)
          : this.ctx.storage.kv.put(CANARY, canary),
    };
  }

  /** The egress on the Artifacts host, and the deny-all under it for every other host. */
  private async intercept(artifactsHost: string): Promise<void> {
    const container = this.ctx.container;
    if (container === undefined) throw new Error("MergeBox has no container");
    const project = projectOf(this.ctx.id.name);
    await container.interceptOutboundHttps(
      artifactsHost,
      this.ctx.exports.MergeBoxEgress({ props: { project } }),
    );
    await container.interceptOutboundHttps("*", this.ctx.exports.MergeBoxDeny({ props: {} }));
    await container.interceptAllOutboundHttp(this.ctx.exports.MergeBoxDeny({ props: {} }));
  }

  private host<A, E>(program: (host: (typeof CodeHost)["Service"]) => Effect.Effect<A, E>) {
    return Effect.runPromise(
      CodeHost.use(program).pipe(Effect.orDie, Effect.provide(codeHostLayer(this.env))),
    );
  }

  /** Composes one batch's trees in the box; a project's composes run one after another. */
  async compose(request: unknown): Promise<typeof BoxComposeAnswer.Encoded> {
    const run = this.queue.then(() => this.composeNow(request));
    this.queue = run.catch(() => undefined);
    return encodeAnswer(await run);
  }

  private async composeNow(request: unknown): Promise<BoxComposeAnswer> {
    const decoded = decodeRequest(request);
    if (decoded._tag === "Failure")
      return { kind: "unsupported", reason: "a compose of a version this box does not know" };
    const job = decoded.value;
    const repos = [job.staging, ...job.members.map((m) => m.repo)];
    const remotes = await Promise.all(repos.map((repo) => this.host((h) => h.info(repo))));
    const urls = remotes.map((info) => new URL(info.remote));
    const pathOf = (i: number) => urls[i]?.pathname ?? "";
    const host = urls[0]?.hostname ?? "";
    this.composing = {
      scope: { staging: pathOf(0), reads: new Set(urls.map((_, i) => pathOf(i))) },
      repos: new Map(repos.map((repo, i) => [pathOf(i), repo])),
      minted: [],
    };
    try {
      const box = this.box(host);
      const startMs = await readyBox(box, this.canaries);
      const canary = this.canaries.get() ?? "";
      const remoteOf = (i: number) => remotes[i]?.remote ?? "";
      const composing = this.composing;
      const answer = await composeInBox(
        box,
        canary,
        {
          candidateId: job.candidateId,
          staging: remoteOf(0),
          base: job.base,
          members: job.members.map((m, i) => ({
            remote: remoteOf(i + 1),
            base: m.base,
            head: m.head,
          })),
        },
        () => composing.minted,
        startMs,
      );
      await this.ctx.container?.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      const line = `mergebox ${job.candidateId}: ${answer.kind}${"timings" in answer ? ` ${JSON.stringify(answer.timings)}` : ""}${"boxCheck" in answer ? ` check ${JSON.stringify(answer.boxCheck)}` : ""}`;
      if (answer.kind === "check-failed") console.error(`DEFECT ${line}: ${answer.reason}`);
      else console.log(line);
      return answer;
    } finally {
      this.composing = undefined;
    }
  }

  /** A token for one outbound request of the box, asked by MergeBoxEgress (`grantFor`). */
  async mintFor(ask: { readonly url: string; readonly method: string }): Promise<EgressGrant> {
    return grantFor(ask, this.composing, async (repo, access) => {
      const minted = await this.host((h) => h.mintToken(repo, access, TOKEN_TTL_SECONDS));
      return minted.token;
    });
  }
}

/**
 * The box's way to the Artifacts host: each request is asked of the box's
 * object, which mints a fresh token for a repo of the running compose or
 * refuses it. The box's own Authorization header is dropped either way.
 */
export class MergeBoxEgress extends WorkerEntrypoint<Env, { readonly project: string }> {
  override async fetch(request: Request): Promise<Response> {
    const box = this.env.MERGEBOX.get(
      this.env.MERGEBOX.idFromName(`mergebox:${this.ctx.props.project}`),
    );
    return egressForward(
      request,
      (ask) => box.mintFor(ask),
      (forwarded) => fetch(forwarded),
    );
  }
}

/** Every other host the box tries, over HTTPS or HTTP: refused. */
export class MergeBoxDeny extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return new Response(
      `refused: the box reaches only Artifacts (${new URL(request.url).hostname})`,
      {
        status: 403,
      },
    );
  }
}
