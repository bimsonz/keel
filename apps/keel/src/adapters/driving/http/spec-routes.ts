import { openApiDocument } from "@keeltown/contracts";

/**
 * Where the published document puts an operation, under the API's base path:
 * `/v1/oauth/register` for `Auth_registerClient`. What Keel tells an arriving
 * agent about its own routes is read from the spec, never written twice.
 */
export function specRoute(operationId: string): string {
  const [server] = openApiDocument.servers ?? [];
  const base = server?.url ?? "";
  for (const [path, item] of Object.entries(Object(openApiDocument.paths)))
    for (const operation of Object.values(Object(item)))
      if (Reflect.get(Object(operation), "operationId") === operationId) return `${base}${path}`;
  throw new Error(`the published document has no operation ${operationId}`);
}
