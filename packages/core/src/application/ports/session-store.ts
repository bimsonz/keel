import { Context, type Effect } from "effect";
import type { SessionId } from "../../domain/kernel/index.ts";
import type { SessionNotFound } from "../../domain/memory/index.ts";

export interface SessionMessage {
  readonly seq: number;
  readonly role: string;
  readonly text: string;
}

/** Session transcripts: immutable messages addressed by number. */
export class SessionStore extends Context.Service<SessionStore, {
  readonly append: (sessionId: SessionId, messages: readonly SessionMessage[]) => Effect.Effect<void>;
  readonly read: (sessionId: SessionId, fromSeq: number, toSeq: number) => Effect.Effect<readonly SessionMessage[], SessionNotFound>;
}>()("keel/SessionStore") {}
