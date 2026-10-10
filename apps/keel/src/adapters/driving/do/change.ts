import { NotImplemented } from "@keeltown/core/not-implemented";
import { Effect } from "effect";
import { type ChangeServices, changeServices } from "../../../composition/do.ts";
import {
  type AbandonCommand,
  type AdoptCommand,
  ChangeCodecs,
  type ChangeRpc,
  type DeclareCommand,
  type PlanCompiledCommand,
  type PrecheckRefusedCommand,
  type PrecheckStartedCommand,
  type ReviseCommand,
  type SubmitCommand,
} from "../../../rpc/index.ts";
import { KeelObjectWith } from "./keel-object.ts";

/** A method not built yet: it crosses as a NotImplemented defect, which the HTTP doorway answers as 503. */
const pending = (op: string) => Effect.die(new NotImplemented(`coordination/${op}`));

/**
 * The Change DO (`change:<ULID>`): a change and its lease, decided by the
 * domain's Change machine. Every method answers with an Exit envelope;
 * each stub is replaced as it lands.
 */
export class ChangeDO extends KeelObjectWith<ChangeServices> implements ChangeRpc {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, changeServices(env));
  }

  async get() {
    return this.answer(ChangeCodecs.get, pending("getChange"));
  }

  async declare(_command: typeof DeclareCommand.Encoded) {
    return this.answer(ChangeCodecs.declare, pending("declare"));
  }

  async revise(_command: typeof ReviseCommand.Encoded) {
    return this.answer(ChangeCodecs.revise, pending("revise"));
  }

  async submit(_command: typeof SubmitCommand.Encoded) {
    return this.answer(ChangeCodecs.submit, pending("submit"));
  }

  async abandon(_command: typeof AbandonCommand.Encoded) {
    return this.answer(ChangeCodecs.abandon, pending("abandon"));
  }

  async adopt(_command: typeof AdoptCommand.Encoded) {
    return this.answer(ChangeCodecs.adopt, pending("adopt"));
  }

  async submission(_waitMs: number) {
    return this.answer(ChangeCodecs.submission, pending("submission"));
  }

  async workspace() {
    return this.answer(ChangeCodecs.workspace, pending("workspace"));
  }

  async precheckStarted(_command: typeof PrecheckStartedCommand.Encoded) {
    return this.answer(ChangeCodecs.precheckStarted, pending("precheckStarted"));
  }

  async precheckRefused(_command: typeof PrecheckRefusedCommand.Encoded) {
    return this.answer(ChangeCodecs.precheckRefused, pending("precheckRefused"));
  }

  async planCompiled(_command: typeof PlanCompiledCommand.Encoded) {
    return this.answer(ChangeCodecs.planCompiled, pending("planCompiled"));
  }
}
