import { makeId } from "@keeltown/core/kernel";
import { Deployer, type DeployPlan } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";

/** Every lifecycle step succeeds and is recorded, so tests can assert the order. */
export function makeDeployerMemory() {
  const steps: { readonly operation: string; readonly plan: DeployPlan }[] = [];
  let counter = 0;
  const step = (operation: "preview" | "verify" | "promote" | "rollback" | "teardown") => (plan: DeployPlan) =>
    Effect.sync(() => {
      steps.push({ operation, plan });
      return { deploymentId: plan.deploymentId, operation, ok: true, detail: `${operation} recorded in memory` };
    });
  return {
    steps,
    layer: Layer.succeed(
      Deployer,
      Deployer.of({
        plan: (target, bundle, world) =>
          Effect.sync(() => {
            counter += 1;
            return { deploymentId: makeId("dpl", counter.toString().padStart(26, "0")), target, bundle, world };
          }),
        preview: step("preview"),
        verify: step("verify"),
        promote: (plan) => step("promote")(plan),
        rollback: step("rollback"),
        teardown: step("teardown"),
      }),
    ),
  };
}
