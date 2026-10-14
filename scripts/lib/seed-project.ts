// A project the seed declares (scripts/seed.ts), read before it is created. The
// create carries the Idempotency-Key `seed:<env>:project:<name>`, and the
// request an earlier seed stored under that key is that run's body: once the
// request's shape has moved on, Keel refuses the key for a different project,
// and a create under any other key would make a second one. So a project Keel
// already holds is kept, and its create is never sent again. Held by
// packages/tooling/test/seed-project.test.ts.
import { type KeelClient, KeelProblem } from "../../packages/sdk/src/index.ts";

/** The project the seed holds, and whether an earlier run made it. */
export interface SeededProject {
  readonly id: string;
  readonly existed: boolean;
}

/**
 * The project `request` names, read by its namespace and name: the one already
 * there, or else one created under `idempotencyKey`. Only a read Keel answers
 * 404 creates it; any other refusal throws, as the seed's other calls do.
 */
export async function seedProject(
  by: KeelClient,
  request: Parameters<KeelClient["createProject"]>[0],
  idempotencyKey: string,
): Promise<SeededProject> {
  try {
    const existing = await by.project(request.namespace, request.name);
    return { id: existing.id, existed: true };
  } catch (error) {
    if (!(error instanceof KeelProblem) || error.status !== 404) throw error;
  }
  const created = await by.createProject(request, { idempotencyKey });
  return { id: created.id, existed: false };
}
