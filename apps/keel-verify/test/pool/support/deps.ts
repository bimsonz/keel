import { DurableObject, env } from "cloudflare:workers";
import { sha256Hex } from "@keeltown/runner-protocol";
import { KeelDepsBox } from "../../../src/adapters/driving/do/keel-deps-box.ts";

/**
 * KeelDepsBox's outbound handlers, read when this module loads: the table is
 * a static of the real base, out of reach once the class stands over
 * `NoContainer`.
 */
const HANDLERS = KeelDepsBox.outboundByHost ?? {};

/** The hosts a deps box has a handler for, in the order the proxy tries them. */
export const BOX_HOSTS: readonly string[] = Object.keys(HANDLERS);

const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replaceAll(".", "\\."))
      .join(".*")}$`,
  );

/**
 * One request leaving a deps box's container, answered by the handler the
 * containers proxy would pick for its host (exact match, then the first
 * matching glob) and told which container it left.
 */
export async function fromBox(
  containerId: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const host = new URL(url).hostname;
  const handler =
    HANDLERS[host] ?? Object.entries(HANDLERS).find(([pattern]) => glob(pattern).test(host))?.[1];
  if (handler === undefined) throw new Error(`no outbound handler for ${url}`);
  return handler(new Request(url, init), env, { containerId, className: "KeelDepsBox" });
}

/** What a box's command was started with: the command, its bound, and its whole environment. */
export interface Started {
  readonly command: string;
  readonly timeout: number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** What stands in for one box's container: handed what the command was started with, it answers the command's stdout. */
export type Container = (started: Started) => Promise<string>;

const containers = new Map<string, Container>();
const starts = new Map<string, Started[]>();
const destroys = new Map<string, number>();
const strandings = new Map<string, Error>();

/**
 * The base a KeelDepsBox is constructed over in the pool. The pool runs no
 * container, and the Sandbox base refuses to construct where none is
 * configured, so the object is given this one instead: a Durable Object like
 * the real base, with the two calls a deps box makes of its container.
 * `exec` is answered by the stand-in registered for the object and `destroy`
 * is counted, and fails for a box a case has stranded. Everything KeelDepsBox
 * itself declares runs exactly as deployed.
 */
class NoContainer extends DurableObject<Env> {
  async exec(
    command: string,
    options?: { timeout?: number; env?: Record<string, string | undefined> },
  ): Promise<{ stdout: string }> {
    const id = this.ctx.id.toString();
    const container = containers.get(id);
    if (container === undefined)
      throw new Error("the pool runs no container, and none stands in for this box");
    const started: Started = { command, timeout: options?.timeout, env: options?.env ?? {} };
    starts.set(id, [...(starts.get(id) ?? []), started]);
    return { stdout: await container(started) };
  }

  async destroy(): Promise<void> {
    const id = this.ctx.id.toString();
    destroys.set(id, (destroys.get(id) ?? 0) + 1);
    const stranding = strandings.get(id);
    if (stranding !== undefined) throw stranding;
  }
}

/**
 * Puts KeelDepsBox over `NoContainer` until the returned function is called.
 * `super` resolves when a constructor runs, so every object the pool makes in
 * between is built over the stand-in base, its own fields and methods as
 * deployed.
 */
export function withoutContainers(): () => void {
  const base = Reflect.getPrototypeOf(KeelDepsBox);
  const baseProto = Reflect.getPrototypeOf(KeelDepsBox.prototype);
  Reflect.setPrototypeOf(KeelDepsBox, NoContainer);
  Reflect.setPrototypeOf(KeelDepsBox.prototype, NoContainer.prototype);
  return () => {
    Reflect.setPrototypeOf(KeelDepsBox, base);
    Reflect.setPrototypeOf(KeelDepsBox.prototype, baseProto);
  };
}

/** One deps box, by the name its object is reached under. */
export interface Box {
  /** The object's id, which is the container id the proxy hands a handler. */
  readonly id: string;
  readonly stub: DurableObjectStub<KeelDepsBox>;
  /** Stands `container` in for this box's container from now on. */
  readonly runs: (container: Container) => void;
  /** Every time this box's command was started, in order. */
  readonly started: () => readonly Started[];
  /** How many times this box's container was destroyed, or was asked to be. */
  readonly destroyed: () => number;
  /** Makes every destroy of this box's container fail with `error` from now on. */
  readonly strands: (error: Error) => void;
}

export function boxNamed(name: string): Box {
  const id = env.DEPSBOX.idFromName(name);
  const key = id.toString();
  return {
    id: key,
    stub: env.DEPSBOX.get(id),
    runs: (container) => void containers.set(key, container),
    started: () => starts.get(key) ?? [],
    destroyed: () => destroys.get(key) ?? 0,
    strands: (error) => void strandings.set(key, error),
  };
}

/** A part as a build names it: its own sha256 and its length. */
export interface Part {
  readonly sha256: string;
  readonly bytes: number;
}

export const partOf = async (bytes: Uint8Array): Promise<Part> => ({
  sha256: await sha256Hex(bytes),
  bytes: bytes.byteLength,
});

/** A box's `PUT <path>` to the upload host, as its command's curl sends a part. */
export const put = (
  containerId: string,
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fromBox(containerId, `http://deps.keel.internal${path}`, { method: "PUT", body, headers });

/** The toolchain the image states, as the box prints it. */
export const TOOLCHAIN = "node v22.22.3 pnpm 11.18.0 ubuntu 24.04";

/** A deps box's report of a finished build, as its command prints it. */
export const reportOf = (parts: readonly Part[], toolchain: string = TOOLCHAIN): string =>
  [
    "KEEL_DEPS_BUILD/1",
    `KEEL_TOOLCHAIN ${toolchain}`,
    "KEEL_FILES 1735",
    "KEEL_INSTALL_MS 5000",
    `KEEL_PARTS ${parts.map((part) => `${part.sha256}:${part.bytes}`).join(",")}`,
    "KEEL_BUILD ok",
    "KEEL_END",
    "",
  ].join("\n");

/** A deps box's report of a build it would not make. */
export const refusalOf = (reason: string): string =>
  [
    "KEEL_DEPS_BUILD/1",
    `KEEL_TOOLCHAIN ${TOOLCHAIN}`,
    `KEEL_BUILD refused ${reason}`,
    "KEEL_END",
    "",
  ].join("\n");

/** The pointer a namespace keeps for an install digest, as stored, or null. */
export async function pointerAt(namespace: string, install: string): Promise<unknown> {
  const object = await env.BUNDLES.get(`ns/${namespace}/deps/${install}`);
  return object === null ? null : JSON.parse(await object.text());
}

/** The JSON log lines carrying `event`, as plain objects for `toMatchObject`. */
export const logged = (spy: { mock: { calls: unknown[][] } }, event: string): unknown[] =>
  spy.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string") return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" &&
        parsed !== null &&
        "event" in parsed &&
        parsed.event === event
        ? [parsed]
        : [];
    } catch {
      return [];
    }
  });
