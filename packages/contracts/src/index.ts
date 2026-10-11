/**
 * The published wire contract, generated from packages/spec. `openapi.json` is
 * committed; `document.gen.ts` imports it as a typed value, and
 * `generated/requests.gen.ts` holds every request, response and model as plain
 * TypeScript types with no imports, so a consumer needs nothing else.
 */
export { OPENAPI_DOCUMENT_PATH, openApiDocument } from "./document.gen.ts";
export type * from "./generated/requests.gen.ts";
export { SPEC_VOCABULARIES } from "./generated/vocabularies.gen.ts";
