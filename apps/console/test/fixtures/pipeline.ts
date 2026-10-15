// A log written by hand for the Pipeline: Keel's own events, shaped as its
// contract types them, each at the second the script moves the clock to. The
// tests of the flow, the canvas and its layout say what happens and when; this
// writes the events and plays them into a World, as the console does.

import type { RunRef } from "../../src/contract/keel/index.ts";
import { World } from "../../src/engine/world.ts";
import { ScriptBuilder } from "./mock/builder.ts";
import { createRng } from "./prng.ts";

export const PROJECT = "prj_1";
export const LANE = `lane:${PROJECT}:main`;

const change = (id: string) => ({ kind: "change" as const, id });
const batch = (id: string) => ({ kind: "batch" as const, id });
const TRUNK = { kind: "trunk" as const, id: PROJECT };

export class Hand {
  readonly b = new ScriptBuilder("2026-10-15T09:00:00.000Z", createRng(11));

  /** Moves the clock to this second of the log. */
  at(seconds: number): this {
    this.b.at(seconds);
    return this;
  }

  enrol(agentId: string, name: string): this {
    this.b.emit({
      type: "AgentEnrolled",
      entity: { kind: "agent", id: agentId },
      payload: { agentId, projectId: PROJECT, name, kind: "hosted", scopes: [] },
    });
    return this;
  }

  /** The run an agent's token names on what it declares from here on. */
  runOf(agentId: string, run: RunRef): this {
    this.b.runOf(agentId, run);
    return this;
  }

  declare(id: string, given: { paths?: string[]; agentId?: string; label?: string } = {}): this {
    this.b.emit({
      type: "IntentDeclared",
      entity: change(id),
      ...(given.label === undefined ? {} : { label: given.label }),
      payload: {
        changeId: id,
        agentId: given.agentId ?? "agt_1",
        origin: "agent",
        revision: 1,
        goal: `goal of ${id}`,
        footprint: (given.paths ?? []).map((path) => ({ path, op: "edit" as const })),
        premises: [],
        leaseId: `lse_${id}`,
      },
    });
    return this;
  }

  revise(id: string, revision: number, paths?: string[]): this {
    this.b.emit({
      type: "IntentRevised",
      entity: change(id),
      payload: {
        changeId: id,
        revision,
        ...(paths === undefined
          ? {}
          : { footprint: paths.map((path) => ({ path, op: "edit" as const })) }),
        premisesAdded: [],
        premisesRetracted: [],
      },
    });
    return this;
  }

  start(id: string, baseSha?: string): this {
    this.b.emit({
      type: "ChangeStarted",
      entity: change(id),
      payload: {
        changeId: id,
        workspaceId: `ws_${id}`,
        ...(baseSha === undefined ? {} : { baseSha }),
      },
    });
    return this;
  }

  submit(id: string, revision = 1, baseSha?: string): this {
    this.b.emit({
      type: "ChangeSubmitted",
      entity: change(id),
      payload: {
        changeId: id,
        revision,
        commitSha: `c-${id}-${revision}`,
        workspaceId: `ws_${id}`,
        ...(baseSha === undefined ? {} : { baseSha }),
      },
    });
    return this;
  }

  precheck(id: string, revision = 1): this {
    this.b.emit({
      type: "PrecheckStarted",
      entity: change(id),
      payload: { changeId: id, revision, instanceId: `pre-${id}-${revision}` },
    });
    return this;
  }

  derive(id: string, paths?: string[], revision = 1): this {
    this.b.emit({
      type: "EffectsDerived",
      entity: change(id),
      payload: {
        changeId: id,
        revision,
        effects: [],
        derivationRef: `drv-${id}-${revision}`,
        ...(paths === undefined ? {} : { paths }),
      },
    });
    return this;
  }

  rebase(id: string, from: string, to: string): this {
    this.b.emit({ type: "ChangeRebased", entity: change(id), payload: { changeId: id, from, to } });
    return this;
  }

