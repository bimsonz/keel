import { DurableObject } from "cloudflare:workers";
import {
  KeelClient,
  generateAgentKey,
  signUp,
  signerFromJwk,
  type AgentSigner,
} from "@keeltown/sdk";
import { keelOrigin } from "../../../env.ts";

/** The account a keyring holds: what may be said about it. Never its key. */
export interface Member {
  readonly agentId: string;
  readonly handle: string;
  readonly name: string;
}

/** The settings the swarm sets on a project it owns: who may read it, and whether its lane verifies. */
export interface SettingsChange {
  readonly visibility?: "public" | "private" | undefined;
  readonly verification?: "required" | "off" | undefined;
}

/** Keel's two doors: its API, and its MCP endpoint. Each refuses the other's token. */
export type Door = "api" | "mcp";

export interface Scope {
  readonly project: string;
  /** The run's label: one label is one run, across restarts. */
  readonly run: string;
}

/**
 * One agent account's key, and the only place it is held. The keyring makes
 * the key, signs the account up with it and keeps its private half in its own
 * storage; it answers bearer tokens and what Keel says, never the key. Wiped
 * by `forget`, after which the account idles out on Keel's unvouched tier.
 */
export class Keyring extends DurableObject<Env> {
  #signer: Promise<AgentSigner> | undefined;
  readonly #clients = new Map<string, KeelClient>();

  /** Makes the key once and signs up with it; signing up again with one key answers the same account. */
  async enlist(name: string): Promise<Member & { readonly created: boolean }> {
    const held = await this.ctx.storage.get("key");
    let signer: AgentSigner;
    if (held === undefined) {
      const made = await generateAgentKey();
      await this.ctx.storage.put("key", made.privateJwk);
      signer = made.signer;
      this.#signer = Promise.resolve(signer);
    } else {
      signer = await this.#key();
    }
    const account = await signUp({ baseUrl: keelOrigin(this.env), signer, name });
    const member: Member = { agentId: account.agentId, handle: account.handle, name };
    await this.ctx.storage.put("member", member);
    return { ...member, created: account.created };
  }

  async describe(): Promise<Member | null> {
    return (await this.ctx.storage.get<Member>("member")) ?? null;
  }

  /** A five-minute bearer for one project and one run, at Keel's MCP door: a worker's only way in. */
  async token(scope: Scope): Promise<string> {
    return (await this.#client(scope, "mcp")).token();
  }

  /** Accepts the account's invitation to `project`; answers the invitation's state after. */
  async accept(project: string): Promise<string> {
    const own = await this.#own();
    const invitations = await own.projectInvitations();
    const invitation = invitations.items.find((i) => i.project.id === project);
    if (invitation === undefined) return "none";
    if (invitation.state !== "invited") return invitation.state;
    await own.acceptProjectInvitation(project);
    return "joined";
  }

  /** Makes a project in the account's own namespace from the fixture's template: an agent may own a project. */
  async ownProject(name: string): Promise<{ readonly id: string; readonly name: string }> {
    const member = await this.#member();
    const project = await (
      await this.#own()
    ).createProject({
      namespace: member.handle,
      name,
      source: { kind: "template", name: "fixture-forge-lite" },
    });
    return { id: project.id, name: `${member.handle}/${project.name}` };
  }

  /** Changes a project the account owns, keeping every setting not named: the owner's call, as on any project. */
  async configure(project: string, change: SettingsChange): Promise<SettingsChange> {
    const client = await this.#client({ project, run: "settings" }, "api");
    const settings = await client.settings(project);
    const set = await client.putSettings(project, {
      ...settings,
      protectedPaths: [...settings.protectedPaths],
      ...(change.visibility === undefined ? {} : { visibility: change.visibility }),
      ...(change.verification === undefined ? {} : { verification: change.verification }),
    });
    return { visibility: set.visibility, verification: set.verification };
  }

  /** Trunk's head on a project the account may read, or undefined while it has none. */
  async head(project: string): Promise<string | undefined> {
    const client = await this.#client({ project, run: "settings" }, "api");
    return (await client.commits(project, { limit: 1 })).items[0]?.sha;
  }

  /** One page of the project's events from `cursor`, oldest first, as JSON: its records hold values RPC can't name. */
  async events(
    scope: Scope & { readonly cursor?: string },
  ): Promise<{ readonly page: string; readonly count: number; readonly cursor: string }> {
    const client = await this.#client(scope, "api");
    const page = await client.events({
      project: scope.project,
      limit: 500,
      ...(scope.cursor === undefined ? {} : { cursor: scope.cursor }),
    });
    return { page: JSON.stringify(page.items), count: page.items.length, cursor: page.nextCursor };
  }

  /** Wipes the key and everything else this keyring holds. */
  async forget(): Promise<void> {
    this.#clients.clear();
    this.#signer = undefined;
    await this.ctx.storage.deleteAll();
  }

  async #member(): Promise<Member> {
    const member = await this.describe();
    if (member === null) throw new Error("This keyring holds no account yet: enlist it first.");
    return member;
  }

  #key(): Promise<AgentSigner> {
    this.#signer ??= this.ctx.storage.get("key").then((jwk) => {
      if (jwk === undefined) throw new Error("This keyring holds no key.");
      return signerFromJwk(jwk);
    });
    return this.#signer;
  }

  /** The account's own client, for its invitations: a token for its own namespace. */
  async #own(): Promise<KeelClient> {
    const member = await this.#member();
    return new KeelClient({
      baseUrl: keelOrigin(this.env),
      agentId: member.agentId,
      key: await this.#key(),
    });
  }

  /**
   * One client per project, run and door, kept while the object lives, so a
   * token is minted about every five minutes and not per call. The MCP door's
   * is a plain bearer, handed to Flue's MCP client, which cannot sign proofs.
   */
  async #client(scope: Scope, door: Door): Promise<KeelClient> {
    const id = `${scope.project}|${scope.run}|${door}`;
    const kept = this.#clients.get(id);
    if (kept !== undefined) return kept;
    const member = await this.#member();
    const origin = keelOrigin(this.env);
    const client = new KeelClient({
      baseUrl: origin,
      agentId: member.agentId,
      key: await this.#key(),
      project: scope.project,
      run: scope.run,
      ...(door === "mcp" ? { resource: `${origin}/mcp`, bound: false } : {}),
    });
    this.#clients.set(id, client);
    return client;
  }
}
