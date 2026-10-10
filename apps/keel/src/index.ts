import { consumeQueue } from "./adapters/driving/queue/consumer.ts";
import { isolateFor } from "./composition/isolate.ts";

export { AgentSessionDO } from "./adapters/driving/do/agent-session.ts";
export { ChangeDO } from "./adapters/driving/do/change.ts";
export { LaneDO } from "./adapters/driving/do/lane.ts";
export { ProjectDO } from "./adapters/driving/do/project.ts";
export { ProjectorDO } from "./adapters/driving/do/projector.ts";
export { SubjectDO } from "./adapters/driving/do/subject.ts";
export { TrunkDO } from "./adapters/driving/do/trunk.ts";
export { WorkspacePoolDO } from "./adapters/driving/do/workspace-pool.ts";
export { BoxGate } from "./adapters/driving/do/boxgate.ts";
export { MergeBox } from "./adapters/driving/do/mergebox.ts";
export { KeelVerify } from "./adapters/driving/workflow/keel-verify.ts";
export { Precheck } from "./adapters/driving/workflow/precheck.ts";
export { PushObserved } from "./adapters/driving/workflow/push-observed.ts";

export default {
  fetch(request, env, ctx): Response | Promise<Response> {
    return isolateFor(env).app.fetch(request, env, ctx);
  },
  queue(batch, env, _ctx): Promise<void> {
    return consumeQueue(batch, isolateFor(env).runtime);
  },
} satisfies ExportedHandler<Env>;
