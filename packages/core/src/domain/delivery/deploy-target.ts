import { Result } from "effect";
import type { ProjectId, UserId } from "../kernel/index.ts";
import type { DeployTarget, DeployTargetName } from "./deployment.ts";
import { DeployTargetRefused } from "./errors.ts";
import { DeployTargetCleared, DeployTargetSet } from "./events.ts";

/** The most deploy targets a project holds. */
export const MAX_DEPLOY_TARGETS = 16;

export interface SetDeployTarget {
  readonly projectId: ProjectId;
  readonly target: DeployTarget;
  /** The owner setting it; the doorway decides `Delivery_putDeployTarget`. */
  readonly by: UserId;
  /** Whether the target's credential is in the store of the project's org, read by the caller. */
  readonly credentialInOrg: boolean;
}

export interface ClearDeployTarget {
  readonly projectId: ProjectId;
  readonly name: DeployTargetName;
  readonly by: UserId;
}

const named = (
  targets: readonly DeployTarget[],
  name: DeployTargetName,
): DeployTarget | undefined => targets.find((target) => target.name === name);

const same = (a: DeployTarget, b: DeployTarget): boolean =>
  a.name === b.name &&
  a.provider === b.provider &&
  a.accountId === b.accountId &&
  a.credential === b.credential;

/**
 * Sets a project's deploy target, new or in place of the one of its name. A
 * target may name only a credential of the project's own org, so no project
 * deploys with another org's secret. Setting a target to what it already is
 * commits nothing, and a name beyond the project's cap is refused; replacing
 * one at the cap is not.
 */
export const setDeployTarget = (
  targets: readonly DeployTarget[],
  command: SetDeployTarget,
): Result.Result<readonly (typeof DeployTargetSet.Type)[], DeployTargetRefused> => {
  const { target } = command;
  if (!command.credentialInOrg)
    return Result.fail(
      new DeployTargetRefused({ name: target.name, reason: "credential-not-in-org" }),
    );
  const current = named(targets, target.name);
  if (current !== undefined && same(current, target)) return Result.succeed([]);
  if (current === undefined && targets.length >= MAX_DEPLOY_TARGETS)
    return Result.fail(new DeployTargetRefused({ name: target.name, reason: "too-many-targets" }));
  return Result.succeed([
    DeployTargetSet.make({ projectId: command.projectId, target, by: command.by }),
  ]);
};

/** Clears the project's deploy target of that name; refused when none is set. */
export const clearDeployTarget = (
  targets: readonly DeployTarget[],
  command: ClearDeployTarget,
): Result.Result<readonly [typeof DeployTargetCleared.Type], DeployTargetRefused> =>
  named(targets, command.name) === undefined
    ? Result.fail(new DeployTargetRefused({ name: command.name, reason: "not-set" }))
    : Result.succeed([
        DeployTargetCleared.make({
          projectId: command.projectId,
          name: command.name,
          by: command.by,
        }),
      ]);

/** A project's deploy targets after one of its events, one a name, in name order. */
export const evolveDeployTargets = (
  targets: readonly DeployTarget[],
  event: typeof DeployTargetSet.Type | typeof DeployTargetCleared.Type,
): readonly DeployTarget[] => {
  const name = event._tag === "DeployTargetSet" ? event.target.name : event.name;
  const others = targets.filter((target) => target.name !== name);
  const next = event._tag === "DeployTargetSet" ? [...others, event.target] : others;
  return next.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/**
 * The target a repo's `.keel/deploy` names, as `Deployer.plan` takes it: the
 * whole record as it stands now, so a target set again later does not move a
 * plan already made.
 */
export const resolveDeployTarget = (
  targets: readonly DeployTarget[],
  name: DeployTargetName,
): Result.Result<DeployTarget, DeployTargetRefused> => {
  const target = named(targets, name);
  return target === undefined
    ? Result.fail(new DeployTargetRefused({ name, reason: "not-set" }))
    : Result.succeed(target);
};
