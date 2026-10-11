/** Where Keel serves its OpenAPI document: under /v1, which keel.town routes to Keel ahead of the console. */
export const DOCUMENT_PATH = "/v1/openapi.json";

export interface DocumentCheck {
  readonly ok: boolean;
  readonly what: string;
  readonly detail: { readonly status: number; readonly contentType: string | null };
}

/**
 * The document is reachable at the deployed host and is the document itself:
 * a 200 alone could be the console's page, which answers every path it does
 * not know.
 */
export async function documentSmoke(keelUrl: string): Promise<DocumentCheck> {
  const response = await fetch(`${keelUrl}${DOCUMENT_PATH}`);
  const contentType = response.headers.get("content-type");
  let openapi: unknown;
  try {
    openapi = Reflect.get(Object(await response.json()), "openapi");
  } catch {
    openapi = undefined;
  }
  return {
    ok:
      response.status === 200 &&
      /^application\/json\b/.test(contentType ?? "") &&
      typeof openapi === "string",
    what: `${DOCUMENT_PATH} answers the OpenAPI document as JSON`,
    detail: { status: response.status, contentType },
  };
}
