import { consumeQueue } from "./adapters/driving/queue/consumer.ts";
import { queueRuntime } from "./composition/queue.ts";
import { enforceRetention } from "./composition/retention.ts";

export { AgentSessionDO } from "./adapters/driving/do/agent-session.ts";
export { ChangeDO } from "./adapters/driving/do/change.ts";
export { LaneDO } from "./adapters/driving/do/lane.ts";
export { NamespaceDO } from "./adapters/driving/do/namespace.ts";
export { NamespaceUsageDO } from "./adapters/driving/do/namespace-usage.ts";
export { ProjectDO } from "./adapters/driving/do/project.ts";
export { ProjectorDO } from "./adapters/driving/do/projector.ts";
export { SubjectDO } from "./adapters/driving/do/subject.ts";
export { TrunkDO } from "./adapters/driving/do/trunk.ts";
export { WorkspacePoolDO } from "./adapters/driving/do/workspace-pool.ts";
export { BoxGate } from "./adapters/driving/do/boxgate.ts";
export { MergeBox, MergeBoxDeny, MergeBoxEgress } from "./adapters/driving/do/mergebox.ts";
export { Deliver } from "./adapters/driving/workflow/deliver.ts";
export { KeelVerify } from "./adapters/driving/workflow/keel-verify.ts";
export { Precheck } from "./adapters/driving/workflow/precheck.ts";
export { Probe } from "./adapters/driving/workflow/probe.ts";
export { KeelWorldCheck } from "./adapters/driving/workflow/world-check.ts";
export { PushObserved } from "./adapters/driving/workflow/push-observed.ts";

export default {
  // The HTTP side loads on the first request, not with the Worker: Cloudflare gives a Worker's global scope a
  // second of CPU, and scripts/guard-startup.ts fails the build when it is reached as the Worker loads.
  fetch(request, env, ctx): Response | Promise<Response> {
    return import("./composition/isolate.ts").then(({ isolateFor }) =>
      isolateFor(env).app.fetch(request, env, ctx),
    );
  },
  queue(batch, env, _ctx): Promise<void> {
    return consumeQueue(batch, queueRuntime(env));
  },
  scheduled(controller, env, ctx): void {
    ctx.waitUntil(enforceRetention(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