  queue(id: string): this {
    this.b.emit({
      type: "ChangeQueued",
      entity: change(id),
      payload: { changeId: id, laneId: LANE },
    });
    return this;
  }

  requeue(
    id: string,
    batchId: string,
    reason: "infra-failure" | "bisection" | "invalidated" | "co-member-failed",
  ): this {
    this.b.emit({
      type: "ChangeRequeued",
      entity: change(id),
      payload: { changeId: id, batchId, reason },
    });
    return this;
  }

  batched(id: string, batchId: string): this {
    this.b.emit({ type: "ChangeBatched", entity: change(id), payload: { changeId: id, batchId } });
    return this;
  }

  park(id: string, reason: "awaiting-ruling" | "lease-lapsed", escalationId?: string): this {
    this.b.emit({
      type: "ChangeParked",
      entity: change(id),
      payload: { changeId: id, reason, ...(escalationId === undefined ? {} : { escalationId }) },
    });
    return this;
  }

  resume(id: string): this {
    this.b.emit({
      type: "ChangeResumed",
      entity: change(id),
      payload: { changeId: id, decisionId: "dec_1" },
    });
    return this;
  }

  bounce(
    id: string,
    reasons: string[],
    cause: { verdictId: string } | { conflictId: string },
  ): this {
    this.b.emit({
      type: "ChangeBounced",
      entity: change(id),
      payload: { changeId: id, reasons, ...cause },
    });
    return this;
  }

  land(id: string, trunkSha: string): this {
    this.b.emit({
      type: "ChangeLanded",
      entity: change(id),
      payload: {
        changeId: id,
        commitSha: `c-${id}`,
        trunkSha,
        candidateId: `cnd_${id}`,
        proofId: `prf_${id}`,
      },
    });
    return this;
  }

  withdraw(id: string): this {
    this.b.emit({
      type: "ChangeWithdrawn",
      entity: change(id),
      payload: { changeId: id, by: "agt_1" },
    });
    return this;
  }

  supersede(id: string, by: string): this {
    this.b.emit({ type: "ChangeSuperseded", entity: change(id), payload: { changeId: id, by } });
    return this;
  }

  /** Each change declared, submitted, prechecked and queued, at the current second. */
  queued(ids: readonly string[], agentId = "agt_1"): this {
    for (const id of ids) this.declare(id, { agentId }).start(id).submit(id).precheck(id).queue(id);
    return this;
  }

  form(
    batchId: string,
    members: string[],
    given: { predecessors?: string[]; attempt?: number; chainEpoch?: number; base?: string } = {},
  ): this {
    this.b.emit({
      type: "BatchFormed",
      entity: batch(batchId),
      payload: {
        batchId,
        laneId: LANE,
        members,
        base: given.base ?? "sha_trunk",
        attempt: given.attempt ?? 1,
        chainEpoch: given.chainEpoch ?? 1,
        ...(given.predecessors === undefined ? {} : { predecessors: given.predecessors }),
      },
    });
    for (const id of members) this.batched(id, batchId);
    return this;
  }

  assemble(batchId: string, tier: 0 | 1 | 2, composer: "gitcore" | "mergebox" = "gitcore"): this {
    this.b.emit({
      type: "CandidateAssembled",
      entity: batch(batchId),
      payload: {
        candidateId: `cnd_${batchId}`,
        batchId,
        treeSha: `tree_${batchId}`,
        composer,
        tier,
        tierReason: "the members touch disjoint paths",
      },
    });
    return this;
  }

  verifying(batchId: string): this {
    this.b.emit({
      type: "VerificationStarted",
      entity: batch(batchId),
      payload: {
        candidateId: `cnd_${batchId}`,
        batchId,
        instanceId: `ver_${batchId}`,
        planHash: `sha256:${batchId}`,
      },
    });
    return this;
  }

  verdict(verdictId: string, subject: string, evidence: string[]): this {
    this.b.emit({
      type: "VerdictIssued",
      entity: { kind: "verdict", id: verdictId },
      payload: { verdictId, subject, outcome: "bounce", evidence },
    });
    return this;
  }

