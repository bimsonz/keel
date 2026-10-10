import type { CollaboratorRole } from "./domain/roles.ts";
import type { Visibility } from "./domain/visibility.ts";

/**
 * Typed events emitted by the store after every successful mutation. Each
 * carries `at`, the clock time of the mutation, in epoch milliseconds.
 */

export interface UserCreated {
  readonly type: "user.created";
  readonly at: number;
  readonly userId: string;
  readonly username: string;
}

export interface SessionCreated {
  readonly type: "session.created";
  readonly at: number;
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: number;
}

export interface SessionEnded {
  readonly type: "session.ended";
  readonly at: number;
  readonly sessionId: string;
  readonly userId: string;
}

export interface RepoCreated {
  readonly type: "repo.created";
  readonly at: number;
  readonly repoId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly visibility: Visibility;
}

export interface RepoUpdated {
  readonly type: "repo.updated";
  readonly at: number;
  readonly repoId: string;
  readonly fields: readonly string[];
}

export interface RepoVisibilityChanged {
  readonly type: "repo.visibility-changed";
  readonly at: number;
  readonly repoId: string;
  readonly from: Visibility;
  readonly to: Visibility;
}

export interface RepoTransferred {
  readonly type: "repo.transferred";
  readonly at: number;
  readonly repoId: string;
  readonly fromOwnerId: string;
  readonly toOwnerId: string;
}

export interface RepoDeleted {
  readonly type: "repo.deleted";
  readonly at: number;
  readonly repoId: string;
  readonly ownerId: string;
  readonly name: string;
}

export interface RefUpdated {
  readonly type: "ref.updated";
  readonly at: number;
  readonly repoId: string;
  readonly ref: string;
  readonly from: string | null;
  readonly to: string;
}

export interface LabelSaved {
  readonly type: "label.saved";
  readonly at: number;
  readonly repoId: string;
  readonly name: string;
  readonly color: string;
}

export interface CollaboratorAdded {
  readonly type: "collaborator.added";
  readonly at: number;
  readonly repoId: string;
  readonly userId: string;
  readonly role: CollaboratorRole;
  readonly addedBy: string;
}

export interface CollaboratorRoleChanged {
  readonly type: "collaborator.role-changed";
  readonly at: number;
  readonly repoId: string;
  readonly userId: string;
  readonly from: CollaboratorRole;
  readonly to: CollaboratorRole;
  readonly changedBy: string;
}

export type DomainEvent =
  | UserCreated
  | SessionCreated
  | SessionEnded
  | RepoCreated
  | RepoUpdated
  | RepoVisibilityChanged
  | RepoTransferred
  | RepoDeleted
  | RefUpdated
  | LabelSaved
  | CollaboratorAdded
  | CollaboratorRoleChanged;

export type EventType = DomainEvent["type"];
export type EventOfType<T extends EventType> = Extract<DomainEvent, { type: T }>;
export type Unsubscribe = () => void;

/** The subscribing half of the bus, which is all most code should see. */
export interface EventSource {
  subscribe<T extends EventType>(type: T, listener: (event: EventOfType<T>) => void): Unsubscribe;
  subscribeAll(listener: (event: DomainEvent) => void): Unsubscribe;
}

/**
 * A synchronous in-process event bus. Listeners run in subscription order,
 * before `emit` returns, so a listener sees the store exactly as the mutation
 * left it. A listener that throws fails the mutation's request.
 */
export class EventBus implements EventSource {
  readonly #listeners = new Set<(event: DomainEvent) => void>();

  subscribe<T extends EventType>(type: T, listener: (event: EventOfType<T>) => void): Unsubscribe {
    return this.subscribeAll((event) => {
      if (event.type === type) listener(event as EventOfType<T>);
    });
  }

  subscribeAll(listener: (event: DomainEvent) => void): Unsubscribe {
    // Wrap so the same function can be subscribed twice and removed once.
    const entry = (event: DomainEvent): void => listener(event);
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  emit(event: DomainEvent): void {
    // Iterate a snapshot: listeners that (un)subscribe during emit take effect next time.
    for (const listener of Array.from(this.#listeners)) listener(event);
  }
}
