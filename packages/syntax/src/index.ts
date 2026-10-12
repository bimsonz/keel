/**
 * Source facts for effect derivation, read from a tree-sitter parse. Text in,
 * facts out: no Effect, no `cloudflare:*`, and the same code in Node and in a
 * Worker. The Wasm modules are handed in compiled; the blobs are handed in
 * read.
 */
export {
  bootParser,
  HEAP_PAGES,
  parseBudget,
  PARSER_VERSION,
  ParserStarting,
  type SourceParser,
  type SyntaxWasm,
} from "./parser.ts";
export {
  DEFAULT_REGISTRARS,
  LIMITS,
  openReading,
  type PathKind,
  type Reading,
  type ReadingResult,
  readTree,
  type Skipped,
  type SkipReason,
  type UnavailableReason,
} from "./reading.ts";
export type { TreeFacts } from "./resolve.ts";