  verified(batchId: string, verified?: boolean): this {
    this.b.emit({
      type: "BatchVerified",
      entity: batch(batchId),
      payload: {
        batchId,
        candidateId: `cnd_${batchId}`,
        verdictId: `vrd_${batchId}`,
        ...(verified === undefined ? {} : { verified }),
      },
    });
    return this;
  }

  failed(batchId: string, attribution: string): this {
    this.b.emit({
      type: "BatchFailed",
      entity: batch(batchId),
      payload: { batchId, candidateId: `cnd_${batchId}`, verdictId: `vrd_${batchId}`, attribution },
    });
    return this;
  }

  bisected(batchId: string, into: string[]): this {
    this.b.emit({
      type: "CandidateBisected",
      entity: batch(batchId),
      payload: { candidateId: `cnd_${batchId}`, batchId, into },
    });
    return this;
  }

  invalidated(batchId: string): this {
    this.b.emit({
      type: "CandidateInvalidated",
      entity: batch(batchId),
      payload: { candidateId: `cnd_${batchId}`, batchId, reason: "head-moved" },
    });
    return this;
  }

  promoted(batchId: string): this {
    this.b.emit({
      type: "CandidatePromoted",
      entity: batch(batchId),
      payload: { candidateId: `cnd_${batchId}`, batchId, trunkSha: `sha_${batchId}` },
    });
    return this;
  }

  promoting(groupId: string, batches: string[], members: string[]): this {
    this.b.emit({
      type: "PromotionStarted",
      entity: TRUNK,
      payload: {
        projectId: PROJECT,
        groupId,
        old: "sha_trunk",
        members,
        batches,
        proofIds: batches.map((id) => `prf_${id}`),
        committerTime: this.b.instant(),
      },
    });
    return this;
  }

  declined(batchId: string, reason: "commutation-failed" | "pack-too-large"): this {
    this.b.emit({
      type: "PromotionDeclined",
      entity: TRUNK,
      payload: { projectId: PROJECT, batchId, reason, reverify: [] },
    });
    return this;
  }

  advance(
    groupId: string,
    to: string,
    changes: string[],
    given: { height?: number; verified?: boolean } = {},
  ): this {
    this.b.emit({
      type: "TrunkAdvanced",
      entity: TRUNK,
      payload: {
        projectId: PROJECT,
        from: "sha_trunk",
        to,
        groupId,
        landings: changes.map((changeId) => ({
          changeId,
          commitSha: `c-${changeId}`,
          candidateId: `cnd_${changeId}`,
          proofId: `prf_${changeId}`,
        })),
        ...(given.height === undefined ? {} : { height: given.height }),
        ...(given.verified === undefined ? {} : { verified: given.verified }),
      },
    });
    return this;
  }

  audit(head: string, outcome: "green" | "red"): this {
    this.b.emit({
      type: "AuditCompleted",
      entity: TRUNK,
      payload: { projectId: PROJECT, head, outcome, suspects: [], runRef: `run_${head}` },
    });
    return this;
  }

  /** A conflict between two changes, suspected and then proven by its probe. */
  proven(conflictId: string, parties: [string, string]): this {
    this.b.emit({
      type: "ConflictSuspected",
      entity: { kind: "conflict", id: conflictId },
      payload: { conflictId, kind: "semantic", parties },
    });
    this.b.emit({
      type: "ConflictProven",
      entity: { kind: "conflict", id: conflictId },
      payload: { conflictId, evidence: { _tag: "probe", probeId: `prb_${conflictId}` } },
    });
    return this;
  }

  /** The log so far, played into a World as the console plays Keel's: up to and including second `until`. */
  world(until = Number.POSITIVE_INFINITY): World {
    const log = this.b.build();
    const world = new World();
    log.events.forEach((event, index) => {
      const t = log.eventTimes[index] ?? 0;
      if (t <= until * 1000) world.apply(event, t);
    });
    return world;
  }
}
