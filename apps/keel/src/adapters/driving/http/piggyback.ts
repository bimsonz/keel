import { isBootstrap } from "@keeltown/core/domain/identity";
import { Notifier } from "@keeltown/core/ports";
import { Effect } from "effect";
import type { Operations } from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import type { ProblemCode } from "./problems.ts";
import type { Runner } from "./run.ts";
import { noticeView } from "../notices.ts";

type Operation = keyof Operations<Caller>;
type Answer<K extends Operation> = Awaited<ReturnType<Operations<Caller>[K]>>;
type Success<K extends Operation> = Extract<Answer<K>, { readonly status: 200 | 201 | 202 }>;

/** The operations that answer with the agent envelope: every success body carries `notices`. */
type EnvelopedOperation = {
  [K in Operation]: [Success<K>] extends [never]
    ? never
    : Success<K> extends { readonly body: { readonly notices: readonly unknown[] } }
      ? K
      : never;
}[Operation];

/**
 * Every enveloped operation, and only those: the type requires each key, so a
 * spec change that adds one fails to compile until it is listed here.
 */
const ENVELOPED: Readonly<Record<EnvelopedOperation, true>> = {
  whoami: true,
  declare: true,
  revise: true,
  rely: true,
  nearby: true,
  abandon: true,
  adopt: true,
  rebase: true,
  sketch: true,
  submit: true,
  status: true,
  resolve: true,
  why: true,
  inbox: true,
};

/** The most notices one response carries (the envelope's `notices`, `@maxItems(3)`). */
const MAX_NOTICES = 3;

/** Problems that report a defect, not a refusal: notices never ride them. */
const DEFECTS: ReadonlySet<string> = new Set([
  "internal.defect",
  "service.not_implemented",
  "service.unavailable",
] satisfies ProblemCode[]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A response notices may ride: a success envelope, or a typed refusal. */
function ridable(answer: unknown): answer is { readonly body: Readonly<Record<string, unknown>> } {
  if (!isRecord(answer) || !isRecord(answer.body)) return false;
  const { code, notices } = answer.body;
  if (Array.isArray(notices)) return true;
  return typeof code === "string" && !DEFECTS.has(code);
}

/**
 * The piggyback: once an enveloped operation's answer is known, success or
 * typed refusal, up to 3 notices the agent has not seen ride it. They are
 * taken after the answer, never alongside it, and never for a defect. Taking
 * is at most once (the AgentSession marks them carried before the response
 * leaves), so a failed take answers without notices: the inbox still has them.
 * One wrapper at the handler object covers REST and MCP alike.
 */
export function piggyback<H extends Operations<Caller>>(run: Runner, handlers: H): H {
  return new Proxy(handlers, {
    get(target, operation, receiver) {
      const handler: unknown = Reflect.get(target, operation, receiver);
      if (
        typeof operation !== "string" ||
        typeof handler !== "function" ||
        !Object.hasOwn(ENVELOPED, operation)
      )
        return handler;
      return async (caller: Caller, ...rest: readonly unknown[]) => {
        const answer: unknown = await Reflect.apply(handler, target, [caller, ...rest]);
        const { principal } = caller;
        if (principal === null || isBootstrap(principal) || !ridable(answer)) return answer;
        const taken = await run(
          caller,
          Notifier.use((notifier) => notifier.take(principal.agentId, MAX_NOTICES)).pipe(
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logWarning("piggyback: no notices taken", {
                  requestId: caller.requestId,
                  cause,
                }),
                [],
              ),
            ),
          ),
        );
        // A take the client's abort interrupted answers as a 503; the answer still leaves without notices.
        const notices = "status" in taken ? [] : taken.map(noticeView);
        if (notices.length === 0 && !Array.isArray(answer.body.notices)) return answer;
        return { ...answer, body: { ...answer.body, notices } };
      };
    },
  });
}
